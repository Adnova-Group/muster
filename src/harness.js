import { readFile } from "node:fs/promises";
import { join } from "node:path";

async function readJson(p) { try { return JSON.parse(await readFile(p, "utf8")); } catch { return null; } }

function pluginName(key) { return key.split("@")[0]; }

export async function readInstalled(home) {
  const plugins = [];
  const pj = await readJson(join(home, ".claude/plugins/installed_plugins.json"));
  if (pj && pj.plugins) for (const key of Object.keys(pj.plugins)) plugins.push(pluginName(key));

  const mcpServers = [];
  const settings = await readJson(join(home, ".claude/settings.json"));
  if (settings && settings.mcpServers) mcpServers.push(...Object.keys(settings.mcpServers));

  const skills = [];

  return {
    plugins: [...new Set(plugins)],
    skills: [...new Set(skills)],
    mcpServers: [...new Set(mcpServers)]
  };
}
