import { join } from "node:path";
import { readJson, readdirSafe } from "./fs-util.js";

// installed_plugins.json keys are "name@marketplace".
function pluginName(key) { return key.split("@")[0]; }

// MCP server names declared by the plugin rooted at `root`. Two on-disk
// formats exist for <root>/.mcp.json: wrapped ({"mcpServers": {name: cfg}},
// e.g. figma) and a bare map ({name: cfg}, e.g. serena, playwright). A
// plugin.json `mcpServers` field counts only when it is an inline object —
// the string path form is ignored, not chased.
async function serversFromPluginRoot(root) {
  const names = [];
  const mcp = await readJson(join(root, ".mcp.json"));
  if (mcp && typeof mcp === "object" && !Array.isArray(mcp)) {
    const wrapped = mcp.mcpServers && typeof mcp.mcpServers === "object" && !Array.isArray(mcp.mcpServers);
    const map = wrapped ? mcp.mcpServers : mcp;
    for (const [name, cfg] of Object.entries(map)) {
      if (cfg && typeof cfg === "object" && !Array.isArray(cfg)) names.push(name);
    }
  }
  const pj = await readJson(join(root, ".claude-plugin/plugin.json"));
  if (pj && pj.mcpServers && typeof pj.mcpServers === "object" && !Array.isArray(pj.mcpServers)) {
    names.push(...Object.keys(pj.mcpServers));
  }
  return names;
}

// Agent names (sans .md) from <root>/agents/.
async function agentsFromPluginRoot(root) {
  return (await readdirSafe(join(root, "agents")))
    .filter((f) => f.endsWith(".md"))
    .map((f) => f.slice(0, -3));
}

// Skill names from <root>/skills/<name>/SKILL.md — the directory name is the
// skill name.
async function skillsFromPluginRoot(root) {
  const found = [];
  const skillsDir = join(root, "skills");
  for (const name of await readdirSafe(skillsDir)) {
    if ((await readdirSafe(join(skillsDir, name))).includes("SKILL.md")) found.push(name);
  }
  return found;
}

// Fallback for installs that record no installPath (v1 index shape) or no
// installed_plugins.json at all: depth-limited walk of ~/.claude/plugins,
// covering both the shallow plugins/<plugin>/ layout and the deep
// plugins/cache/<marketplace>/<plugin>/<version>/ layout. The top-level
// marketplaces/ entry is never walked — it holds every plugin a marketplace
// OFFERS, not what is installed. Any dir containing .mcp.json or
// .claude-plugin/ is treated as a plugin root for server collection.
// readdirSafe returns [] for files, so leaf entries terminate naturally.
async function walkFallback(base, maxDepth, out) {
  async function walk(dir, depth, atBase) {
    if (depth > maxDepth) return;
    const entries = await readdirSafe(dir);
    if (entries.includes(".mcp.json") || entries.includes(".claude-plugin")) {
      out.mcpServers.push(...await serversFromPluginRoot(dir));
    }
    for (const entry of entries) {
      if (atBase && entry === "marketplaces") continue;
      if (entry === "agents") { out.agents.push(...await agentsFromPluginRoot(dir)); continue; }
      if (entry === "skills") { out.skills.push(...await skillsFromPluginRoot(dir)); continue; }
      await walk(join(dir, entry), depth + 1, false);
    }
  }
  await walk(base, 0, true);
}

// Inventory of installed Claude Code plugins under <home>/.claude/plugins:
// plugin names plus the agents, skills, and MCP servers those plugins ship.
// Driven by installed_plugins.json v2 installPath records so only
// actually-installed plugins are reported (the cache also holds stale
// versions, and marketplaces/ holds offered-not-installed plugins).
// Fail-soft throughout: any missing or unreadable file/dir contributes
// nothing; never throws.
export async function readPluginInventory(home) {
  const base = join(home, ".claude/plugins");
  const plugins = [], skills = [], agents = [], mcpServers = [];

  const index = await readJson(join(base, "installed_plugins.json"));
  const hasIndex = !!(index && index.plugins && typeof index.plugins === "object" && !Array.isArray(index.plugins));
  const keys = hasIndex ? Object.keys(index.plugins) : [];
  const roots = [];
  for (const key of keys) {
    plugins.push(pluginName(key));
    for (const rec of Array.isArray(index.plugins[key]) ? index.plugins[key] : []) {
      if (rec && typeof rec.installPath === "string") roots.push(rec.installPath);
    }
  }

  if (roots.length) {
    // Primary path: at least one installPath is known. Documented all-or-nothing —
    // a mixed index (some records with installPath, some without) takes this path
    // only; pathless siblings' names are still reported but their contents (agents/
    // skills/mcpServers) are not scanned (accepted limitation, pinned by test).
    for (const root of roots) {
      agents.push(...await agentsFromPluginRoot(root));
      skills.push(...await skillsFromPluginRoot(root));
      mcpServers.push(...await serversFromPluginRoot(root));
    }
  } else if (!hasIndex || keys.length) {
    // No index at all, or a v1-shaped index (keys but no installPath anywhere):
    // best-effort walk. An index with ZERO keys skips this — it affirmatively
    // says nothing is installed, and walking would resurrect stale cache dirs.
    await walkFallback(base, 4, { agents, skills, mcpServers });
  }

  return {
    plugins: [...new Set(plugins)],
    skills: [...new Set(skills)],
    agents: [...new Set(agents)],
    mcpServers: [...new Set(mcpServers)]
  };
}
