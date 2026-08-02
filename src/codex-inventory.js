import { execFile as execFileCb, spawn as spawnCb } from "node:child_process";
import { join } from "node:path";
import { homedir } from "node:os";
import { promisify } from "node:util";
import { readdirSafe, readJson } from "./fs-util.js";

const execFileDefault = promisify(execFileCb);

async function jsonCommand(execFile, args) {
  try {
    const { stdout } = await execFile("codex", args, { timeout: 10_000, maxBuffer: 4 * 1024 * 1024 });
    return JSON.parse(stdout);
  } catch { return null; }
}

async function agentNames(root) {
  return (await readdirSafe(root)).filter(name => name.endsWith(".toml")).map(name => name.slice(0, -5));
}

function appServerClient({ cwd, spawn = spawnCb, codexBin = "codex" }) {
  const child = spawn(codexBin, ["app-server", "--stdio"], {
    cwd, stdio: ["pipe", "pipe", "pipe"],
  });
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  let stdout = "", stderr = "", nextId = 1, closed = false;
  const pending = new Map();
  const rejectAll = (error) => {
    for (const { reject, timer } of pending.values()) {
      clearTimeout(timer);
      reject(error);
    }
    pending.clear();
  };
  child.stdout.on("data", chunk => {
    stdout += chunk;
    if (stdout.length > 16 * 1024 * 1024) {
      child.kill();
      rejectAll(new Error("Codex app-server response exceeded 16 MiB"));
      return;
    }
    for (;;) {
      const newline = stdout.indexOf("\n");
      if (newline < 0) break;
      const line = stdout.slice(0, newline).trim();
      stdout = stdout.slice(newline + 1);
      if (!line) continue;
      let message;
      try { message = JSON.parse(line); }
      catch { continue; }
      const waiter = pending.get(message.id);
      if (!waiter) continue;
      pending.delete(message.id);
      clearTimeout(waiter.timer);
      if (message.error) waiter.reject(new Error(message.error.message || JSON.stringify(message.error)));
      else waiter.resolve(message.result);
    }
  });
  child.stderr.on("data", chunk => { if (stderr.length < 16_384) stderr += chunk; });
  child.stdin.on("error", rejectAll);
  child.on("error", rejectAll);
  child.on("exit", code => {
    closed = true;
    if (pending.size) rejectAll(new Error(`Codex app-server exited ${code}${stderr ? `: ${stderr.trim()}` : ""}`));
  });
  return {
    request(method, params) {
      if (closed) return Promise.reject(new Error("Codex app-server is not running"));
      const id = nextId++;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`${method} timed out`));
        }, 15_000);
        pending.set(id, { resolve, reject, timer });
        child.stdin.write(JSON.stringify({ id, method, params }) + "\n");
      });
    },
    notify(method) {
      if (!closed) child.stdin.write(JSON.stringify({ method }) + "\n");
    },
    close() { if (!closed) child.kill(); },
  };
}

function enabledPlugins(pluginList) {
  return (pluginList?.marketplaces || []).flatMap(marketplace =>
    (marketplace?.plugins || [])
      .filter(plugin => plugin?.installed === true && plugin?.enabled === true
        && (plugin.availability === undefined || plugin.availability === "AVAILABLE"))
      .map(plugin => ({
        name: plugin.name || plugin.id?.split("@")[0],
        marketplaceName: marketplace.name,
        remotePluginId: plugin.remotePluginId,
        sourcePath: plugin.source?.type === "local" ? plugin.source.path : null,
      })))
    .filter(plugin => plugin.name);
}

// Codex app-server owns the effective, authenticated runtime inventory. Muster
// consumes that API and never reconstructs skill visibility by walking plugin
// caches, which may contain disabled or stale copies.
export async function readCodexRuntimeInventory({ cwd = process.cwd(), spawn = spawnCb, codexBin = "codex" } = {}) {
  const client = appServerClient({ cwd, spawn, codexBin });
  const errors = [];
  try {
    await client.request("initialize", {
      clientInfo: { name: "muster", version: "0" },
      capabilities: { experimentalApi: true },
    });
    client.notify("initialized");
    const [skillsResult, pluginResult] = await Promise.all([
      client.request("skills/list", { cwds: [cwd], forceReload: false }),
      client.request("plugin/list", { cwds: [cwd], forceRefetch: false }),
    ]);
    if (!Array.isArray(pluginResult?.marketplaces) || !Array.isArray(pluginResult?.marketplaceLoadErrors)) {
      throw new Error("plugin/list returned an invalid response");
    }
    if (!Array.isArray(skillsResult?.data)) throw new Error("skills/list returned an invalid response");
    const plugins = enabledPlugins(pluginResult);
    const renderError = error => typeof error === "string" ? error : JSON.stringify(error);
    for (const error of pluginResult.marketplaceLoadErrors) errors.push(`plugin/list: ${renderError(error)}`);
    const rows = skillsResult.data.find(row => row?.cwd === cwd);
    if (!rows || !Array.isArray(rows.skills) || !Array.isArray(rows.errors)) {
      throw new Error("skills/list omitted the requested working directory");
    }
    for (const error of rows.errors) errors.push(`skills/list: ${renderError(error)}`);
    const skills = (rows?.skills || [])
      .filter(skill => skill?.enabled === true && typeof skill.name === "string")
      .map(skill => ({ id: skill.name, description: skill.description || "" }));

    const remotes = plugins.filter(plugin => plugin.remotePluginId);
    const details = await Promise.all(remotes.map(async plugin => {
      try {
        const result = await client.request("plugin/read", {
          pluginName: plugin.remotePluginId,
          marketplacePath: null,
          remoteMarketplaceName: plugin.marketplaceName,
        });
        return { plugin, result };
      } catch (error) {
        errors.push(`plugin/read ${plugin.name}: ${error.message}`);
        return null;
      }
    }));
    for (const detail of details) {
      if (!detail) continue;
      if (!Array.isArray(detail.result?.plugin?.skills)) {
        errors.push(`plugin/read ${detail.plugin.name}: invalid response`);
        continue;
      }
      for (const skill of detail.result.plugin.skills) {
        if (skill?.enabled !== true || typeof skill.name !== "string") continue;
        skills.push({ id: `${detail.plugin.name}:${skill.name}`, description: skill.description || "" });
      }
    }
    const unique = new Map(skills.map(skill => [skill.id, skill]));
    return { plugins, skills: [...unique.values()], complete: errors.length === 0, errors };
  } catch (error) {
    return { plugins: [], skills: [], complete: false, errors: [error.message] };
  } finally {
    client.close();
  }
}

function mcpNames(result) {
  if (Array.isArray(result)) return result
    .filter(record => typeof record === "string" || (record && typeof record === "object" && record.enabled === true))
    .map(record => typeof record === "string" ? record : (record.name || record.server_name))
    .filter(Boolean);
  if (!result || typeof result !== "object") return [];
  const servers = result.mcpServers || result.mcp_servers || result.servers || result;
  return Object.entries(servers)
    .filter(([, config]) => !config || typeof config !== "object" || config.enabled !== false)
    .map(([name]) => name);
}

// Skills/plugins come from Codex's native app-server authority; the separate
// CLI query remains only for Codex's MCP inventory.
export async function readCodexInventory({ cwd = process.cwd(), codexHome = process.env.CODEX_HOME || join(homedir(), ".codex"), execFile = execFileDefault, runtimeInventory = readCodexRuntimeInventory } = {}) {
  const [runtime, mcpJson] = await Promise.all([
    runtimeInventory({ cwd }),
    jsonCommand(execFile, ["mcp", "list", "--json"]),
  ]);
  const pluginAgents = [];
  for (const plugin of runtime.plugins || []) {
    if (plugin.sourcePath) pluginAgents.push(...await agentNames(join(plugin.sourcePath, "agents")));
  }
  const [projectAgents, userAgents] = await Promise.all([
    agentNames(join(cwd, ".codex", "agents")), agentNames(join(codexHome, "agents")),
  ]);
  const skills = runtime.skills || [];
  return {
    plugins: [...new Set((runtime.plugins || []).map(plugin => plugin.name))],
    skills: [...new Set(skills.map(skill => skill.id))],
    skillDescriptions: Object.fromEntries(skills.map(skill => [skill.id, skill.description || ""])),
    skillInventory: { source: "codex-app-server", complete: runtime.complete === true, errors: runtime.errors || [] },
    mcpServers: [...new Set(mcpNames(mcpJson))],
    agents: [...new Set([...pluginAgents, ...projectAgents, ...userAgents])]
  };
}

export async function codexAvailable({ execFile = execFileDefault } = {}) {
  try { await execFile("codex", ["--version"], { timeout: 5_000 }); return true; }
  catch { return false; }
}

// --- Model catalog: which subagent API version a model speaks ----------------
//
// Codex resolves v1-vs-v2 from the model catalog's per-model
// `multi_agent_version` (docs/research/codex-cli.md sec 10.1). The catalog is a
// CACHE Codex refreshes on its own schedule, so this is a best-effort read: a
// missing file, a missing model, or a missing field all return null and the
// caller falls back (resolveCodexMultiAgentVersion defaults to v1, never v2).
export async function readCodexMultiAgentVersion(model, { home = homedir(), dir } = {}) {
  if (typeof model !== "string" || !model) return null;
  const root = dir || process.env.CODEX_HOME || join(home, ".codex");
  const catalog = await readJson(join(root, "models_cache.json"));
  const models = Array.isArray(catalog?.models) ? catalog.models : [];
  const entry = models.find(m => m?.slug === model || m?.id === model);
  const version = entry?.multi_agent_version;
  return version === "v1" || version === "v2" ? version : null;
}
