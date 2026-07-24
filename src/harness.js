import { join } from "node:path";
import { readJson, readdirSafe } from "./fs-util.js";
import { readPluginInventory } from "./plugin-inventory.js";
export { readCodexInventory } from "./codex-inventory.js";

// --- Claude Cowork adapter ----------------------------------------------------
// Cowork's own registry extends through MCP: local MCP servers
// (claude_desktop_config.json), MCPB/DXT desktop extensions (a Claude
// Extensions/ dir, no index file), and remote connectors (cloud/account state,
// NOT on disk — see memory cowork-connector-storage). Claude Code plugin files
// on disk are deliberately excluded: Cowork does not load their agents/skills,
// and a plugin-shipped MCP server is not callable until it is registered with
// Cowork itself.

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
// extensions) fills mcpServers. Remote connectors cannot be discovered
// (connectorsDiscoverable:false) and must be DECLARED.
//
// Native plugin ride (opts.nativePluginRide): ~May 2026 Cowork shipped a plugin
// system bundling skills, connectors, hooks, and sub-agents in the Claude Code
// plugin format (docs/research/claude-cowork.md section 3d) -- a different, later
// surface than the on-disk `~/.claude/plugins` registry `readInstalled` reads for
// the Claude Code adapter above, and NOT the same thing as the three legs this
// function already discovers (local MCP servers, MCPB extensions, declared
// connectors). Whether Cowork's loader actually accepted muster's plugin/ tree is
// UNVERIFIED: no live Cowork session is reachable from this repo's tooling, and
// Cowork exposes no on-disk or protocol signal an outside process (this CLI, or
// the MCP server that spawns it) can inspect to auto-detect a native load. That
// is the same "cannot be discovered, must be DECLARED" shape as remote
// connectors just above, so nativePluginRide is a declared boolean (threaded by
// the caller from MUSTER_COWORK_NATIVE_PLUGIN / a CLI flag -- see src/cli.js),
// never an auto-probe. resolveCapabilities (src/capabilities.js) reads it off
// the returned `nativePluginRide` field: false (the default) keeps today's
// MCP-only filtering; true lets muster's builtin skills/agents resolve exactly
// as they do on Claude Code, since a native load -- if it happened -- loaded
// this same checkout's plugin/ tree.
export async function readInstalledCowork(home, opts = {}) {
  const { platform = process.platform, declaredConnectors = [], dir, nativePluginRide = false } = opts;
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
    runtime: "cowork",
    plugins: [],
    skills: [],
    agents: [],
    mcpServers: [...new Set([...discovered, ...declaredConnectors])],
    connectorsDiscoverable: false,
    connectorsDeclared: [...new Set(declaredConnectors)],
    nativePluginRide: !!nativePluginRide
  };
}

// --- Kimi Code CLI adapter ----------------------------------------------------
// Kimi-flavored readInstalled: same {plugins, skills, mcpServers, agents} shape
// resolveCapabilities consumes, read from a gen2 Kimi Code data root
// (docs/research/kimi-code-cli.md sections 5+8). The root is KIMI_CODE_HOME, or
// ~/.kimi-code by default; opts.dir overrides it (tests / a probed install).
//   - plugins:    plugins/installed.json (the on-disk registry -- the Capability
//                 scan bind, sibling to Claude Code's installed_plugins.json).
//   - skills:     skills/<name>/SKILL.md (Anthropic SKILL.md convention) under the
//                 Kimi root AND the shared cross-tool ~/.agents/skills/ lane.
//   - agents:     agents/*.md (Claude-Code-format agent files) under the Kimi root
//                 AND ~/.agents/agents/.
//   - mcpServers: mcp.json's mcpServers map (Kimi is an MCP client).
// A fresh install (no plugins/agents/skills/mcp.json yet) yields an empty
// inventory -- the "works on a bare install, better as you install more" floor.
export async function readInstalledKimi(home, opts = {}) {
  const root = opts.dir || process.env.KIMI_CODE_HOME || join(home, ".kimi-code");
  const agentsHome = join(home, ".agents"); // shared cross-tool lane (does NOT move with KIMI_CODE_HOME)

  // plugins/installed.json: schema is not published field-for-field, so parse
  // defensively -- accept a {plugins:[...]}, a {plugins:{id:{}}}, or a flat
  // {id:{}} map, and take the ids.
  const registry = await readJson(join(root, "plugins", "installed.json"));
  const pluginBag = registry?.plugins ?? registry ?? {};
  const plugins = Array.isArray(pluginBag)
    ? pluginBag.map(p => (typeof p === "string" ? p : p?.id || p?.name)).filter(Boolean)
    : Object.keys(pluginBag);

  const skills = [];
  for (const base of [join(root, "skills"), join(agentsHome, "skills")]) {
    for (const name of await readdirSafe(base)) {
      const entries = await readdirSafe(join(base, name));
      if (entries.includes("SKILL.md")) skills.push(name);
    }
  }

  const agents = [];
  for (const base of [join(root, "agents"), join(agentsHome, "agents")]) {
    for (const f of await readdirSafe(base)) {
      if (f.endsWith(".md")) agents.push(f.slice(0, -3));
    }
  }

  const mcp = await readJson(join(root, "mcp.json"));
  const mcpServers = mcp && mcp.mcpServers ? Object.keys(mcp.mcpServers) : [];

  return {
    runtime: "kimi",
    plugins: [...new Set(plugins)],
    skills: [...new Set(skills)],
    agents: [...new Set(agents)],
    mcpServers: [...new Set(mcpServers)]
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
