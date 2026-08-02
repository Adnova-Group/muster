import { execFile as execFileCb } from "node:child_process";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { promisify } from "node:util";
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

async function agentNames(root) {
  return (await readdirSafe(root)).filter(name => name.endsWith(".toml")).map(name => name.slice(0, -5));
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
export async function readCodexInventory({ cwd = process.cwd(), codexHome = process.env.CODEX_HOME || join(homedir(), ".codex"), execFile = execFileDefault, runtimeIdentity, env = process.env, allowInjected = false, includePluginSources = false } = {}) {
  let identity = runtimeIdentity;
  if (!identity && !allowInjected) try { identity = resolveCodexRuntimeIdentity({ env }); } catch { /* unavailable is an empty live inventory, never a PATH probe */ }
  const [pluginsJson, mcpJson] = await Promise.all([
    jsonCommand(execFile, ["plugin", "list", "--available", "--json"], identity, allowInjected),
    jsonCommand(execFile, ["mcp", "list", "--json"], identity, allowInjected)
  ]);
  const active = installedPlugins(pluginsJson);
  const pluginSkills = [], pluginAgents = [];
  for (const plugin of active) {
    if (!plugin.source?.path) continue;
    pluginSkills.push(...await skillNames(join(plugin.source.path, "skills")));
    pluginAgents.push(...await agentNames(join(plugin.source.path, "agents")));
  }
  const [projectSkills, userSkills, projectAgents, userAgents] = await Promise.all([
    skillNames(join(cwd, ".codex", "skills")), skillNames(join(codexHome, "skills")),
    agentNames(join(cwd, ".codex", "agents")), agentNames(join(codexHome, "agents"))
  ]);
  return {
    plugins: active.map(plugin => plugin.name || plugin.pluginId.split("@")[0]),
    ...(includePluginSources ? { pluginSources: active.map(plugin => ({
      name: plugin.name || plugin.pluginId.split("@")[0],
      path: plugin.source?.path,
      version: plugin.version
    })) } : {}),
    skills: [...new Set([...pluginSkills, ...projectSkills, ...userSkills])],
    mcpServers: [...new Set(mcpNames(mcpJson))],
    agents: [...new Set([...pluginAgents, ...projectAgents, ...userAgents])]
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
