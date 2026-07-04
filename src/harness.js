import { join } from "node:path";
import { readJson, readdirSafe } from "./fs-util.js";
import { readPluginInventory } from "./plugin-inventory.js";

// --- Claude Cowork adapter ----------------------------------------------------
// Cowork's own registry extends through MCP: local MCP servers
// (claude_desktop_config.json), MCPB/DXT desktop extensions (a Claude
// Extensions/ dir, no index file), and remote connectors (cloud/account state,
// NOT on disk — see memory cowork-connector-storage). Cowork sessions ALSO
// load Claude Code plugins from ~/.claude/plugins, so the plugin inventory
// (plugin-shipped MCP servers, agents, skills) merges into every lane.

// Ordered candidate Claude config dirs for a platform. On Windows the MSIX-virtualized
// path is the one the app actually reads, so it comes before the %APPDATA% fallback.
export async function coworkConfigDirs(home, platform = process.platform) {
  if (platform === "darwin") return [join(home, "Library/Application Support/Claude")];
  if (platform === "win32") {
    const dirs = [];
    const packages = join(home, "AppData/Local/Packages");
    for (const e of await readdirSafe(packages)) {
      if (e.startsWith("Claude_")) dirs.push(join(packages, e, "LocalCache/Roaming/Claude"));
    }
    dirs.push(join(home, "AppData/Roaming/Claude"));
    return dirs;
  }
  return [join(home, ".config/Claude")]; // linux (community builds) + fallback
}

// Read each Claude Extensions/<id>/manifest.json and return its declared name
// (falling back to the folder name). No central index file exists, so we enumerate.
async function readExtensionNames(extDir) {
  const names = [];
  for (const sub of await readdirSafe(extDir)) {
    const manifest = await readJson(join(extDir, sub, "manifest.json"));
    if (manifest) names.push(manifest.name || sub);
  }
  return names;
}

// Cowork-flavored readInstalled: same {plugins, skills, mcpServers, agents} shape
// resolveCapabilities consumes. Cowork registry discovery (local servers +
// extensions) fills mcpServers; the Claude Code plugin inventory fills every
// lane. Remote connectors cannot be discovered (connectorsDiscoverable:false)
// and must be DECLARED.
export async function readInstalledCowork(home, opts = {}) {
  const { platform = process.platform, declaredConnectors = [], dir } = opts;
  const dirs = dir ? [dir] : await coworkConfigDirs(home, platform);

  const discovered = [];
  for (const d of dirs) {
    const cfg = await readJson(join(d, "claude_desktop_config.json"));
    const extNames = await readExtensionNames(join(d, "Claude Extensions"));
    if ((cfg && cfg.mcpServers) || extNames.length) {
      if (cfg && cfg.mcpServers) discovered.push(...Object.keys(cfg.mcpServers));
      discovered.push(...extNames);
      break; // first dir with real content wins (the app's actual read path)
    }
  }

  const inv = await readPluginInventory(home);

  return {
    plugins: inv.plugins,
    skills: inv.skills,
    agents: inv.agents,
    mcpServers: [...new Set([...discovered, ...inv.mcpServers, ...declaredConnectors])],
    connectorsDiscoverable: false,
    connectorsDeclared: [...new Set(declaredConnectors)]
  };
}

export async function readInstalled(home) {
  // Installed Claude Code plugins: names + the agents/skills/MCP servers they
  // ship (installPath-driven, see plugin-inventory.js).
  const inv = await readPluginInventory(home);

  const mcpServers = [...inv.mcpServers];
  const settings = await readJson(join(home, ".claude/settings.json"));
  if (settings && settings.mcpServers) mcpServers.push(...Object.keys(settings.mcpServers));

  const skills = [...inv.skills];
  for (const name of await readdirSafe(join(home, ".claude/skills"))) {
    const entries = await readdirSafe(join(home, ".claude/skills", name));
    if (entries.includes("SKILL.md")) skills.push(name);
  }

  const agents = [...inv.agents];
  for (const f of await readdirSafe(join(home, ".claude/agents"))) {
    if (f.endsWith(".md")) agents.push(f.slice(0, -3));
  }

  return {
    plugins: inv.plugins,
    skills: [...new Set(skills)],
    mcpServers: [...new Set(mcpServers)],
    agents: [...new Set(agents)]
  };
}
