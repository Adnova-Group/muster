import { execFile as execFileCb } from "node:child_process";
import { readdir, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { promisify } from "node:util";
import { parseAgentProfileToml } from "./codex-release.js";
import { assertContainedNoSymlinkPath, readNoFollowRegular } from "./fs-safe.js";
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
export async function readCodexInventory({ cwd = process.cwd(), codexHome = process.env.CODEX_HOME || join(homedir(), ".codex"), execFile = execFileDefault } = {}) {
  const [pluginsJson, mcpJson] = await Promise.all([
    jsonCommand(execFile, ["plugin", "list", "--available", "--json"]),
    jsonCommand(execFile, ["mcp", "list", "--json"])
  ]);
  const active = installedPlugins(pluginsJson);
  const pluginSkills = [], pluginAgentProfiles = [];
  for (const plugin of active) {
    if (!plugin.source?.path) continue;
    let pluginRoot;
    try { pluginRoot = await realpath(plugin.source.path); }
    catch { continue; }
    pluginSkills.push(...await skillNames(join(pluginRoot, "skills")));
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
    projectTrusted ? skillNames(join(projectConfigRoot, "skills")) : [],
    skillNames(join(codexHome, "skills")),
    projectTrusted ? registeredAgentProfiles(projectConfigRoot, "project", projectSections) : [],
    registeredAgentProfiles(codexHome, "user", userSections),
  ]);
  const agentProfiles = [...pluginAgentProfiles, ...userAgentProfiles, ...projectAgentProfiles];
  return {
    plugins: [...new Set(active.map(plugin => plugin.name || plugin.pluginId?.split("@")[0]).filter(Boolean))],
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
