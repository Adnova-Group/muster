import { execFile as execFileCb } from "node:child_process";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { promisify } from "node:util";
import { readdirSafe } from "./fs-util.js";

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
export async function readCodexInventory({ cwd = process.cwd(), codexHome = process.env.CODEX_HOME || join(homedir(), ".codex"), execFile = execFileDefault } = {}) {
  const [pluginsJson, mcpJson] = await Promise.all([
    jsonCommand(execFile, ["plugin", "list", "--available", "--json"]),
    jsonCommand(execFile, ["mcp", "list", "--json"])
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
    skills: [...new Set([...pluginSkills, ...projectSkills, ...userSkills])],
    mcpServers: [...new Set(mcpNames(mcpJson))],
    agents: [...new Set([...pluginAgents, ...projectAgents, ...userAgents])]
  };
}

export async function codexAvailable({ execFile = execFileDefault } = {}) {
  try { await execFile("codex", ["--version"], { timeout: 5_000 }); return true; }
  catch { return false; }
}
