import { constants as fsConstants } from "node:fs";
import { lstat, open, readFile, readdir, realpath, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { CODEX_COUNTS } from "./codex.js";
import { codexAvailable, readCodexInventory } from "./codex-inventory.js";
import { exists } from "./fs-util.js";
import { resolveCodexPlugin } from "./codex-release.js";
import { parseHookCommand, reconcileConfigTomlHookState, reconcileScopeRegistryEntries } from "./codex-install.js";
import {
  CODEX_THREAD_LIMIT_REMEDIATION,
  codexThreadLimitConfigPath,
  codexThreadLimitsMeetFloor,
  readCodexThreadLimits
} from "./codex-thread-limits.js";

// codex-path-shadow (backlog item run4-polish-pair; security-hardened by
// run-5 audit High #3 `doctor-path-shadow-no-exec`): a stale globally
// installed `muster` earlier on PATH than this package's own bin silently
// serves outdated behavior when invoked bare -- the 2026-07-19 run 4 dogfood
// found exactly this at /home/linuxbrew/.linuxbrew/bin/muster (an old `npm i
// -g` copy lacking the codex-conformance verb entirely).
//
// The first version of this check shelled out (`sh -c command -v muster`) and
// then EXECUTED the resolved candidate (`<candidate> help`) to diff verbs --
// running an attacker-plantable PATH binary just to inspect it, and requiring
// a POSIX `sh`. This resolves PATH IN-PROCESS and establishes the candidate's
// identity WITHOUT ever executing it:
//   1. Walk process.env.PATH (PATHEXT on win32) in-process for the first
//      `muster` bin -- no `command -v`/`which` shell-out.
//   2. realpath the found entry (following a symlink/shim to its target) and
//      compare canonical identity against this running package: same bin
//      realpath, or the resolved target's sibling package.json name+version.
//      Same => current; different version/name => stale/foreign.
// Semantics preserved: ok:true when absent or identical; ok:false naming the
// stale/foreign path + remediation. A broken PATH binary must not fail doctor
// incoherently -- any probe error here fails OPEN (ok:true) and NAMES it.

// Resolve the first PATH entry a bare `muster` invocation would select,
// in-process, honoring win32 PATHEXT + `;` delimiters. `lstat` (not `stat`)
// so a dangling symlink still counts as "found" -- its realpath failing later
// is what drives the fail-open branch, exactly as a real bare `muster` would
// try and fail. Directories named `muster` are skipped; the file is never
// opened or executed.
async function resolvePathMuster({ env, platform }) {
  const isWin = platform === "win32";
  const dirs = String(env.PATH ?? env.Path ?? "").split(isWin ? ";" : ":").map(entry => entry.trim()).filter(Boolean);
  // We always search the bare name `muster` (no extension typed), so on win32
  // the executable forms are `muster<ext>` for each PATHEXT entry; the bare
  // `muster` is appended last only as a fallback for an extensionless file.
  const names = isWin
    ? [...String(env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").map(ext => ext.trim()).filter(Boolean).map(ext => `muster${ext}`), "muster"]
    : ["muster"];
  for (const dir of dirs) {
    for (const candidateName of names) {
      const candidate = join(dir, candidateName);
      try {
        const info = await lstat(candidate);
        if (info.isDirectory()) continue;
        return candidate;
      } catch { /* not present in this dir under this name */ }
    }
  }
  return null;
}

// Canonical identity of the package that owns `startFile`, read WITHOUT
// executing anything: walk up to the nearest package.json and return its
// realpath'd root + name/version/muster-bin. null when no package.json is
// found up to the filesystem root (a foreign standalone binary).
async function packageIdentity(startFile) {
  let dir = dirname(startFile);
  for (;;) {
    let raw;
    try { raw = await readFile(join(dir, "package.json"), "utf8"); }
    catch {
      const parent = dirname(dir);
      if (parent === dir) return null;
      dir = parent;
      continue;
    }
    let parsed = {};
    try { parsed = JSON.parse(raw); } catch { /* found the package dir; manifest unreadable */ }
    const binField = typeof parsed.bin === "string" ? parsed.bin : parsed.bin?.muster ?? null;
    return { root: await realpath(dir), name: parsed.name ?? null, version: parsed.version ?? null, bin: binField };
  }
}

const PATH_SHADOW_REMEDIATION = "npm uninstall -g @adnova-group/muster / npm i -g @adnova-group/muster@latest";

async function checkPathShadow({ env = process.env, platform = process.platform, ownModuleUrl = import.meta.url } = {}) {
  const name = "codex-path-shadow";
  let found = null;
  try { found = await resolvePathMuster({ env, platform }); }
  catch { found = null; }
  if (!found) return { name, ok: true, detail: "no `muster` found on PATH outside this running package" };
  try {
    const own = await packageIdentity(fileURLToPath(ownModuleUrl));
    // If we cannot establish our OWN identity (a corrupted install with no
    // ancestor package.json), we have no basis to judge whether the PATH
    // entry is a shadow -- fail OPEN rather than cry wolf against every user.
    if (!own?.root) {
      return { name, ok: true, detail: `found \`muster\` on PATH at ${found} but could not establish this running package's own identity to compare it against` };
    }
    const resolvedFound = await realpath(found); // follow symlink/shim -> throws on a dangling entry -> fail open below

    // 1) Cheapest identity: the PATH entry resolves to THIS package's own bin.
    if (own.bin) {
      const ownBinReal = await realpath(resolve(own.root, own.bin)).catch(() => null);
      if (ownBinReal && ownBinReal === resolvedFound) {
        return { name, ok: true, detail: `PATH \`muster\` at ${found} resolves to this running package's own bin (${own.name ?? "muster"}@${own.version ?? "unknown"})` };
      }
    }

    // 2) Otherwise compare the resolved target's sibling package.json identity.
    const target = await packageIdentity(resolvedFound);
    if (target?.root && own?.root && target.root === own.root) {
      return { name, ok: true, detail: `PATH \`muster\` at ${found} is this running package` };
    }
    if (target && own && target.name === own.name && target.version != null && target.version === own.version) {
      return { name, ok: true, detail: `PATH \`muster\` at ${found} matches this package (${target.name}@${target.version})` };
    }

    const description = target
      ? (target.name === own?.name
          ? `a stale muster (${target.name ?? "muster"}@${target.version ?? "unknown"}), not this package's ${own?.version ?? "version"}`
          : `a foreign \`${target.name ?? "unknown"}\`${target.version ? `@${target.version}` : ""} package, not muster`)
      : "not part of any installed muster package";
    return { name, ok: false, detail: `PATH \`muster\` at ${found} is ${description} -- a bare \`muster\` would run it instead of this package; ${PATH_SHADOW_REMEDIATION} (or remove the shadow at ${found})` };
  } catch (error) {
    return { name, ok: true, detail: `found \`muster\` on PATH at ${found} but could not probe it: ${error.message}` };
  }
}

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

// Pre-0.5.x Muster installs keyed coherence on a committed-release
// generation hash (`generation`/`bootstrapDigest`) instead of the installed
// package's version. Wave 2's teardown (2026-07-15) switched the managed
// manifest's coherence key to `packageVersion` — see CHANGELOG.md — so an
// untouched pre-0.5.x install now fails every version-comparison check below
// with an opaque "does not match"/"is stale" message that gives no hint the
// real cause is simply "this predates the key rename." Detecting that exact
// legacy shape lets each check name it and point at the one-line fix instead.
function isLegacyManagedManifest(owner) {
  return Boolean(owner) && owner.owner === "muster" && typeof owner.packageVersion !== "string"
    && (typeof owner.generation === "string" || typeof owner.bootstrapDigest === "string");
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
    // The `${sep}.codex` basename requirement is a PROJECT-scope invariant:
    // project scopes are always `<repo>/.codex`. The user scope is `$CODEX_HOME`
    // -- an arbitrary absolute path a user may set (default `~/.codex`, but
    // Codex honours whatever CODEX_HOME points at), so it is validated by exact
    // identity with the resolved CODEX_HOME (expectedUserScope) rather than its
    // basename. Every other safety check stays enforced for BOTH scopes:
    // absolute, canonical (resolve(dir) === dir), and the per-entry ordinary-
    // directory + dev/ino content checks below; an escaped/non-`.codex` project
    // scope is still rejected.
    const valid = entry && ["project", "user"].includes(entry.scope) && typeof dir === "string" && isAbsolute(dir)
      && resolve(dir) === dir
      && (entry.scope === "user" ? dir === expectedUserScope : dir.endsWith(`${sep}.codex`));
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

// Raw (best-effort, non-throwing) scope entries for the hook-state drift
// check: unlike registeredManagedScopes above, this never filters an entry
// out for failing a health check -- reconcileScopeRegistryEntries/
// reconcileConfigTomlHookState need the FULL universe (including entries
// whose configDir is missing or content is stale) to compute what would be
// pruned; a malformed or absent registry simply yields no known scopes.
async function rawScopeRegistryEntries(home) {
  const registryPath = join(home, "muster", "install-scopes.json");
  let registry;
  try { registry = await readRegularJson(registryPath); }
  catch { return []; }
  if (!registry || registry.format !== 1 || registry.owner !== "muster" || !Array.isArray(registry.entries)) return [];
  return registry.entries.filter(entry => entry && ["project", "user"].includes(entry.scope)
    && typeof entry.configDir === "string" && isAbsolute(entry.configDir));
}

export async function runMcpHandshake({ entrypoint, cwd, timeoutMs = MCP_TIMEOUT_MS, spawnProcess = spawn } = {}) {
  return new Promise((resolve, reject) => {
    let child, timer, buffer = "", initialized = false, settled = false, stderr = "", tools = null;
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
    timer = setTimeout(() => fail(`MCP initialize/tools/list/tools/call timed out after ${timeoutMs}ms`), timeoutMs);
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
          tools = message.result.tools;
          // A successful handshake proves the server process starts -- not that
          // its tool handlers can reach the bundled CLI. The dogfooded failure
          // mode was exactly that split: 21/21 tools listed while every
          // tools/call crashed on a missing CLI path. Smoke one real call.
          try {
            child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "muster_detect", arguments: {} } })}\n`);
          } catch (error) { fail(error); return; }
        } else if (message.id === 3) {
          if (message.error) { fail(`MCP tools/call muster_detect failed: ${message.error.message || "unknown error"}`); return; }
          const text = message.result?.content?.[0]?.text;
          let toolCallOk = message.result?.isError !== true && typeof text === "string";
          if (toolCallOk) { try { JSON.parse(text); } catch { toolCallOk = false; } }
          if (!toolCallOk) { fail(`MCP tools/call muster_detect returned an error payload: ${String(text).slice(0, 160)}`); return; }
          finish(null, { initialized, tools, toolCallOk });
          return;
        }
      }
    });
    child.stdout.on("error", error => fail(error));
    child.stderr.on("data", chunk => { stderr += chunk; });
    child.stderr.on("error", error => fail(error));
    child.on("error", error => fail(error));
    child.on("exit", (code, signal) => {
      if (!settled) fail(`MCP process exited before the handshake completed (${signal || code || "unknown"})${stderr.trim() ? `: ${stderr.trim()}` : ""}`);
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

// Canonical-scope collapse (2026-07-18, codex-hook-scope-collapse): a
// project scope installed under a healthy user scope writes exactly this
// manifest shape (see src/codex-install.js's prepareHooks/
// userScopeHooksHealthy) -- no owned hook groups, no hook runtime files.
// ownsExactHookGroups above always returns false for it (expected.length
// === 0 is an explicit false there), which would otherwise make the
// coherence loop below misreport a deliberately hooks-free scope as stale.
function isHooksSkippedManifest(owner) {
  return owner?.owner === "muster" && owner.format === 1 && Array.isArray(owner.files) && owner.files.length === 0
    && owner.hookGroups && typeof owner.hookGroups === "object" && !Array.isArray(owner.hookGroups)
    && Object.keys(owner.hookGroups).length === 0;
}

export async function runCodexDoctor({ root, cwd = process.cwd(), codexHome, execFile, mcpRunner = runMcpHandshake, env = process.env, platform = process.platform, readConfigToml = path => readRegularFile(path, "utf8") } = {}) {
  const base = root instanceof URL ? fileURLToPath(root) : (root || process.cwd());
  // The npm CLI runs from the package root; the bundled runtime runs from the
  // plugin root itself. Support both layouts without requiring npm at runtime.
  const isPluginRoot = await exists(join(base, ".codex-plugin", "plugin.json"));
  let selected = null;
  if (isPluginRoot) {
    try {
      const pkg = JSON.parse(await readFile(join(base, "package.json"), "utf8"));
      selected = { packageVersion: pkg.version, pluginRoot: base, profilesRoot: join(base, "agents") };
    } catch { /* plugin checks below report malformed cache layout */ }
  } else {
    try { selected = await resolveCodexPlugin(base); }
    catch { /* report the selected-plugin failure through the plugin/profile checks */ }
  }
  const plugin = isPluginRoot ? base : (selected?.pluginRoot || join(base, ".agents", "plugins", "plugin"));
  const checks = [];
  const available = await codexAvailable({ execFile });
  checks.push({ name: "codex-cli", ok: available, detail: available ? "codex detected on PATH" : "codex not found — profiles can be installed, plugin registration is skipped" });
  checks.push(await checkPathShadow({ env, platform }));
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
  // Independent of install: the shared CODEX_HOME config.toml can drift
  // below the enforced floor at any time (hand-edited, or a Codex upgrade
  // resetting it) with no `muster install codex` in between -- this check
  // re-reads it live every `doctor` run rather than trusting the install-
  // time manifest, and reuses the exact same remediation text a failed
  // install throws (backlog item `codex-thread-limits-enforcement`).
  const threadLimitConfigPath = codexThreadLimitConfigPath(userCodexHome);
  // ONE safe config.toml snapshot per doctor run (run-5 audit Low #13): the
  // thread-limit and hook-state checks below -- and any future config.toml
  // consumer -- reuse these exact bytes (or this exact read error) rather than
  // re-reading. A concurrent mutation between checks can no longer make them
  // disagree, since there is only one read. Parity with the prior per-check
  // reads is preserved: a null snapshot (missing file) still yields each
  // check's own not-found/nothing-to-reconcile diagnostic, and a read error is
  // re-thrown INTO each check's own try below so it produces the same per-check
  // message it did before -- one failed read feeds every dependent check, it
  // does not newly abort the whole run.
  let configTomlText = null;
  let configTomlReadError = null;
  try {
    configTomlText = await readConfigToml(threadLimitConfigPath);
  } catch (error) {
    configTomlReadError = error;
  }
  try {
    if (configTomlReadError) throw configTomlReadError;
    const text = configTomlText;
    if (text === null) {
      checks.push({ name: "codex-thread-limits", ok: false, detail: `Codex config.toml not found at ${threadLimitConfigPath}. ${CODEX_THREAD_LIMIT_REMEDIATION}` });
    } else {
      const limits = readCodexThreadLimits(text);
      const ok = codexThreadLimitsMeetFloor(limits);
      checks.push({ name: "codex-thread-limits", ok, detail: ok
        ? `max_threads=${limits.max_threads}, max_depth=${limits.max_depth} at ${threadLimitConfigPath} meet the Muster floor (>=12/>=2)`
        : `max_threads=${limits.max_threads ?? "unset"}, max_depth=${limits.max_depth ?? "unset"} at ${threadLimitConfigPath} below the Muster floor. ${CODEX_THREAD_LIMIT_REMEDIATION}` });
    }
  } catch (error) {
    checks.push({ name: "codex-thread-limits", ok: false, detail: `${error.message}. ${CODEX_THREAD_LIMIT_REMEDIATION}` });
  }
  // codex-hook-bombardment: config.toml's [hooks.state] trust cache never
  // gets pruned as scopes are deleted or case-duplicated (see
  // reconcileConfigTomlHookState's rationale in src/codex-install.js), so a
  // dead or duplicate scope keeps a live, firing hook registration forever.
  // This re-derives the SAME stale/duplicate verdict `muster install codex`
  // would reconcile away, purely to detect and report drift -- doctor never
  // mutates config.toml (and never touches [projects] either way).
  try {
    if (configTomlReadError) throw configTomlReadError;
    const text = configTomlText;
    if (text === null) {
      checks.push({ name: "codex-hook-state", ok: true, detail: "Codex config.toml not found; nothing to reconcile" });
    } else {
      const registeredEntries = await rawScopeRegistryEntries(userCodexHome);
      const keptEntries = await reconcileScopeRegistryEntries(registeredEntries);
      // [projects] is never inspected or reported here: fix iteration 1
      // removed [projects] pruning from reconcileConfigTomlHookState
      // entirely (a leftover Codex trusted-directory record is harmless;
      // muster cannot reliably attribute it as its own), so
      // reconcileConfigTomlHookState's prunedProjects is always empty.
      const { prunedHookState } = reconcileConfigTomlHookState(text, registeredEntries, keptEntries);
      const overRegistered = prunedHookState.length > 0;
      const staleConfigDirs = [...new Set(prunedHookState.map(item => item.configDir))];
      checks.push({ name: "codex-hook-state", ok: !overRegistered, detail: overRegistered
        ? `config.toml [hooks.state] retains ${prunedHookState.length} stale or case-duplicate Muster hook trust entr${prunedHookState.length === 1 ? "y" : "ies"} (${staleConfigDirs.join(", ")}); rerun muster install codex to reconcile`
        : "config.toml [hooks.state] has no stale or duplicate Muster hook registrations" });
    }
  } catch (error) {
    checks.push({ name: "codex-hook-state", ok: false, detail: `could not inspect config.toml [hooks.state]: ${error.message}` });
  }
  const scopeHomes = new Map([[join(cwd, ".codex"), false], [userCodexHome, false]]);
  for (const dir of registeredScopes.dirs) scopeHomes.set(dir, true);
  const hookHomes = [...scopeHomes.keys()];
  try {
    const handshake = await mcpRunner({ entrypoint: join(plugin, "runtime", "muster-mcp.mjs"), cwd, timeoutMs: MCP_TIMEOUT_MS });
    const count = Array.isArray(handshake?.tools) ? handshake.tools.length : 0;
    // toolCallOk is the load-bearing half: a listing-only handshake passed for
    // a bundle whose every tools/call crashed on a missing CLI path (the
    // 2026-07-18 dogfood finding), so tool registration alone proves nothing.
    const ok = handshake?.initialized === true && count === CODEX_COUNTS.mcpTools && handshake?.toolCallOk === true;
    checks.push({ name: "codex-mcp-handshake", ok, detail: ok
      ? `initialize + tools/list returned ${count}/${CODEX_COUNTS.mcpTools} tools and tools/call muster_detect executed; ${mcpVisibilityNote}`
      : `initialize + tools/list returned ${count}/${CODEX_COUNTS.mcpTools} tools${handshake?.initialized ? "" : "; initialize did not complete"}${handshake?.toolCallOk === true ? "" : "; tools/call smoke did not pass"}; ${mcpVisibilityNote}` });
  } catch (error) {
    checks.push({ name: "codex-mcp-handshake", ok: false, detail: `bundled MCP initialize/tools/list handshake failed: ${error.message}; ${mcpVisibilityNote}` });
  }
  const scopeKeyword = dir => dir === userCodexHome ? "user" : "project";
  const legacyRemediation = dirs => `legacy pre-0.5.x install detected at ${dirs
    .map(dir => `${dir} (rerun \`muster install codex --scope ${scopeKeyword(dir)}\` to migrate)`)
    .join(", ")}`;
  if (selected) {
    const installations = [];
    for (const dir of hookHomes) {
      try {
        const manifestPath = join(dir, "agents", ".muster-managed.json");
        const owner = scopeHomes.get(dir)
          ? await readRegularJson(manifestPath)
          : JSON.parse(await readFile(manifestPath, "utf8"));
        if (!owner) throw new Error(`managed profile manifest is missing: ${manifestPath}`);
        installations.push({ dir, ok: owner.owner === "muster" && owner.packageVersion === selected.packageVersion, legacy: isLegacyManagedManifest(owner) });
      } catch {
        if (scopeHomes.get(dir)) installations.push({ dir, ok: false, legacy: false });
      }
    }
    const stale = installations.filter(item => !item.ok);
    const legacyStale = stale.filter(item => item.legacy).map(item => item.dir);
    const versionStale = stale.filter(item => !item.legacy).map(item => item.dir);
    checks.push({ name: "codex-install-generation", ok: stale.length === 0, detail: stale.length
      ? [
          legacyStale.length ? legacyRemediation(legacyStale) : null,
          versionStale.length ? `installed profiles do not match the selected package version at: ${versionStale.join(", ")}; rerun muster install codex` : null
        ].filter(Boolean).join("; ")
      : installations.length ? `${installations.length} managed scope(s) match package version ${selected.packageVersion}` : "no managed profile scopes detected" });
  }
  const hookStatuses = [];
  const staleHookScopes = [];
  const legacyHookScopes = [];
  const hookInterpreters = [];
  for (const dir of hookHomes) {
    const manifestPath = join(dir, "muster", ".muster-managed.json");
    const registered = scopeHomes.get(dir);
    if (!registered && !(await exists(manifestPath))) continue;
    try {
      const owner = registered
        ? await readRegularJson(manifestPath)
        : JSON.parse(await readFile(manifestPath, "utf8"));
      if (!owner) throw new Error(`managed hook manifest is missing: ${manifestPath}`);
      if (isLegacyManagedManifest(owner)) { legacyHookScopes.push(dir); staleHookScopes.push(dir); continue; }
      const configPath = join(dir, "hooks.json");
      const config = registered
        ? await readRegularJson(configPath)
        : JSON.parse(await readFile(configPath, "utf8"));
      if (!config) throw new Error(`managed hook configuration is missing: ${configPath}`);
      if (isHooksSkippedManifest(owner)) {
        // Coherent-and-non-firing: no runtime dir is expected, so it is
        // never pushed to hookStatuses (would count toward the overlap
        // dedupe check) OR staleHookScopes (would fail codex-hooks) --
        // unless its hooks.json still somehow carries a live Muster group
        // its own manifest no longer declares, which is genuine drift.
        const carriesMusterGroups = Object.values(config?.hooks || {}).some(groups => Array.isArray(groups) && groups.some(isMusterHookGroup));
        if (carriesMusterGroups) throw new Error(`canonical-scope-skipped hook manifest still carries a Muster hook group: ${configPath}`);
        continue;
      }
      const hookFiles = ["muster-hook.mjs", "action-guard.mjs"];
      const runtime = await Promise.all(hookFiles.map(file => registered
        ? readRegularFile(join(dir, "muster", "hooks", file))
        : readFile(join(dir, "muster", "hooks", file))));
      if (runtime.some(file => file === null)) throw new Error(`managed hook runtime is missing: ${dir}`);
      const hash = createHash("sha256");
      for (let index = 0; index < hookFiles.length; index++) hash.update(`hooks/${hookFiles[index]}`).update("\0").update(runtime[index]);
      const coherent = owner.owner === "muster" && ownsExactHookGroups(config, owner) && owner.packageVersion === selected?.packageVersion
        && owner.hookHash === hash.digest("hex");
      if (coherent) {
        hookStatuses.push(dir);
        // Persisted-interpreter capture (run-5 security audit Med #5): each
        // managed hook command now bakes an absolute, pinned Node interpreter
        // instead of a bare `node`. ownsExactHookGroups above already proves
        // hooks.json matches the ownership manifest byte-for-byte, so the live
        // command is authoritative -- read the interpreter Codex will actually
        // exec (POSIX `command`, or `commandWindows` on win32) and verify below
        // that the pinned file still exists. A vanished/replaced pinned node is
        // NOT caught by the coherence loop (the command still matches its
        // manifest; only the file it points at is gone), so it needs its own
        // check.
        const musterHook = Object.values(config.hooks).flat().filter(isMusterHookGroup)
          .flatMap(group => Array.isArray(group?.hooks) ? group.hooks : [])
          .find(hook => typeof (platform === "win32" ? hook?.commandWindows : hook?.command) === "string");
        const rawCommand = musterHook && (platform === "win32" ? musterHook.commandWindows : musterHook.command);
        const parsed = rawCommand ? parseHookCommand(rawCommand, { windows: platform === "win32" }) : null;
        if (parsed?.interpreter) hookInterpreters.push({ dir, interpreter: parsed.interpreter });
      } else staleHookScopes.push(dir);
    } catch { staleHookScopes.push(dir); }
  }
  const hookStatus = staleHookScopes.length === 0 ? hookStatuses[0] || null : null;
  const otherStaleHookScopes = staleHookScopes.filter(dir => !legacyHookScopes.includes(dir));
  const legacyHookDetail = legacyHookScopes.length ? legacyRemediation(legacyHookScopes) : null;
  checks.push({ name: "codex-hooks", ok: Boolean(hookStatus), detail: hookStatus
    ? `managed lifecycle hooks configured at ${hookStatus}; non-managed hooks require one-time trust review in /hooks`
    : [
        legacyHookDetail,
        otherStaleHookScopes.length ? `managed lifecycle hooks are stale or differ from their exact ownership manifest at ${otherStaleHookScopes.join(", ")}; rerun muster install codex for each scope` : null
      ].filter(Boolean).join("; ") || "managed Codex lifecycle hooks are not installed; run muster install codex for the intended project or user scope" });
  // The hook runtime itself has no cross-copy dedupe (each installed copy
  // independently emits its own event context; wave 1 removed the CODEX_HOME
  // bookkeeping that used to attempt it — see codex.test.js's "no cross-copy
  // dedupe" coverage). Dual live scopes therefore fire every advisory twice —
  // per the 2026-07-18 canonical-scope decision this is now an actionable
  // finding (user scope wins; collapse the duplicate), not an accepted state.
  checks.push({ name: "codex-hooks-overlap", ok: staleHookScopes.length === 0 && hookStatuses.length <= 1, detail: staleHookScopes.length
    ? [legacyHookDetail, otherStaleHookScopes.length ? "Project/user hook copies are not hash/exact-group coherent with their ownership manifest; refresh every stale scope" : null].filter(Boolean).join("; ")
    : hookStatuses.length > 1
    // codex-hook-scope-collapse: a project-scope REINSTALL under a healthy
    // user scope now auto-collapses the duplicate (prepareHooks'
    // userScopeHooksHealthy), so the remediation is a plain reinstall, not
    // only a manual uninstall.
    ? `Muster hooks fire from ${hookStatuses.length} scopes (${hookStatuses.join(", ")}) with no cross-copy dedupe -- every advisory is emitted ${hookStatuses.length}x per event; user scope is canonical, so rerun \`muster install codex --scope project\` in the duplicated project(s) to collapse to one`
    : "No project and user Muster hook overlap detected" });
  // codex-hook-interpreter (run-5 security audit Med #5): the pinned absolute
  // Node interpreter baked into each managed hook command must still exist as a
  // regular file. If the pinned node was removed or replaced (e.g. an nvm
  // version pruned), Codex would fail every hook fire; reinstalling re-pins the
  // current node. Only coherent scopes are inspected -- a stale scope is already
  // reported by codex-hooks, and its command may not even carry a pinned node.
  const missingInterpreters = [];
  for (const { dir, interpreter } of hookInterpreters) {
    let ok = false;
    try { ok = (await stat(interpreter)).isFile(); } catch { ok = false; }
    if (!ok) missingInterpreters.push({ dir, interpreter });
  }
  checks.push({ name: "codex-hook-interpreter", ok: missingInterpreters.length === 0, detail: missingInterpreters.length
    ? `the pinned Node interpreter baked into managed Codex hooks is missing or not a regular file: ${missingInterpreters.map(item => `${item.interpreter} (${item.dir})`).join(", ")}; rerun muster install codex to re-pin the current Node`
    : hookInterpreters.length
    ? `pinned Node interpreter present and a regular file for ${hookInterpreters.length} managed hook scope(s)`
    : "no managed Codex hook interpreter to verify" });
  // The installed plugin cache must be the hooks-free Codex flavor: Codex
  // >=0.144.5 fires a plugin's default hooks/hooks.json on every lifecycle
  // event, so a with-hooks (Claude-flavor) cache double-fires on top of the
  // scoped hooks.json install — the hook-bombardment regression (see
  // docs/research/codex-cli.md section 5.4).
  if (selected?.packageVersion) {
    const cacheHooksPath = join(userCodexHome, "plugins", "cache", "muster", "muster", selected.packageVersion, "hooks", "hooks.json");
    let cacheHookCount = null;
    try {
      const cacheHooks = JSON.parse(await readFile(cacheHooksPath, "utf8"));
      cacheHookCount = Object.values(cacheHooks?.hooks || {}).flat()
        .reduce((total, group) => total + (Array.isArray(group?.hooks) ? group.hooks.length : 0), 0);
    } catch { /* absent or unreadable cache hooks file = nothing fires from the plugin */ }
    checks.push({ name: "codex-plugin-cache-hooks", ok: !cacheHookCount, detail: cacheHookCount
      ? `installed muster plugin cache ships ${cacheHookCount} firing lifecycle hook(s) at ${cacheHooksPath} -- the with-hooks (Claude) plugin flavor, which double-fires on top of the scoped hooks.json install; rerun muster install codex to reinstall the hooks-free Codex plugin`
      : "installed muster plugin cache ships no lifecycle hooks (hooks-free Codex flavor)" });
  }
  checks.push({ name: "codex-policy-limitations", ok: true, detail: "Hooks provide lifecycle context, diagnostics, and supported policy warnings; todo and spawn enforcement remain advisory, and write-capable waves require isolated worktrees" });
  if (available) {
    const inventory = await readCodexInventory({ cwd, codexHome, execFile });
    const installed = inventory.plugins.includes("muster");
    checks.push({ name: "codex-plugin-installed", ok: installed, detail: installed ? "muster plugin is enabled in live Codex state" : "muster plugin is not installed; run muster install codex" });
    checks.push({ name: "codex-inventory", ok: true, detail: `${inventory.plugins.length} plugins, ${inventory.skills.length} skills, ${inventory.mcpServers.length} MCP servers, ${inventory.agents.length} agents from live Codex state` });
  }
  return { ok: checks.every(check => check.ok), target: "codex", checks };
}
