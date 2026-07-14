import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { CODEX_COUNTS } from "./codex.js";
import { codexAvailable, readCodexInventory } from "./codex-inventory.js";
import { exists } from "./fs-util.js";
import { resolveCodexRelease } from "./codex-release.js";

export async function runCodexDoctor({ root, cwd = process.cwd(), codexHome, execFile } = {}) {
  const base = root instanceof URL ? fileURLToPath(root) : (root || process.cwd());
  // The npm CLI runs from the package root; the bundled runtime runs from the
  // plugin root itself. Support both layouts without requiring npm at runtime.
  const isPluginRoot = await exists(join(base, ".codex-plugin", "plugin.json"));
  let selected = null;
  if (!isPluginRoot) {
    try { selected = await resolveCodexRelease(base); }
    catch { /* report the selected-release failure through the plugin/profile checks */ }
  }
  const plugin = isPluginRoot ? base : (selected?.pluginRoot || join(base, ".agents", "plugins", "releases", "missing", "plugin"));
  const checks = [];
  const available = await codexAvailable({ execFile });
  checks.push({ name: "codex-cli", ok: available, detail: available ? "codex detected on PATH" : "codex not found — profiles can be installed, plugin registration is skipped" });
  try {
    const [manifest, pkg] = await Promise.all([
      readFile(join(plugin, ".codex-plugin", "plugin.json"), "utf8").then(JSON.parse),
      readFile(join(plugin, "package.json"), "utf8").then(JSON.parse)
    ]);
    checks.push({ name: "codex-plugin", ok: manifest.name === "muster" && manifest.version === pkg.version, detail: `muster ${manifest.version || "unknown"}` });
  } catch (error) { checks.push({ name: "codex-plugin", ok: false, detail: error.message }); }
  try {
    const profileDir = isPluginRoot ? join(plugin, "agents") : selected.profilesRoot;
    const files = (await readdir(profileDir)).filter(name => name.endsWith(".toml"));
    checks.push({ name: "codex-agents", ok: files.length === CODEX_COUNTS.agents, detail: `${files.length}/${CODEX_COUNTS.agents} generated profiles` });
  } catch (error) { checks.push({ name: "codex-agents", ok: false, detail: error.message }); }
  const required = ["runtime/muster.mjs", "runtime/muster-mcp.mjs", ".mcp.json"];
  const missing = [];
  for (const item of required) if (!(await exists(join(plugin, item)))) missing.push(item);
  checks.push({ name: "codex-runtime", ok: missing.length === 0, detail: missing.length ? `missing: ${missing.join(", ")}` : "bundled runtime and MCP entrypoint present" });
  const hookEvents = ["SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "SubagentStart", "SubagentStop", "Stop"];
  const hookHomes = [...new Set([join(cwd, ".codex"), codexHome || process.env.CODEX_HOME || join(homedir(), ".codex")])];
  const hookStatuses = [];
  for (const dir of hookHomes) {
    try {
      const [config, owner] = await Promise.all([
        readFile(join(dir, "hooks.json"), "utf8").then(JSON.parse),
        readFile(join(dir, "muster", ".muster-managed.json"), "utf8").then(JSON.parse)
      ]);
      const commandIsMuster = group => (group?.hooks || []).some(hook => [hook.command, hook.commandWindows, hook.command_windows]
        .some(command => typeof command === "string" && command.replaceAll("\\", "/").includes("/muster/hooks/muster-hook.mjs")));
      const configured = hookEvents.every(event => (config.hooks?.[event] || []).some(commandIsMuster));
      const runtime = await Promise.all(["muster-hook.mjs", "action-guard.mjs"].map(file => exists(join(dir, "muster", "hooks", file))));
      if (owner.owner === "muster" && configured && runtime.every(Boolean)) hookStatuses.push(dir);
    } catch { /* inspect the next supported scope */ }
  }
  const hookStatus = hookStatuses[0] || null;
  checks.push({ name: "codex-hooks", ok: Boolean(hookStatus), detail: hookStatus
    ? `managed lifecycle hooks configured at ${hookStatus}; non-managed hooks require one-time trust review in /hooks`
    : "managed Codex lifecycle hooks are not installed; run muster install codex for the intended project or user scope" });
  checks.push({ name: "codex-hooks-overlap", ok: true, detail: hookStatuses.length > 1
    ? "Muster hooks are installed at both project and user scopes; atomic runtime dedupe suppresses identical logical event emissions across copies"
    : "No project and user Muster hook overlap detected; runtime dedupe remains active for repeated logical events" });
  checks.push({ name: "codex-policy-limitations", ok: true, detail: "Hooks provide lifecycle context, diagnostics, and supported policy warnings; todo and spawn enforcement remain advisory, and write-capable waves require isolated worktrees" });
  if (available) {
    const inventory = await readCodexInventory({ cwd, codexHome, execFile });
    const installed = inventory.plugins.includes("muster");
    checks.push({ name: "codex-plugin-installed", ok: installed, detail: installed ? "muster plugin is enabled in live Codex state" : "muster plugin is not installed; run muster install codex" });
    checks.push({ name: "codex-inventory", ok: true, detail: `${inventory.plugins.length} plugins, ${inventory.skills.length} skills, ${inventory.mcpServers.length} MCP servers, ${inventory.agents.length} agents from live Codex state` });
  }
  return { ok: checks.every(check => check.ok), target: "codex", checks };
}
