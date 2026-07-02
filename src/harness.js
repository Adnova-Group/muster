import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { readJson } from "./fs-util.js";

function pluginName(key) { return key.split("@")[0]; }

async function readdirSafe(p) { try { return await readdir(p); } catch { return []; } }

// Depth-limited walk shared by collectPluginAgents and collectPluginSkills.
// When a directory named `dirName` is found at any depth, `collect` is called
// with the full path to that directory. The walk recurses into siblings but not
// into the matched directory itself (the per-leaf callback owns that traversal).
// readdirSafe returns [] for files, so leaf entries terminate the recursion naturally.
async function walkForSubdir(base, maxDepth, dirName, collect) {
  async function walk(dir, depth) {
    if (depth > maxDepth) return;
    for (const entry of await readdirSafe(dir)) {
      if (entry === dirName) {
        await collect(join(dir, dirName));
        continue;
      }
      await walk(join(dir, entry), depth + 1);
    }
  }
  await walk(base, 0);
}

// Collect agent names (sans .md) from any agents/ dir found within `pluginsBase`.
// Walks up to `maxDepth` directory levels, since installed plugins live at
// varying depths (~/.claude/plugins/<plugin>/agents/ and the cache layout
// ~/.claude/plugins/cache/<marketplace>/<plugin>/agents/). Every dir read is
// tolerant — a missing or unreadable dir is simply skipped.
async function collectPluginAgents(pluginsBase, maxDepth = 4) {
  const found = [];
  await walkForSubdir(pluginsBase, maxDepth, "agents", async (agentsDir) => {
    for (const f of await readdirSafe(agentsDir)) {
      if (f.endsWith(".md")) found.push(f.slice(0, -3));
    }
  });
  return found;
}

// Collect skill names from any skills/ dir found within `pluginsBase`.
// Skills live as directories: skills/<name>/SKILL.md — the directory name is
// the skill name. Walks up to `maxDepth` levels, tolerating missing dirs.
async function collectPluginSkills(pluginsBase, maxDepth = 4) {
  const found = [];
  await walkForSubdir(pluginsBase, maxDepth, "skills", async (skillsDir) => {
    for (const name of await readdirSafe(skillsDir)) {
      const entries = await readdirSafe(join(skillsDir, name));
      if (entries.includes("SKILL.md")) found.push(name);
    }
  });
  return found;
}

// --- Claude Cowork adapter ----------------------------------------------------
// Cowork extends only through MCP: local MCP servers (claude_desktop_config.json),
// MCPB/DXT desktop extensions (a Claude Extensions/ dir, no index file), and remote
// connectors (cloud/account state, NOT on disk). See memory cowork-connector-storage.

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
// resolveCapabilities consumes, but only the mcpServers lane is populated (Cowork has
// no Claude Code plugins/skills/agents). Local servers + extensions are discovered;
// remote connectors cannot be (connectorsDiscoverable:false) and must be DECLARED.
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

  return {
    plugins: [],
    skills: [],
    agents: [],
    mcpServers: [...new Set([...discovered, ...declaredConnectors])],
    connectorsDiscoverable: false,
    connectorsDeclared: [...new Set(declaredConnectors)],
  };
}

export async function readInstalled(home) {
  const plugins = [];
  const pj = await readJson(join(home, ".claude/plugins/installed_plugins.json"));
  if (pj && pj.plugins) for (const key of Object.keys(pj.plugins)) plugins.push(pluginName(key));

  const mcpServers = [];
  const settings = await readJson(join(home, ".claude/settings.json"));
  if (settings && settings.mcpServers) mcpServers.push(...Object.keys(settings.mcpServers));

  const skills = [];
  try {
    for (const name of await readdir(join(home, ".claude/skills"))) {
      const entries = await readdirSafe(join(home, ".claude/skills", name));
      if (entries.includes("SKILL.md")) skills.push(name);
    }
  } catch { /* dir may not exist */ }

  // Also merge skills shipped by installed plugins, scanning the same plugin
  // directory tree used for agents (both shallow and deep cache layouts).
  for (const name of await collectPluginSkills(join(home, ".claude/plugins"))) skills.push(name);

  const agents = [];
  try {
    const files = await readdir(join(home, ".claude/agents"));
    for (const f of files) if (f.endsWith(".md")) agents.push(f.slice(0, -3));
  } catch { /* dir may not exist */ }

  // Also merge agents shipped by installed plugins. installed_plugins.json keys
  // are "name@source" and record NO filesystem path per plugin, so the plugin
  // dir is not derivable from that file. Best-effort: scan the conventional
  // plugin layouts under ~/.claude/plugins/ for agents/*.md, tolerating any
  // missing dir. Covers both ~/.claude/plugins/<plugin>/agents/ and the deeper
  // cache layout ~/.claude/plugins/cache/<marketplace>/<plugin>/agents/.
  // Note: ~/.claude/.atomic/ is never touched.
  for (const name of await collectPluginAgents(join(home, ".claude/plugins"))) agents.push(name);

  return {
    plugins: [...new Set(plugins)],
    skills: [...new Set(skills)],
    mcpServers: [...new Set(mcpServers)],
    agents: [...new Set(agents)]
  };
}
