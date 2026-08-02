import { execFile as execFileCb, spawn as spawnCb } from "node:child_process";
import { readdir, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { promisify } from "node:util";
import { parseAgentProfileToml } from "./codex-release.js";
import { assertContainedNoSymlinkPath, readNoFollowRegular } from "./fs-safe.js";
import { readdirSafe, readJson } from "./fs-util.js";
import { runCodexCommand } from "./codex-runtime-identity.js";
import { resolveCodexRuntimeIdentity } from "./codex-runtime-identity.js";

const execFileDefault = promisify(execFileCb);
const INJECTED_CODEX_RUNNER = "muster:injected-codex-runner";

// Expected contents of one generated Codex bundle. This census belongs with
// inventory/build validation; model adapters only translate tiers to models.
export const CODEX_COUNTS = Object.freeze({
  agents: 27,
  // improver-fork item: plugin/skills/improve (a new `context: fork` skill, Claude-only
  // frontmatter key stripped by build-codex.mjs's codexSkill()) is a genuinely new native
  // skill dir, ported into internal-skills like any other -- 11 -> 12.
  nativeSkills: 12,
  builtinSkills: 51,
  publicSkills: 14,
  // 62 -> 63: nativeSkills (12) + builtinSkills (51).
  internalSkills: 63,
  pipelines: 20,
  mcpTools: 31,
  primaryModes: 10,
  aliases: 3
});

async function jsonCommand(execFile, args, runtimeIdentity, allowInjected) {
  try {
    const result = runtimeIdentity
      ? await runCodexCommand(execFile, runtimeIdentity, args, { timeout: 10_000, maxBuffer: 4 * 1024 * 1024 })
      : allowInjected ? await execFile(INJECTED_CODEX_RUNNER, args, { timeout: 10_000, maxBuffer: 4 * 1024 * 1024 }) : null;
    return result ? JSON.parse(result.stdout) : null;
  } catch { return null; }
}

function appServerClient({ cwd, spawn = spawnCb, runtimeIdentity }) {
  const child = spawn(runtimeIdentity.node, [runtimeIdentity.codex, "app-server", "--stdio"], {
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
      try { message = JSON.parse(line); } catch { continue; }
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
      return new Promise((resolveRequest, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`${method} timed out`));
        }, 15_000);
        pending.set(id, { resolve: resolveRequest, reject, timer });
        child.stdin.write(JSON.stringify({ id, method, params }) + "\n");
      });
    },
    notify(method) { if (!closed) child.stdin.write(JSON.stringify({ method }) + "\n"); },
    close() { if (!closed) child.kill(); },
  };
}

function enabledRuntimePlugins(pluginList) {
  return (pluginList?.marketplaces || []).flatMap(marketplace =>
    (marketplace?.plugins || [])
      .filter(plugin => plugin?.installed === true && plugin?.enabled === true
        && (plugin.availability === undefined || plugin.availability === "AVAILABLE"))
      .map(plugin => ({
        name: plugin.name || plugin.id?.split("@")[0],
        marketplaceName: marketplace.name,
        remotePluginId: plugin.remotePluginId,
        sourcePath: plugin.source?.type === "local" ? plugin.source.path : null,
        version: plugin.version,
      })))
    .filter(plugin => plugin.name);
}

// Codex App Server owns the effective skill/plugin inventory. Cache walks and
// legacy CLI projections can include disabled or stale plugin generations.
export async function readCodexRuntimeInventory({
  cwd = process.cwd(), spawn = spawnCb, runtimeIdentity, env = process.env,
} = {}) {
  const errors = [];
  let identity = runtimeIdentity;
  try {
    identity ||= resolveCodexRuntimeIdentity({ env });
  } catch (error) {
    return { plugins: [], skills: [], complete: false, errors: [error.message] };
  }
  const client = appServerClient({ cwd, spawn, runtimeIdentity: identity });
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
    const plugins = enabledRuntimePlugins(pluginResult);
    const renderError = error => typeof error === "string" ? error : JSON.stringify(error);
    for (const error of pluginResult.marketplaceLoadErrors) errors.push(`plugin/list: ${renderError(error)}`);
    const rows = skillsResult.data.find(row => row?.cwd === cwd);
    if (!rows || !Array.isArray(rows.skills) || !Array.isArray(rows.errors)) {
      throw new Error("skills/list omitted the requested working directory");
    }
    for (const error of rows.errors) errors.push(`skills/list: ${renderError(error)}`);
    const skills = rows.skills
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
        if (skill?.enabled === true && typeof skill.name === "string") {
          skills.push({ id: `${detail.plugin.name}:${skill.name}`, description: skill.description || "" });
        }
      }
    }
    return { plugins, skills: [...new Map(skills.map(skill => [skill.id, skill])).values()],
      complete: errors.length === 0, errors };
  } catch (error) {
    return { plugins: [], skills: [], complete: false, errors: [error.message] };
  } finally {
    client.close();
  }
}

function records(result) {
  if (Array.isArray(result)) return result;
  return result && typeof result === "object" ? [...(result.installed || []), ...(result.available || [])] : [];
}

function installedPlugins(result) {
  const identities = new Set();
  return records(result).filter(plugin => {
    if (!plugin || typeof plugin !== "object" || plugin.installed !== true || plugin.enabled !== true) return false;
    const name = plugin.pluginId || plugin.name;
    const identity = `${name || ""}\0${plugin.source?.path || ""}`;
    if (!name || identities.has(identity)) return false;
    identities.add(identity);
    return true;
  });
}

async function skillNames(root) {
  const names = [];
  for (const name of await readdirSafe(root)) {
    try { if ((await readdir(join(root, name))).includes("SKILL.md")) names.push(name); }
    catch { /* non-directory or unreadable */ }
  }
  return names;
}

function tomlString(raw) {
  if (typeof raw !== "string") return null;
  if (raw.startsWith("'")) return raw.slice(1, -1);
  if (raw.startsWith('"')) {
    try { return JSON.parse(raw); } catch { return null; }
  }
  return null;
}

function unambiguousTopLevelName(text) {
  const values = [];
  for (const line of String(text).split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    if (trimmed.startsWith("[") || trimmed.includes('"""') || trimmed.includes("'''")) break;
    const assignment = line.match(/^\s*name\s*=\s*("(?:[^"\\]|\\.)*"|'[^']*')\s*(?:#.*)?$/);
    if (assignment) values.push(tomlString(assignment[1]));
  }
  return values.length === 1 && values[0] ? values[0] : null;
}

async function agentProfileRecords(root, scope, plugin = null) {
  const records = [];
  for (const filename of (await readdirSafe(root)).filter(name => name.endsWith(".toml")).sort()) {
    const path = join(root, filename);
    const fallbackName = filename.slice(0, -5);
    try {
      const { bytes } = await readNoFollowRegular(path, {
        maxBytes: 1_048_576,
        label: `Codex agent profile ${path}`,
      });
      const text = bytes.toString("utf8");
      let parsed;
      try { parsed = parseAgentProfileToml(text); }
      catch {
        records.push({
          name: unambiguousTopLevelName(text) || fallbackName,
          model: null,
          status: "unresolved",
          scope,
          path,
          ...(plugin ? { plugin } : {}),
        });
        continue;
      }
      const name = tomlString(parsed.name);
      const model = tomlString(parsed.model);
      records.push({
        name: name || fallbackName,
        model,
        status: name && model ? "resolved" : "unresolved",
        scope,
        path,
        ...(plugin ? { plugin } : {}),
      });
    } catch {
      records.push({ name: fallbackName, model: null, status: "unresolved", scope, path, ...(plugin ? { plugin } : {}) });
    }
  }
  return records;
}

const AGENT_HEADER = /^\s*\[agents\.("(?:[^"\\]|\\.)*"|'[^']*'|[A-Za-z0-9_-]+)\]\s*(?:#.*)?$/;
const PROJECT_HEADER = /^\s*\[projects\.("(?:[^"\\]|\\.)*"|'[^']*')\]\s*(?:#.*)?$/;

function headerKey(raw) {
  return raw.startsWith('"') || raw.startsWith("'") ? tomlString(raw) : raw;
}

function configSections(text) {
  const agents = new Map(), projects = new Map();
  let current = null;
  for (const line of String(text).split(/\r?\n/)) {
    const agent = line.match(AGENT_HEADER), project = line.match(PROJECT_HEADER);
    if (agent || project) {
      const kind = agent ? "agent" : "project";
      const key = headerKey((agent || project)[1]);
      const target = agent ? agents : projects;
      current = key ? { kind, key, values: {} } : null;
      if (current) {
        if (target.has(key)) { target.set(key, null); current = null; }
        else target.set(key, current.values);
      }
      continue;
    }
    if (/^\s*\[/.test(line)) { current = null; continue; }
    if (!current) continue;
    const assignment = line.match(/^\s*(config_file|trust_level)\s*=\s*("(?:[^"\\]|\\.)*"|'[^']*')\s*(?:#.*)?$/);
    if (!assignment) continue;
    if (Object.hasOwn(current.values, assignment[1])) current.values[assignment[1]] = null;
    else current.values[assignment[1]] = tomlString(assignment[2]);
  }
  return { agents, projects };
}

async function configText(path) {
  try {
    return (await readNoFollowRegular(path, {
      maxBytes: 8 * 1024 * 1024,
      label: `Codex config ${path}`,
    })).bytes.toString("utf8");
  } catch { return ""; }
}

async function registeredAgentProfiles(configRoot, scope, sections) {
  const records = [];
  for (const [name, values] of sections.agents) {
    const configured = values?.config_file;
    if (typeof configured !== "string" || !configured) {
      records.push({ name, model: null, status: "unresolved", scope, path: null });
      continue;
    }
    const path = resolve(configRoot, configured);
    try {
      await assertContainedNoSymlinkPath(configRoot, path);
      const { bytes } = await readNoFollowRegular(path, {
        maxBytes: 1_048_576,
        label: `Codex agent profile ${path}`,
      });
      let parsed;
      try { parsed = parseAgentProfileToml(bytes.toString("utf8")); }
      catch {
        records.push({ name, model: null, status: "unresolved", scope, path });
        continue;
      }
      const declaredName = tomlString(parsed.name), model = tomlString(parsed.model);
      records.push({
        name,
        model,
        status: declaredName === name && model ? "resolved" : "unresolved",
        scope,
        path,
      });
    } catch {
      records.push({ name, model: null, status: "unresolved", scope, path });
    }
  }
  return records;
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

// Codex's live CLI output is authoritative. Never walk its plugin cache: it
// can contain stale or disabled copies that Codex is not currently using.
export async function readCodexInventory({
  cwd = process.cwd(), codexHome = process.env.CODEX_HOME || join(homedir(), ".codex"),
  execFile = execFileDefault, runtimeIdentity, runtimeInventory, env = process.env,
  allowInjected = false, includePluginSources = false,
} = {}) {
  let identity = runtimeIdentity;
  if (!identity && !allowInjected) try { identity = resolveCodexRuntimeIdentity({ env }); } catch { /* unavailable is an empty live inventory, never a PATH probe */ }
  const runtimeReader = runtimeInventory || (!allowInjected ? readCodexRuntimeInventory : null);
  const [runtime, pluginsJson, mcpJson] = await Promise.all([
    runtimeReader ? runtimeReader({ cwd, runtimeIdentity: identity, env }) : null,
    !runtimeReader ? jsonCommand(execFile, ["plugin", "list", "--available", "--json"], identity, allowInjected) : null,
    jsonCommand(execFile, ["mcp", "list", "--json"], identity, allowInjected)
  ]);
  const active = runtimeReader
    ? (runtime?.plugins || []).map(plugin => ({
        name: plugin.name,
        pluginId: plugin.name,
        version: plugin.version,
        source: plugin.sourcePath ? { path: plugin.sourcePath } : null,
      }))
    : installedPlugins(pluginsJson);
  const pluginSkills = [], pluginAgentProfiles = [];
  for (const plugin of active) {
    if (!plugin.source?.path) continue;
    let pluginRoot;
    try { pluginRoot = await realpath(plugin.source.path); }
    catch { continue; }
    if (!runtimeReader) pluginSkills.push(...await skillNames(join(pluginRoot, "skills")));
    pluginAgentProfiles.push(...await agentProfileRecords(
      join(pluginRoot, "agents"),
      "plugin",
      plugin.pluginId || plugin.name || null,
    ));
  }
  let canonicalCwd;
  try { canonicalCwd = await realpath(cwd); } catch { canonicalCwd = resolve(cwd); }
  const projectConfigRoot = join(canonicalCwd, ".codex");
  const userConfigText = await configText(join(codexHome, "config.toml"));
  const userSections = configSections(userConfigText);
  const projectTrusted = userSections.projects.get(canonicalCwd)?.trust_level === "trusted";
  const projectConfigText = projectTrusted ? await configText(join(projectConfigRoot, "config.toml")) : "";
  const projectSections = configSections(projectConfigText);
  const [projectSkills, userSkills, projectAgentProfiles, userAgentProfiles] = await Promise.all([
    !runtimeReader && projectTrusted ? skillNames(join(projectConfigRoot, "skills")) : [],
    !runtimeReader ? skillNames(join(codexHome, "skills")) : [],
    projectTrusted ? registeredAgentProfiles(projectConfigRoot, "project", projectSections) : [],
    registeredAgentProfiles(codexHome, "user", userSections),
  ]);
  const agentProfiles = [...pluginAgentProfiles, ...userAgentProfiles, ...projectAgentProfiles];
  const runtimeSkills = runtime?.skills || [];
  return {
    plugins: [...new Set(active.map(plugin => plugin.name || plugin.pluginId?.split("@")[0]).filter(Boolean))],
    ...(includePluginSources ? { pluginSources: active.map(plugin => ({
      name: plugin.name || plugin.pluginId.split("@")[0],
      path: plugin.source?.path,
      version: plugin.version
    })) } : {}),
    skills: runtimeReader
      ? [...new Set(runtimeSkills.map(skill => skill.id))]
      : [...new Set([...pluginSkills, ...projectSkills, ...userSkills])],
    skillDescriptions: Object.fromEntries(runtimeSkills.map(skill => [skill.id, skill.description || ""])),
    skillInventory: runtimeReader
      ? { source: "codex-app-server", complete: runtime?.complete === true, errors: runtime?.errors || [] }
      : { source: "injected-legacy-cli", complete: pluginsJson !== null, errors: pluginsJson === null ? ["plugin inventory unavailable"] : [] },
    mcpServers: [...new Set(mcpNames(mcpJson))],
    agents: [...new Set(agentProfiles.map(profile => profile.name))],
    agentProfiles,
  };
}

export async function codexAvailable({ execFile = execFileDefault, runtimeIdentity, env = process.env, allowInjected = false } = {}) {
  try {
    let identity = runtimeIdentity;
    if (!identity && !allowInjected) identity = resolveCodexRuntimeIdentity({ env });
    if (identity) await runCodexCommand(execFile, identity, ["--version"], { timeout: 5_000 });
    else if (allowInjected) await execFile(INJECTED_CODEX_RUNNER, ["--version"], { timeout: 5_000 });
    else return false;
    return true;
  }
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
