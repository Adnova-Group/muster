import { execFile as execFileCb } from "node:child_process";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { promisify } from "node:util";
import { parseAgentProfileToml } from "./codex-release.js";
import { readNoFollowRegular } from "./fs-safe.js";
import { readdirSafe, readJson } from "./fs-util.js";

const execFileDefault = promisify(execFileCb);

async function jsonCommand(execFile, args) {
  try {
    const { stdout } = await execFile("codex", args, { timeout: 10_000, maxBuffer: 4 * 1024 * 1024 });
    return JSON.parse(stdout);
  } catch { return null; }
}

function records(result) {
  if (Array.isArray(result)) return result;
  return result && typeof result === "object" ? [...(result.installed || []), ...(result.available || [])] : [];
}

function installedPlugins(result) {
  const names = new Set();
  return records(result).filter(plugin => {
    if (!plugin || typeof plugin !== "object" || plugin.installed !== true || plugin.enabled !== true) return false;
    const name = plugin.name || plugin.pluginId?.split("@")[0];
    if (!name || names.has(name)) return false;
    names.add(name);
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
export async function readCodexInventory({ cwd = process.cwd(), codexHome = process.env.CODEX_HOME || join(homedir(), ".codex"), execFile = execFileDefault } = {}) {
  const [pluginsJson, mcpJson] = await Promise.all([
    jsonCommand(execFile, ["plugin", "list", "--available", "--json"]),
    jsonCommand(execFile, ["mcp", "list", "--json"])
  ]);
  const active = installedPlugins(pluginsJson);
  const pluginSkills = [], pluginAgentProfiles = [];
  for (const plugin of active) {
    if (!plugin.source?.path) continue;
    pluginSkills.push(...await skillNames(join(plugin.source.path, "skills")));
    pluginAgentProfiles.push(...await agentProfileRecords(
      join(plugin.source.path, "agents"),
      "plugin",
      plugin.name || plugin.pluginId?.split("@")[0] || null,
    ));
  }
  const [projectSkills, userSkills, projectAgentProfiles, userAgentProfiles] = await Promise.all([
    skillNames(join(cwd, ".codex", "skills")), skillNames(join(codexHome, "skills")),
    agentProfileRecords(join(cwd, ".codex", "agents"), "project"),
    agentProfileRecords(join(codexHome, "agents"), "user"),
  ]);
  const agentProfiles = [...pluginAgentProfiles, ...userAgentProfiles, ...projectAgentProfiles];
  return {
    plugins: active.map(plugin => plugin.name || plugin.pluginId.split("@")[0]),
    skills: [...new Set([...pluginSkills, ...projectSkills, ...userSkills])],
    mcpServers: [...new Set(mcpNames(mcpJson))],
    agents: [...new Set(agentProfiles.map(profile => profile.name))],
    agentProfiles,
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
