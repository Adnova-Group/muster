import { constants as fsConstants } from "node:fs";
import { lstat, open, readFile, readdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { CODEX_COUNTS } from "./codex.js";
import { codexAvailable, readCodexInventory } from "./codex-inventory.js";
import { exists } from "./fs-util.js";
import { resolveCodexRelease } from "./codex-release.js";

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  return value;
}

const same = (left, right) => JSON.stringify(canonical(left)) === JSON.stringify(canonical(right));
const groupCommands = group => (group?.hooks || []).flatMap(hook => [hook?.command, hook?.commandWindows, hook?.command_windows]);
const isMusterHookGroup = group => groupCommands(group).some(command => typeof command === "string" && command.replaceAll("\\", "/").includes("/muster/hooks/muster-hook.mjs"));
const MCP_TIMEOUT_MS = 5_000;
const mcpVisibilityNote = "Codex may defer MCP tool visibility until lookup or a new session";

function missingPath(error) {
  return error?.code === "ENOENT" || error?.code === "ENOTDIR";
}

async function ordinaryDirectoryPath(path) {
  const absolute = resolve(path), root = parse(absolute).root;
  let current = root;
  for (const part of relative(root, absolute).split(sep).filter(Boolean)) {
    current = join(current, part);
    let stat;
    try { stat = await lstat(current); }
    catch (error) {
      if (missingPath(error)) return false;
      throw error;
    }
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`Codex configuration ancestry must be an ordinary directory: ${current}`);
  }
  return true;
}

async function readRegularFile(path, encoding) {
  if (!(await ordinaryDirectoryPath(dirname(path)))) return null;
  let before;
  try { before = await lstat(path); }
  catch (error) {
    if (missingPath(error)) return null;
    throw error;
  }
  if (before.isSymbolicLink() || !before.isFile()) throw new Error(`Codex configuration target must be a regular file: ${path}`);
  let handle;
  try {
    handle = await open(path, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW || 0));
    const current = await handle.stat();
    if (!current.isFile() || current.dev !== before.dev || current.ino !== before.ino) throw new Error(`Codex configuration target changed while reading: ${path}`);
    return handle.readFile(encoding);
  } finally {
    if (handle) await handle.close().catch(() => {});
  }
}

async function readRegularJson(path) {
  const content = await readRegularFile(path, "utf8");
  return content === null ? null : JSON.parse(content);
}

async function registeredManagedScopes(home) {
  const registryPath = join(home, "muster", "install-scopes.json");
  let registry;
  try { registry = await readRegularJson(registryPath); }
  catch (error) { return { dirs: [], issues: [`could not safely read managed-scope registry ${registryPath}: ${error.message}`] }; }
  if (!registry) return { dirs: [], issues: [] };
  if (registry.format !== 1 || registry.owner !== "muster" || !Array.isArray(registry.entries)) {
    return { dirs: [], issues: [`managed-scope registry is invalid: ${registryPath}`] };
  }
  const dirs = [], issues = [], seen = new Set(), expectedUserScope = resolve(home);
  for (const entry of registry.entries) {
    const dir = entry?.configDir;
    const valid = entry && ["project", "user"].includes(entry.scope) && typeof dir === "string" && isAbsolute(dir)
      && resolve(dir) === dir && dir.endsWith(`${sep}.codex`)
      && (entry.scope !== "user" || dir === expectedUserScope);
    if (!valid || seen.has(`${entry?.scope}:${dir}`)) {
      issues.push(`managed-scope registry has an unsafe entry: ${registryPath}`);
      continue;
    }
    seen.add(`${entry.scope}:${dir}`);
    try {
      const managedDirectories = [dir, join(dir, "agents"), join(dir, "muster"), join(dir, "muster", "hooks")];
      if ((await Promise.all(managedDirectories.map(ordinaryDirectoryPath))).every(Boolean)) dirs.push(dir);
      else issues.push(`registered managed scope is missing required content: ${dir}`);
    } catch (error) {
      issues.push(`registered managed scope is unsafe: ${dir} (${error.message})`);
    }
  }
  return { dirs, issues };
}

export async function runMcpHandshake({ entrypoint, cwd, timeoutMs = MCP_TIMEOUT_MS, spawnProcess = spawn } = {}) {
  return new Promise((resolve, reject) => {
    let child, timer, buffer = "", initialized = false, settled = false, stderr = "";
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      let cleanupError = null;
      try { if (child?.stdin && !child.stdin.destroyed) child.stdin.end(); } catch (failure) { cleanupError = failure; }
      try { if (child && !child.killed) child.kill(); } catch (failure) { cleanupError ||= failure; }
      if (error) reject(error); else if (cleanupError) reject(cleanupError); else resolve(result);
    };
    const fail = message => finish(message instanceof Error ? message : new Error(message));
    try {
      child = spawnProcess(process.execPath, [entrypoint], { cwd, stdio: ["pipe", "pipe", "pipe"] });
    } catch (error) { fail(error); return; }
    if (!child?.stdin || !child?.stdout || !child?.stderr) { fail("MCP process did not expose stdio"); return; }
    timer = setTimeout(() => fail(`MCP initialize/tools/list timed out after ${timeoutMs}ms`), timeoutMs);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", chunk => {
      if (settled) return;
      buffer += chunk;
      for (;;) {
        const newline = buffer.indexOf("\n");
        if (newline < 0) return;
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (!line) continue;
        let message;
        try { message = JSON.parse(line); }
        catch { fail("MCP emitted invalid JSON-RPC output"); return; }
        if (message.id === 1) {
          if (message.error || !message.result) { fail(`MCP initialize failed: ${message.error?.message || "missing result"}`); return; }
          initialized = true;
          try {
            child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
            child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} })}\n`);
          } catch (error) { fail(error); return; }
        } else if (message.id === 2) {
          if (message.error) { fail(`MCP tools/list failed: ${message.error.message || "unknown error"}`); return; }
          if (!Array.isArray(message.result?.tools)) { fail("MCP tools/list returned no tools array"); return; }
          finish(null, { initialized, tools: message.result.tools });
          return;
        }
      }
    });
    child.stdout.on("error", error => fail(error));
    child.stderr.on("data", chunk => { stderr += chunk; });
    child.stderr.on("error", error => fail(error));
    child.on("error", error => fail(error));
    child.on("exit", (code, signal) => {
      if (!settled) fail(`MCP process exited before tools/list (${signal || code || "unknown"})${stderr.trim() ? `: ${stderr.trim()}` : ""}`);
    });
    child.stdin.on("error", error => fail(error));
    try {
      child.stdin.write(`${JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "muster-doctor", version: "1" } }
      })}\n`);
    } catch (error) { fail(error); }
  });
}

function ownsExactHookGroups(config, owner) {
  if (!config?.hooks || typeof config.hooks !== "object" || Array.isArray(config.hooks) || !owner?.hookGroups || typeof owner.hookGroups !== "object" || Array.isArray(owner.hookGroups)) return false;
  const expected = [];
  for (const [event, groups] of Object.entries(owner.hookGroups)) {
    if (!Array.isArray(groups)) return false;
    for (const group of groups) {
      if (!isMusterHookGroup(group)) return false;
      expected.push({ event, group });
    }
  }
  const actual = [];
  for (const [event, groups] of Object.entries(config.hooks)) {
    if (!Array.isArray(groups)) return false;
    for (const group of groups) if (isMusterHookGroup(group)) actual.push({ event, group });
  }
  if (expected.length === 0 || actual.length !== expected.length) return false;
  for (const owned of expected) {
    const index = actual.findIndex(candidate => candidate.event === owned.event && same(candidate.group, owned.group));
    if (index < 0) return false;
    actual.splice(index, 1);
  }
  return actual.length === 0;
}

export async function runCodexDoctor({ root, cwd = process.cwd(), codexHome, execFile, mcpRunner = runMcpHandshake } = {}) {
  const base = root instanceof URL ? fileURLToPath(root) : (root || process.cwd());
  // The npm CLI runs from the package root; the bundled runtime runs from the
  // plugin root itself. Support both layouts without requiring npm at runtime.
  const isPluginRoot = await exists(join(base, ".codex-plugin", "plugin.json"));
  let selected = null;
  let distributionRoot = base;
  if (isPluginRoot) {
    try {
      const releaseRoot = dirname(base), metadata = JSON.parse(await readFile(join(releaseRoot, "release.json"), "utf8"));
      selected = { generation: metadata.generation, metadata, releaseRoot, pluginRoot: base, profilesRoot: join(base, "agents") };
      distributionRoot = resolve(releaseRoot, "../../../..");
    } catch { /* plugin checks below report malformed cache layout */ }
  } else {
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
  const userCodexHome = codexHome || process.env.CODEX_HOME || join(homedir(), ".codex");
  const registeredScopes = await registeredManagedScopes(userCodexHome);
  checks.push({ name: "codex-managed-scopes", ok: registeredScopes.issues.length === 0, detail: registeredScopes.issues.length
    ? `${registeredScopes.issues.join("; ")}; rerun muster install codex for the affected scope`
    : registeredScopes.dirs.length ? `${registeredScopes.dirs.length} safe registered managed scope(s) inspected` : "no managed-scope registry found; inspecting current project and user scopes" });
  const scopeHomes = new Map([[join(cwd, ".codex"), false], [userCodexHome, false]]);
  for (const dir of registeredScopes.dirs) scopeHomes.set(dir, true);
  const hookHomes = [...scopeHomes.keys()];
  try {
    const handshake = await mcpRunner({ entrypoint: join(plugin, "runtime", "muster-mcp.mjs"), cwd, timeoutMs: MCP_TIMEOUT_MS });
    const count = Array.isArray(handshake?.tools) ? handshake.tools.length : 0;
    const ok = handshake?.initialized === true && count === CODEX_COUNTS.mcpTools;
    checks.push({ name: "codex-mcp-handshake", ok, detail: ok
      ? `initialize + tools/list returned ${count}/${CODEX_COUNTS.mcpTools} tools; ${mcpVisibilityNote}`
      : `initialize + tools/list returned ${count}/${CODEX_COUNTS.mcpTools} tools${handshake?.initialized ? "" : "; initialize did not complete"}; ${mcpVisibilityNote}` });
  } catch (error) {
    checks.push({ name: "codex-mcp-handshake", ok: false, detail: `bundled MCP initialize/tools/list handshake failed: ${error.message}; ${mcpVisibilityNote}` });
  }
  if (selected) {
    let bootstrapDigest = null;
    try { bootstrapDigest = JSON.parse(await readFile(join(distributionRoot, ".agents", "plugins", "marketplace.json"), "utf8")).musterBootstrap?.digest; } catch { /* selected release check reports the root failure */ }
    const installations = [];
    for (const dir of hookHomes) {
      try {
        const manifestPath = join(dir, "agents", ".muster-managed.json");
        const owner = scopeHomes.get(dir)
          ? await readRegularJson(manifestPath)
          : JSON.parse(await readFile(manifestPath, "utf8"));
        if (!owner) throw new Error(`managed profile manifest is missing: ${manifestPath}`);
        installations.push({ dir, ok: owner.owner === "muster" && owner.generation === selected.generation && owner.bootstrapDigest === bootstrapDigest });
      } catch {
        if (scopeHomes.get(dir)) installations.push({ dir, ok: false });
      }
    }
    const stale = installations.filter(item => !item.ok);
    checks.push({ name: "codex-install-generation", ok: stale.length === 0, detail: stale.length
      ? `installed profiles do not match selected generation/bootstrap at: ${stale.map(item => item.dir).join(", ")}; rerun muster install codex`
      : installations.length ? `${installations.length} managed scope(s) match generation ${selected.generation}` : "no managed profile scopes detected" });
  }
  const hookStatuses = [];
  const staleHookScopes = [];
  let selectedBootstrapDigest = null;
  try { selectedBootstrapDigest = JSON.parse(await readFile(join(distributionRoot, ".agents", "plugins", "marketplace.json"), "utf8")).musterBootstrap?.digest; } catch { /* reported as stale below */ }
  for (const dir of hookHomes) {
    const manifestPath = join(dir, "muster", ".muster-managed.json");
    const registered = scopeHomes.get(dir);
    if (!registered && !(await exists(manifestPath))) continue;
    try {
      const owner = registered
        ? await readRegularJson(manifestPath)
        : JSON.parse(await readFile(manifestPath, "utf8"));
      if (!owner) throw new Error(`managed hook manifest is missing: ${manifestPath}`);
      const configPath = join(dir, "hooks.json");
      const config = registered
        ? await readRegularJson(configPath)
        : JSON.parse(await readFile(configPath, "utf8"));
      if (!config) throw new Error(`managed hook configuration is missing: ${configPath}`);
      const hookFiles = ["muster-hook.mjs", "action-guard.mjs"];
      const runtime = await Promise.all(hookFiles.map(file => registered
        ? readRegularFile(join(dir, "muster", "hooks", file))
        : readFile(join(dir, "muster", "hooks", file))));
      if (runtime.some(file => file === null)) throw new Error(`managed hook runtime is missing: ${dir}`);
      const hash = createHash("sha256");
      for (let index = 0; index < hookFiles.length; index++) hash.update(`hooks/${hookFiles[index]}`).update("\0").update(runtime[index]);
      const coherent = owner.owner === "muster" && ownsExactHookGroups(config, owner) && owner.generation === selected?.generation
        && owner.bootstrapDigest === selectedBootstrapDigest && owner.hookHash === hash.digest("hex");
      if (coherent) hookStatuses.push(dir); else staleHookScopes.push(dir);
    } catch { staleHookScopes.push(dir); }
  }
  const hookStatus = staleHookScopes.length === 0 ? hookStatuses[0] || null : null;
  checks.push({ name: "codex-hooks", ok: Boolean(hookStatus), detail: hookStatus
    ? `managed lifecycle hooks configured at ${hookStatus}; non-managed hooks require one-time trust review in /hooks`
    : staleHookScopes.length ? `managed lifecycle hooks are stale or differ from their exact ownership manifest at ${staleHookScopes.join(", ")}; rerun muster install codex for each scope` : "managed Codex lifecycle hooks are not installed; run muster install codex for the intended project or user scope" });
  checks.push({ name: "codex-hooks-overlap", ok: staleHookScopes.length === 0, detail: staleHookScopes.length
    ? "Project/user hook copies are not generation/hash/exact-group coherent, so exactly-once dedupe cannot be asserted; refresh every stale scope"
    : hookStatuses.length > 1
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
