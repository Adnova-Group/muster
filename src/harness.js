import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { readJson } from "./fs-util.js";

function pluginName(key) { return key.split("@")[0]; }

async function readdirSafe(p) { try { return await readdir(p); } catch { return []; } }

// Collect agent names (sans .md) from any agents/ dir found within `pluginsBase`.
// Walks up to `maxDepth` directory levels, since installed plugins live at
// varying depths (~/.claude/plugins/<plugin>/agents/ and the cache layout
// ~/.claude/plugins/cache/<marketplace>/<plugin>/agents/). Every dir read is
// tolerant — a missing or unreadable dir is simply skipped.
async function collectPluginAgents(pluginsBase, maxDepth = 4) {
  const found = [];
  async function walk(dir, depth) {
    if (depth > maxDepth) return;
    for (const entry of await readdirSafe(dir)) {
      if (entry === "agents") {
        for (const f of await readdirSafe(join(dir, "agents"))) {
          if (f.endsWith(".md")) found.push(f.slice(0, -3));
        }
        continue;
      }
      // Recurse; readdirSafe returns [] for files, so leaves terminate.
      await walk(join(dir, entry), depth + 1);
    }
  }
  await walk(pluginsBase, 0);
  return found;
}

export async function readInstalled(home) {
  const plugins = [];
  const pj = await readJson(join(home, ".claude/plugins/installed_plugins.json"));
  if (pj && pj.plugins) for (const key of Object.keys(pj.plugins)) plugins.push(pluginName(key));

  const mcpServers = [];
  const settings = await readJson(join(home, ".claude/settings.json"));
  if (settings && settings.mcpServers) mcpServers.push(...Object.keys(settings.mcpServers));

  const skills = [];

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
