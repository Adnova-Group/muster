import { join, posix } from "node:path";
import { readJson, readdirSafe } from "./fs-util.js";
import { readPluginInventory } from "./plugin-inventory.js";
export { readCodexInventory } from "./codex-inventory.js";

// --- ChatGPT Work adapter ----------------------------------------------------
// A ChatGPT Work connection can invoke the tools exposed by this MCP server,
// but it cannot dispatch Claude Code plugins/skills/agents or Codex custom
// agents. The MCP tools are orchestration operations, not role providers in the
// provider catalog, so the deterministic CLI inventory is intentionally empty.
// The full profile can safely resolve every role to inline from this inventory;
// pro-safe exposes only muster_prioritize at the MCP adapter layer and therefore
// must not gain invented providers here either.
export function readInstalledWork() {
  return {
    runtime: "work",
    plugins: [],
    skills: [],
    agents: [],
    mcpServers: [],
  };
}

// --- Claude Desktop (Chat + Cowork) adapter -----------------------------------
// Since the 2026-09-16 Unified Claude rollout, Chat and Cowork load plugins from
// the claude.ai account (Customize > Plugins), not from the CLI's ~/.claude
// directory: "Cowork loads the ones enabled for your claude.ai account, synced at
// session start, and doesn't read the Claude Code CLI's ~/.claude directory"
// (claude.com/docs/cowork/overview). Per claude.com/docs/plugins/platform-support,
// Cowork loads a plugin's skills, commands, agents and hooks, and its local MCP
// servers only "when the Cowork session runs on your computer"; Chat loads skills
// and commands and ignores agents and hooks (docs/research/claude-cowork.md §3).
//
// So the Cowork inventory has three legs:
//   1. local MCP servers (claude_desktop_config.json) and MCPB/DXT extensions
//      (a Claude Extensions/ dir, no index file);
//   2. remote connectors: account state, never on disk, so DECLARED;
//   3. whether muster's own plugin rides in through the account plugin list.
// Leg 3 is read from the Desktop app's local copy of that list,
// <config dir>/plugin-list/<org>/<account>/plugins.json (observed on Claude
// Desktop for Windows 2026-11-10; the layout is not documented, so a missing or
// unreadable list means "unknown", never "absent"). ~/.claude/plugins stays
// excluded: Cowork does not read it.

// Ordered candidate Claude config dirs for a platform. On Windows the MSIX-virtualized
// path is the one the app actually reads, so it comes before the %APPDATA% fallback.
export async function coworkConfigDirs(home, platform = process.platform) {
  if (platform === "darwin") return [posix.join(home, "Library/Application Support/Claude")];
  if (platform === "win32") {
    const dirs = [];
    const packages = join(home, "AppData/Local/Packages");
    for (const e of await readdirSafe(packages)) {
      if (e.startsWith("Claude_")) dirs.push(join(packages, e, "LocalCache/Roaming/Claude"));
    }
    dirs.push(join(home, "AppData/Roaming/Claude"));
    return dirs;
  }
  return [posix.join(home, ".config/Claude")]; // linux (community builds) + fallback
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

// The account plugin list the Desktop app caches locally:
// <dir>/plugin-list/<org>/<account>/plugins.json -> {plugins:[{id,name,enabled}]}.
// Returns null when no list is readable (unknown), else every entry found.
export async function readAccountPluginList(dir) {
  const root = join(dir, "plugin-list");
  let found = false;
  const plugins = [];
  for (const org of await readdirSafe(root)) {
    for (const account of await readdirSafe(join(root, org))) {
      const list = await readJson(join(root, org, account, "plugins.json"));
      if (!list || !Array.isArray(list.plugins)) continue;
      found = true;
      for (const p of list.plugins) {
        if (p && typeof p.id === "string") {
          plugins.push({ id: p.id, name: p.name || p.id.split("@")[0], enabled: p.enabled !== false });
        }
      }
    }
  }
  return found ? plugins : null;
}

// Tri-state parse of a plugin-ride declaration: true, false, or undefined (not
// declared). `--native-plugin` declares true and `--plugin-less` false;
// MUSTER_COWORK_NATIVE_PLUGIN declares true for a truthy value, false for an
// explicit 0/false/no/off, and nothing when unset or empty.
export function declaredPluginRide(argv = [], env = process.env) {
  if (argv.includes("--native-plugin")) return true;
  if (argv.includes("--plugin-less")) return false;
  const raw = env.MUSTER_COWORK_NATIVE_PLUGIN;
  if (raw === undefined || raw === null || String(raw).trim() === "") return undefined;
  return !/^(0|false|no|off)$/i.test(String(raw).trim());
}

// Cowork-flavored readInstalled: same {plugins, skills, mcpServers, agents} shape
// resolveCapabilities consumes, plus `pluginLoad` (glass-box: where the plugin
// decision came from) and the derived `nativePluginRide` boolean.
//
// nativePluginRide precedence:
//   1. a declaration (opts.nativePluginRide true/false; see declaredPluginRide);
//   2. the account plugin list: muster present and enabled -> true; list readable
//      but muster absent or disabled -> false (the plugin-less MCP fallback);
//   3. no readable list -> true. The plugin marketplace is the documented Desktop
//      route and Cowork loads plugin skills and agents, so an unknown is not
//      treated as plugin-less. Declare MUSTER_COWORK_NATIVE_PLUGIN=0 for an
//      MCP-only install on a machine whose list cannot be read.
// Remote connectors cannot be discovered (connectorsDiscoverable:false) and must
// be DECLARED.
export async function readInstalledCowork(home, opts = {}) {
  const { platform = process.platform, declaredConnectors = [], dir, nativePluginRide } = opts;
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

  let accountList = null;
  for (const d of dirs) {
    accountList = await readAccountPluginList(d);
    if (accountList) break;
  }
  const musterEntry = accountList
    ? accountList.find(p => p.name === "muster" || p.id.startsWith("muster@"))
    : undefined;

  let pluginLoad;
  if (typeof nativePluginRide === "boolean") {
    pluginLoad = { state: nativePluginRide ? "present" : "absent", source: "declared" };
  } else if (accountList) {
    pluginLoad = {
      state: musterEntry && musterEntry.enabled ? "present" : "absent",
      source: "account-plugin-list",
      ...(musterEntry ? { id: musterEntry.id, enabled: musterEntry.enabled } : {}),
    };
  } else {
    pluginLoad = { state: "unknown", source: "default" };
  }

  return {
    runtime: "cowork",
    plugins: [],
    skills: [],
    agents: [],
    mcpServers: [...new Set([...discovered, ...declaredConnectors])],
    connectorsDiscoverable: false,
    connectorsDeclared: [...new Set(declaredConnectors)],
    pluginLoad,
    nativePluginRide: pluginLoad.state !== "absent"
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
