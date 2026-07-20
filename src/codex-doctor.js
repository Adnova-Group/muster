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
import { parseAgentProfileToml, resolveCodexPlugin } from "./codex-release.js";
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

// Owning-package identity of a win32 npm SHIM, resolved by FILE READ ONLY --
// never executing the shim or any candidate. npm installs a command on Windows
// as shim scripts (`muster.cmd`/`muster.ps1`/a bare Bourne `muster`) that WRAP
// the real JS entry under a sibling node_modules; the shim is a script, not a
// symlink, so realpath() returns the shim itself and packageIdentity's upward
// walk lands on the install prefix's package.json (absent/unrelated), never the
// package the shim wraps. Resolve the owner from the npm shim LAYOUT instead:
//   global prefix:  <prefix>/muster.cmd   -> <prefix>/node_modules/<pkg>/package.json
//   local .bin:     <nm>/.bin/muster.cmd  -> <nm>/<pkg>/package.json  (../<pkg> from .bin)
// where <pkg> is `@adnova-group/muster` (scoped) or `muster` (unscoped). Each
// candidate package.json is read through the SAME descriptor-pinned no-follow
// bounded reader (readRegularJson -> O_NOFOLLOW + fstat size bound) every other
// trust read uses: a symlink / oversized / non-regular / absent candidate
// yields no identity here (skip/return null) rather than a followed link or an
// allocation -- and, above all, no process is ever spawned. Returns a
// packageIdentity-shaped {root,name,version,bin} for the first resolvable
// owner, else null (the caller reports the shim present-but-unverified).
async function windowsShimOwnerIdentity(shimPath) {
  const shimDir = dirname(shimPath);
  // A local install's shim lives in `node_modules/.bin`; a global install's
  // shim lives directly in the install prefix beside its own `node_modules`.
  const nodeModules = parse(shimDir).base === ".bin" ? dirname(shimDir) : join(shimDir, "node_modules");
  for (const pkgName of [join("@adnova-group", "muster"), "muster"]) {
    const pkgRoot = join(nodeModules, pkgName);
    let parsed;
    try { parsed = await readRegularJson(join(pkgRoot, "package.json")); }
    catch (error) {
      // An ACTIVE fail-closed rejection of a PLANTED owning manifest (symlinked
      // / oversized / non-regular package.json, or a symlinked node_modules
      // ancestor) is surfaced by NAME rather than silently skipped -- it
      // propagates to checkPathShadow's outer catch, which fails OPEN (ok:true)
      // and names both the shim and the unsafe path per this check's doctrine.
      // A malformed-but-ordinary manifest (a plain JSON/parse error) is benign
      // and simply moves on to the next candidate.
      if (error?.musterUnsafeRead) throw error;
      continue;
    }
    if (!parsed) continue; // benign absence -> try the next package name
    const root = await realpath(pkgRoot).catch(() => pkgRoot);
    const binField = typeof parsed.bin === "string" ? parsed.bin : parsed.bin?.muster ?? null;
    return { root, name: parsed.name ?? null, version: parsed.version ?? null, bin: binField };
  }
  return null;
}

const PATH_SHADOW_REMEDIATION = "npm uninstall -g @adnova-group/muster / npm i -g @adnova-group/muster@latest";

export async function checkPathShadow({ env = process.env, platform = process.platform, ownModuleUrl = import.meta.url, spawnProcess = spawn } = {}) {
  const name = "codex-path-shadow";
  // NO-EXECUTION CONTRACT: `spawnProcess` is the child-process spawn capability
  // this check is handed but MUST NEVER invoke. The shadowing entry's owning
  // package version is established by FILE READ alone (realpath + the npm shim
  // LAYOUT via windowsShimOwnerIdentity, and packageIdentity for POSIX) -- the
  // shim (a .cmd/.ps1/script that could be attacker-planted on PATH) is never
  // run just to read a version. The seam is kept injectable so the contract is
  // provable by a spy asserting zero invocations (see
  // test/codex-path-shadow-windows-shim.test.js); it is intentionally never
  // called anywhere below.
  void spawnProcess;
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

    // 2) Otherwise compare the resolved target's owning-package identity. On
    //    win32 the PATH entry is an npm SHIM SCRIPT (muster.cmd/.ps1/bare
    //    Bourne shim), not a symlink to the real bin -- realpath returns the
    //    shim itself, so the generic upward walk lands on the install prefix's
    //    package.json (absent/unrelated), never the package the shim wraps.
    //    Resolve the owner from the npm shim LAYOUT by file read instead
    //    (windowsShimOwnerIdentity, zero execution), falling back to the
    //    generic walk for POSIX symlinks and any non-shim win32 layout so their
    //    behavior is unchanged.
    const target = (platform === "win32" ? await windowsShimOwnerIdentity(found) : null)
      ?? await packageIdentity(resolvedFound);
    if (target?.root && own?.root && target.root === own.root) {
      return { name, ok: true, detail: `PATH \`muster\` at ${found} is this running package` };
    }
    if (target && own && target.name === own.name && target.version != null && target.version === own.version) {
      return { name, ok: true, detail: `PATH \`muster\` at ${found} matches this package (${target.name}@${target.version})` };
    }

    // On win32, a shim whose owning package.json cannot be resolved by file
    // read is reported present-but-UNVERIFIED (ok:true, named) rather than
    // executed to read its version -- honoring the no-execution contract and
    // this check's fail-open doctrine. On POSIX, realpath already followed the
    // link to a real target, so a null target there is a genuine foreign
    // standalone binary and stays the shadow finding below.
    if (!target && platform === "win32") {
      return { name, ok: true, detail: `found a \`muster\` npm shim on PATH at ${found} but could not resolve its owning package.json by file read to verify its version; the shim was NOT executed -- if it is a stale global install, ${PATH_SHADOW_REMEDIATION} (or remove the shadow at ${found})` };
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
// A misbehaving or compromised MCP child could stream unbounded output into the
// doctor process (memory blowup) and get raw bytes echoed into a check detail.
// Retain at most these many decoded characters of the child's stdout (the
// JSON-RPC parse buffer) and stderr before we stop retaining and terminate the
// child. The real bundled handshake's largest single line is ~10 KB, so 64 KiB
// leaves ample headroom for well-behaved children while capping memory growth.
export const MCP_STDOUT_CAP = 64 * 1024;
export const MCP_STDERR_CAP = 64 * 1024;
// A much smaller, separate budget for how many characters of captured child
// output may EVER be echoed into a check `detail` -- after control/non-printable
// bytes are replaced -- so raw or oversized bytes are never dumped into the
// diagnostic even though up to the retention cap is held in memory.
export const MCP_DIAGNOSTIC_CAP = 512;
const mcpVisibilityNote = "Codex may defer MCP tool visibility until lookup or a new session";

// Bound and sanitize captured child output before it appears in a check detail:
// slice to the diagnostic-echo budget FIRST (so bytes beyond it are never
// processed or echoed), then replace C0/C1 control and DEL bytes with the
// Unicode replacement char so no raw control bytes are dumped into the detail.
function sanitizeMcpDiagnostic(text, limit = MCP_DIAGNOSTIC_CAP) {
  if (typeof text !== "string" || !text) return "";
  return text.slice(0, limit).replace(/[\u0000-\u001f\u007f-\u009f]/g, "\uFFFD").trim();
}

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

// Upper bound on a single trust-boundary scope file the doctor will read into
// memory. The largest managed file is the bundled hook runtime (~12 KB), so
// 1 MiB leaves ~85x headroom for every well-formed config.toml / hooks.json /
// managed marker / hook runtime while capping how much a hostile oversized file
// can force the reader to allocate. The size is checked via fstat on the held
// descriptor BEFORE the file's contents are read (see readRegularFile).
export const DOCTOR_READ_MAX_BYTES = 1024 * 1024;

// A separate, deliberately generous cap for CODEX_HOME/config.toml. Unlike the
// managed markers/hooks/runtime above, config.toml is USER/Codex-owned -- muster
// does not control its size, and its `[projects]`/`[hooks.state]` trust caches
// accumulate without pruning (see codex-hook-state below), so a long-lived
// install could legitimately grow well past the 1 MiB managed-file cap. Bounding
// it at 16 MiB still forecloses a hostile unbounded allocation while giving a
// genuinely large real config millions of bytes of headroom -- so hardening the
// read never newly fails codex-thread-limits/codex-hook-state on a well-formed
// (if large) config that previously read fine.
export const DOCTOR_CONFIG_READ_MAX_BYTES = 16 * 1024 * 1024;

// Tags a rejection thrown by the no-follow bounded reader (symlink, non-regular
// file, symlinked ancestor, TOCTOU dev/ino change, or oversize) so callers can
// distinguish an ACTIVE fail-closed rejection of an unsafe trust file from a
// benign absence (null) or a malformed-but-ordinary file (a plain parse error),
// and surface a per-scope diagnostic for the former without swallowing it.
function unsafeScopeRead(message) {
  const error = new Error(message);
  error.musterUnsafeRead = true;
  return error;
}

// A managed trust file that MUST exist is absent: readRegularJson/readRegularFile
// returned null (benign ENOENT/ENOTDIR) at a path the check requires. Tagged
// (`musterMissing`) and carrying the offending `path` so the shared cause
// classifier below reports MISSING with that exact path rather than folding it
// into a generic version/coherence mismatch.
function missingScopeFile(subject, path) {
  const error = new Error(`${subject} is missing: ${path}`);
  error.musterMissing = true;
  error.path = path;
  return error;
}

// The normalized per-scope failure vocabulary shared by the install-generation
// AND hook diagnostics, so the SAME underlying failure of a managed scope reads
// identically in both. An operator gets WHICH distinct thing failed WHERE, not a
// flattened "scope unhealthy": a MISSING managed file, MALFORMED JSON, an UNSAFE
// symlink/non-regular refusal, or a MISMATCH (present + parsed but incoherent
// with the expected package version / hook hash / owned groups). LEGACY (a
// pre-0.5.x manifest) keeps its own dedicated remediation and is not classified
// here.
const SCOPE_CAUSE = Object.freeze({
  MISSING: "MISSING",
  MALFORMED: "MALFORMED",
  UNSAFE: "UNSAFE",
  OTHER: "OTHER"
});

// One classifier mapping a caught trust-read error -> { cause, path } for the
// THROWING causes (MISSING / MALFORMED / UNSAFE / OTHER); MISMATCH is a
// non-throwing "present but incoherent" verdict the caller records directly.
// `fallbackPath` is the file the scope was reading when it threw, used when the
// error carries no path of its own (e.g. a bare JSON.parse SyntaxError). Both
// per-scope loops route their catch through this so the vocabulary stays shared.
function classifyScopeReadError(error, fallbackPath) {
  const path = typeof error?.path === "string" ? error.path : fallbackPath;
  if (error?.musterUnsafeRead) return { cause: SCOPE_CAUSE.UNSAFE, path };
  // The tagged `musterMissing` is the reachable MISSING signal today: the safe
  // reader converts ENOENT/ENOTDIR to a null return (see openRegularFile's
  // missingPath), which callers turn into a `missingScopeFile` throw. The raw
  // ENOENT/ENOTDIR arm is defensive only -- kept so any future direct fs throw
  // still classifies as MISSING rather than falling through to OTHER.
  if (error?.musterMissing || error?.code === "ENOENT" || error?.code === "ENOTDIR") return { cause: SCOPE_CAUSE.MISSING, path };
  if (error instanceof SyntaxError) return { cause: SCOPE_CAUSE.MALFORMED, path };
  return { cause: SCOPE_CAUSE.OTHER, path };
}

// Shared formatter: render the caught (non-mismatch, non-unsafe, non-legacy)
// per-scope failures into DISTINCT cause clauses naming the offending path, for
// either check (`noun` is "profile" or "hook"). Each cause gets its own clause
// so a missing file is never reported as malformed and vice versa, and the
// remediation (rerun muster install codex) is preserved on every clause.
function scopeCauseClauses(noun, failures) {
  const of = cause => failures.filter(item => item.cause === cause);
  const paths = list => list.map(item => item.path).join(", ");
  const missing = of(SCOPE_CAUSE.MISSING);
  const malformed = of(SCOPE_CAUSE.MALFORMED);
  const other = of(SCOPE_CAUSE.OTHER);
  return [
    missing.length ? `managed ${noun} file missing at: ${paths(missing)}; rerun muster install codex for each scope` : null,
    malformed.length ? `managed ${noun} file is malformed JSON at: ${paths(malformed)}; rerun muster install codex for each scope` : null,
    other.length ? `managed ${noun} scope unreadable at: ${other.map(item => `${item.path} (${item.message})`).join(", ")}; rerun muster install codex for each scope` : null
  ];
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
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw unsafeScopeRead(`Codex configuration ancestry must be an ordinary directory: ${current}`);
  }
  return true;
}

// Descriptor-pinned no-follow open + regular-file validation, factored so BOTH
// the bounded reader below and the content-free validator (assertRegularFilePresent)
// share ONE lstat + O_NOFOLLOW open + fstat dev/ino sequence -- no parallel copy.
// Returns null for a benign absence, the held descriptor + its fstat size for a
// present regular file, and throws a musterUnsafeRead for a symlink / non-regular
// / TOCTOU-changed target. The caller owns closing the returned descriptor.
async function openRegularFile(path) {
  if (!(await ordinaryDirectoryPath(dirname(path)))) return null;
  let before;
  try { before = await lstat(path); }
  catch (error) {
    if (missingPath(error)) return null;
    throw error;
  }
  if (before.isSymbolicLink() || !before.isFile()) throw unsafeScopeRead(`Codex configuration target must be a regular file: ${path}`);
  const handle = await open(path, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW || 0));
  try {
    const current = await handle.stat();
    if (!current.isFile() || current.dev !== before.dev || current.ino !== before.ino) throw unsafeScopeRead(`Codex configuration target changed while reading: ${path}`);
    return { handle, size: current.size };
  } catch (error) {
    await handle.close().catch(() => {});
    throw error;
  }
}

async function readRegularFile(path, encoding, maxBytes = DOCTOR_READ_MAX_BYTES) {
  const opened = await openRegularFile(path);
  if (opened === null) return null;
  const { handle, size } = opened;
  try {
    // Size-bound on the HELD descriptor before any read: a hostile oversized
    // file is rejected without ever allocating its contents.
    if (size > maxBytes) throw unsafeScopeRead(`Codex configuration target exceeds the ${maxBytes}-byte read cap (${size} bytes): ${path}`);
    return handle.readFile(encoding);
  } finally {
    await handle.close().catch(() => {});
  }
}

// Regular-file validation WITHOUT reading the file: reuses openRegularFile's
// lstat + O_NOFOLLOW + fstat machinery to prove `path` is a real regular file
// (rejecting a symlink/dir/FIFO exactly as readRegularFile does), then closes
// the descriptor without allocating the file -- so an arbitrarily large bundled
// runtime is validated without a read cap. Returns true for a present regular
// file, false for a benign absence, and throws the same musterUnsafeRead a
// non-regular/symlinked target raises.
async function assertRegularFilePresent(path) {
  const opened = await openRegularFile(path);
  if (opened === null) return false;
  await opened.handle.close().catch(() => {});
  return true;
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
    let killed = false, stdoutCapped = false, stderrCapped = false;
    // Terminate the child EXACTLY once. A cap hit, the terminal finish(), a
    // second cap hit on the other stream, or a close/exit event may each reach
    // here; the `killed` guard makes every call after the first a no-op, and
    // kill is best-effort so it never throws back into an event handler.
    const terminateChild = () => {
      if (killed) return;
      killed = true;
      try { if (child && !child.killed) child.kill(); } catch { /* kill is best-effort */ }
    };
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      let cleanupError = null;
      try { if (child?.stdin && !child.stdin.destroyed) child.stdin.end(); } catch (failure) { cleanupError = failure; }
      terminateChild();
      if (error) reject(error); else if (cleanupError) reject(cleanupError); else resolve(result);
    };
    const fail = message => finish(message instanceof Error ? message : new Error(message));
    // Shared cap handler: truncate the retained buffer to its cap, terminate the
    // child once, and reject with a bounded, sanitized diagnostic that names the
    // stream and carries the retained size (so callers/tests can prove the bound
    // held) -- never echoing beyond the diagnostic budget or raw control bytes.
    const failCapped = (streamName, retainedLength, echo = "") => {
      const detail = sanitizeMcpDiagnostic(echo);
      const cap = streamName === "stdout" ? MCP_STDOUT_CAP : MCP_STDERR_CAP;
      const error = new Error(`MCP ${streamName} exceeded the ${cap}-character retention cap; terminated the handshake child${detail ? `: ${detail}` : ""}`);
      error.mcpStream = streamName;
      error.mcpRetainedChars = retainedLength;
      terminateChild();
      fail(error);
    };
    try {
      child = spawnProcess(process.execPath, [entrypoint], { cwd, stdio: ["pipe", "pipe", "pipe"] });
    } catch (error) { fail(error); return; }
    if (!child?.stdin || !child?.stdout || !child?.stderr) { fail("MCP process did not expose stdio"); return; }
    timer = setTimeout(() => fail(`MCP initialize/tools/list/tools/call timed out after ${timeoutMs}ms`), timeoutMs);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", chunk => {
      if (settled || stdoutCapped) return;
      buffer += chunk;
      // A well-behaved child's JSON-RPC lines are consumed below as fast as they
      // arrive, so `buffer` only ever holds one in-flight line and never nears
      // the cap. Unbounded newline-free output (a misbehaving/compromised child)
      // is what grows it without bound -- cap it, stop retaining, and kill.
      // The cap check precedes the parse loop, so if one `data` event delivered a
      // complete line AND enough trailing bytes to blow the cap, that line is
      // discarded rather than parsed -- an intentional fail-closed tradeoff: a
      // child flooding this hard is already outside the well-behaved contract.
      if (buffer.length > MCP_STDOUT_CAP) {
        buffer = buffer.slice(0, MCP_STDOUT_CAP);
        stdoutCapped = true;
        // Do not echo raw stdout into the diagnostic; naming the cap is enough.
        failCapped("stdout", buffer.length);
        return;
      }
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
          if (!toolCallOk) { fail(`MCP tools/call muster_detect returned an error payload: ${sanitizeMcpDiagnostic(String(text), 160)}`); return; }
          finish(null, { initialized, tools, toolCallOk });
          return;
        }
      }
    });
    child.stdout.on("error", error => fail(error));
    child.stderr.on("data", chunk => {
      if (settled || stderrCapped) return;
      stderr += chunk;
      if (stderr.length > MCP_STDERR_CAP) {
        stderr = stderr.slice(0, MCP_STDERR_CAP);
        stderrCapped = true;
        failCapped("stderr", stderr.length, stderr);
        return;
      }
    });
    child.stderr.on("error", error => fail(error));
    child.on("error", error => fail(error));
    child.on("exit", (code, signal) => {
      if (settled) return;
      const detail = sanitizeMcpDiagnostic(stderr);
      fail(`MCP process exited before the handshake completed (${signal || code || "unknown"})${detail ? `: ${detail}` : ""}`);
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

export async function runCodexDoctor({ root, cwd = process.cwd(), codexHome, execFile, mcpRunner = runMcpHandshake, env = process.env, platform = process.platform, readConfigToml = path => readRegularFile(path, "utf8", DOCTOR_CONFIG_READ_MAX_BYTES) } = {}) {
  const base = root instanceof URL ? fileURLToPath(root) : (root || process.cwd());
  // The npm CLI runs from the package root; the bundled runtime runs from the
  // plugin root itself. Support both layouts without requiring npm at runtime.
  const isPluginRoot = await exists(join(base, ".codex-plugin", "plugin.json"));
  let selected = null;
  let selectionError = null;
  if (isPluginRoot) {
    try {
      const pkg = JSON.parse(await readFile(join(base, "package.json"), "utf8"));
      selected = { packageVersion: pkg.version, pluginRoot: base, profilesRoot: join(base, "agents") };
    } catch { /* a plugin-root layout is already the selected tree; a malformed package.json is reported by the plugin checks below, not a selection failure */ }
  } else {
    // resolveCodexPlugin reads the marketplace pointer through the SAME
    // descriptor-pinned no-follow safe reader used elsewhere; an
    // invalid/missing/malformed pointer makes it throw and leaves `selected`
    // null. Capture that throw (do not add a parallel pointer read) so the
    // selection failure can be named explicitly below.
    try { selected = await resolveCodexPlugin(base); }
    catch (error) { selectionError = error; }
  }
  // Plugin SELECTION failure: only the non-plugin-root path resolves the
  // authoritative "which plugin tree is selected" answer through the marketplace
  // pointer. When that fails, no plugin can be authoritatively selected, and the
  // old code silently fell back to diagnosing `<base>/.agents/plugins/plugin`
  // anyway -- emitting healthy-looking plugin/agent/runtime/version checks about
  // an UNSELECTED tree Codex isn't actually using. Instead, fail an explicit
  // codex-plugin-selection check and refuse to green-light any fallback tree.
  const selectionFailed = !isPluginRoot && !selected;
  const plugin = isPluginRoot ? base : (selected?.pluginRoot || join(base, ".agents", "plugins", "plugin"));
  const selectionSkip = subject => `Codex plugin selection failed; ${subject} not diagnosed (see codex-plugin-selection)`;
  const checks = [];
  const available = await codexAvailable({ execFile });
  checks.push({ name: "codex-cli", ok: available, detail: available ? "codex detected on PATH" : "codex not found — profiles can be installed, plugin registration is skipped" });
  checks.push(await checkPathShadow({ env, platform }));
  if (selectionFailed) {
    checks.push({ name: "codex-plugin-selection", ok: false, detail: `could not select which Muster plugin Codex uses from the marketplace pointer under ${join(base, ".agents", "plugins")}: ${selectionError?.message || "invalid or missing marketplace pointer"}; downstream plugin/agent/runtime/version checks are not diagnosed against any unselected fallback tree -- rerun muster install codex / build:codex to regenerate a valid pointer` });
  }
  // The three checks below (and the version/handshake checks further down) draw
  // health conclusions from `plugin` -- the SELECTED tree. When selection failed
  // `plugin` is only an unconfirmed fallback path, so they are skipped (reported
  // ok:false, "not diagnosed") rather than green-lighting a tree Codex may not
  // be using. When selection SUCCEEDS they run exactly as before.
  if (selectionFailed) {
    checks.push({ name: "codex-plugin", ok: false, detail: selectionSkip("the plugin manifest was") });
  } else {
    // Both trust-boundary plugin descriptors are read through the SAME
    // descriptor-pinned no-follow bounded reader (readRegularJson -> readRegularFile,
    // O_NOFOLLOW + fstat size bound at DOCTOR_READ_MAX_BYTES) the scope reads use:
    // a symlink / non-regular / oversized / symlinked-ancestor file throws a
    // musterUnsafeRead the catch surfaces as a clear fail-closed diagnostic --
    // never following the link to its target or allocating the oversized file --
    // and a benign absence returns null so it is named as missing, not an opaque
    // null-deref. A well-formed manifest/package.json reads and validates identically.
    const manifestPath = join(plugin, ".codex-plugin", "plugin.json");
    const pkgPath = join(plugin, "package.json");
    try {
      const [manifest, pkg] = await Promise.all([readRegularJson(manifestPath), readRegularJson(pkgPath)]);
      if (!manifest) throw new Error(`plugin manifest is missing: ${manifestPath}`);
      if (!pkg) throw new Error(`plugin package descriptor is missing: ${pkgPath}`);
      checks.push({ name: "codex-plugin", ok: manifest.name === "muster" && manifest.version === pkg.version, detail: `muster ${manifest.version || "unknown"}` });
    } catch (error) { checks.push({ name: "codex-plugin", ok: false, detail: error.message }); }
  }
  if (selectionFailed) {
    checks.push({ name: "codex-agents", ok: false, detail: selectionSkip("generated agent profiles were") });
  } else {
    try {
      const profileDir = isPluginRoot ? join(plugin, "agents") : selected.profilesRoot;
      const files = (await readdir(profileDir)).filter(name => name.endsWith(".toml"));
      // A `.toml` SUFFIX COUNT alone let a directory named `*.toml` or a malformed
      // profile count toward the total. Validate each counted profile is a REGULAR
      // FILE (via the same no-follow safe reader used everywhere else -- a dir /
      // symlink / FIFO throws a musterUnsafeRead) AND parses as the restricted
      // profile TOML the generator emits; either failure drops it from a healthy
      // verdict rather than silently counting.
      const malformed = [];
      for (const file of files) {
        try {
          const text = await readRegularFile(join(profileDir, file), "utf8");
          if (text === null) { malformed.push(`${file} (vanished)`); continue; }
          parseAgentProfileToml(text);
        } catch (error) { malformed.push(`${file} (${error.message})`); }
      }
      const ok = files.length === CODEX_COUNTS.agents && malformed.length === 0;
      checks.push({ name: "codex-agents", ok, detail: malformed.length
        ? `${files.length}/${CODEX_COUNTS.agents} generated profiles; ${malformed.length} not a well-formed profile: ${malformed.join(", ")}`
        : `${files.length}/${CODEX_COUNTS.agents} generated profiles` });
    } catch (error) { checks.push({ name: "codex-agents", ok: false, detail: error.message }); }
  }
  if (selectionFailed) {
    checks.push({ name: "codex-runtime", ok: false, detail: selectionSkip("the bundled runtime and MCP entrypoint were") });
  } else {
    // Mere PATH EXISTENCE passed a non-regular entry (symlink / dir / FIFO) and a
    // malformed `.mcp.json`. Validate each bundled runtime artifact is a REGULAR
    // FILE via the same no-follow safe reader (assertRegularFilePresent -- fstat
    // regular-file check, no content read for the large bundles), and PARSE the
    // MCP entrypoint JSON it is supposed to be; either failure fails codex-runtime.
    const problems = [];
    for (const item of ["runtime/muster.mjs", "runtime/muster-mcp.mjs"]) {
      try { if (!(await assertRegularFilePresent(join(plugin, item)))) problems.push(`${item} (missing)`); }
      catch (error) { problems.push(`${item} (${error.message})`); }
    }
    try { if ((await readRegularJson(join(plugin, ".mcp.json"))) === null) problems.push(".mcp.json (missing)"); }
    catch (error) { problems.push(`.mcp.json (${error.message})`); }
    checks.push({ name: "codex-runtime", ok: problems.length === 0, detail: problems.length
      ? `malformed or non-regular runtime artifacts: ${problems.join(", ")}`
      : "bundled runtime and MCP entrypoint present" });
  }
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
  // The handshake spawns `plugin`'s bundled MCP entrypoint -- a runtime claim
  // about the SELECTED tree. On selection failure `plugin` is unconfirmed, so
  // skip the handshake rather than green-light an unselected runtime.
  if (selectionFailed) {
    checks.push({ name: "codex-mcp-handshake", ok: false, detail: `${selectionSkip("the bundled MCP handshake was")}; ${mcpVisibilityNote}` });
  } else try {
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
    const unsafeProfileScopes = [];
    // Caught, NON-unsafe per-scope read failures normalized to a distinct cause
    // + the offending path (MISSING / MALFORMED / OTHER), so a missing manifest
    // is no longer misreported as a version mismatch. A present-but-incoherent
    // manifest stays a version MISMATCH via `installations` below; aggregate
    // health is computed from the same failing sets as before -- these records
    // only ENRICH the detail, they never change a verdict.
    const profileFailures = [];
    for (const dir of hookHomes) {
      const registered = scopeHomes.get(dir);
      const manifestPath = join(dir, "agents", ".muster-managed.json");
      // Every scope -- registered AND unregistered current-project/user --
      // reads its managed profile marker through the same no-follow bounded
      // reader (readRegularJson): null = benign absence (surfaced as a tagged
      // MISSING error), a musterUnsafeRead throw = an ACTIVE fail-closed
      // rejection (symlink / special / oversized / symlinked ancestor), a plain
      // JSON.parse throw = MALFORMED -- each classified to its distinct cause.
      try {
        const owner = await readRegularJson(manifestPath);
        if (!owner) throw missingScopeFile("managed profile manifest", manifestPath);
        installations.push({ dir, ok: owner.owner === "muster" && owner.packageVersion === selected.packageVersion, legacy: isLegacyManagedManifest(owner) });
      } catch (error) {
        const { cause, path } = classifyScopeReadError(error, manifestPath);
        if (cause === SCOPE_CAUSE.UNSAFE) unsafeProfileScopes.push({ dir, reason: error.message });
        else if (registered) profileFailures.push({ dir, cause, path, message: error.message });
        // Unregistered + benign (absent/malformed): stay silent, as before.
      }
    }
    const stale = installations.filter(item => !item.ok);
    const legacyStale = stale.filter(item => item.legacy).map(item => item.dir);
    const versionStale = stale.filter(item => !item.legacy).map(item => item.dir);
    const matched = installations.filter(item => item.ok).map(item => item.dir);
    // ok:false whenever ANY scope fails for ANY cause; each failing scope is
    // counted in exactly one bucket (legacy / version-mismatch / caught-cause /
    // unsafe), so no cross-scope masking or double-count.
    const ok = stale.length === 0 && unsafeProfileScopes.length === 0 && profileFailures.length === 0;
    checks.push({ name: "codex-install-generation", ok, detail: ok
      ? (matched.length ? `${matched.length} managed scope(s) match package version ${selected.packageVersion}` : "no managed profile scopes detected")
      : [
          // Surface the healthy count even on failure so an operator sees the
          // other scopes are still counted correctly, not masked by the failure.
          matched.length ? `${matched.length} managed scope(s) match package version ${selected.packageVersion}` : null,
          legacyStale.length ? legacyRemediation(legacyStale) : null,
          versionStale.length ? `installed profiles do not match the selected package version at: ${versionStale.join(", ")}; rerun muster install codex` : null,
          ...scopeCauseClauses("profile", profileFailures),
          unsafeProfileScopes.length ? `unsafe managed profile scope read rejected: ${unsafeProfileScopes.map(item => `${item.dir} (${item.reason})`).join(", ")}` : null
        ].filter(Boolean).join("; ") });
  } else if (selectionFailed) {
    // No selected package version to compare installed profiles against, so this
    // version claim is not diagnosed rather than silently omitted -- it must
    // never report ok:true about a tree that was never confirmed as selected.
    checks.push({ name: "codex-install-generation", ok: false, detail: selectionSkip("installed profile package versions were") });
  }
  const hookStatuses = [];
  const staleHookScopes = [];
  const legacyHookScopes = [];
  const unsafeHookScopes = [];
  const hookInterpreters = [];
  // A present-but-incoherent scope (owner/version/groups/hash MISMATCH) with the
  // specific offending path (the runtime dir for a hash mismatch, else the
  // manifest); and the caught MISSING/MALFORMED/OTHER failures with their paths.
  // These ONLY enrich the codex-hooks detail -- staleHookScopes below still
  // drives aggregate health exactly as before, so no verdict/count changes.
  const mismatchHookScopes = [];
  const hookCauseFailures = [];
  for (const dir of hookHomes) {
    const manifestPath = join(dir, "muster", ".muster-managed.json");
    const registered = scopeHomes.get(dir);
    if (!registered && !(await exists(manifestPath))) continue;
    // Every scope -- registered AND unregistered current-project/user -- reads
    // its hook manifest, hooks.json, and hook runtime through the same
    // no-follow bounded reader (readRegularJson/readRegularFile). A
    // musterUnsafeRead throw (symlink / special / oversized / symlinked
    // ancestor), a benign-absence MISSING throw, and a MALFORMED JSON parse
    // throw are each classified to their distinct cause below; `readingPath`
    // tracks which managed file was in hand so the cause names the right path.
    let readingPath = manifestPath;
    try {
      const owner = await readRegularJson(manifestPath);
      if (!owner) throw missingScopeFile("managed hook manifest", manifestPath);
      if (isLegacyManagedManifest(owner)) { legacyHookScopes.push(dir); staleHookScopes.push(dir); continue; }
      const configPath = join(dir, "hooks.json");
      readingPath = configPath;
      const config = await readRegularJson(configPath);
      if (!config) throw missingScopeFile("managed hook configuration", configPath);
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
      const runtimeDir = join(dir, "muster", "hooks");
      readingPath = runtimeDir;
      const runtime = await Promise.all(hookFiles.map(file => readRegularFile(join(runtimeDir, file))));
      if (runtime.some(file => file === null)) throw missingScopeFile("managed hook runtime", runtimeDir);
      const hash = createHash("sha256");
      for (let index = 0; index < hookFiles.length; index++) hash.update(`hooks/${hookFiles[index]}`).update("\0").update(runtime[index]);
      const digest = hash.digest("hex");
      const coherent = owner.owner === "muster" && ownsExactHookGroups(config, owner) && owner.packageVersion === selected?.packageVersion
        && owner.hookHash === digest;
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
      } else {
        staleHookScopes.push(dir);
        // Present + parsed but not coherent: a MISMATCH. Name the runtime dir
        // when the managed runtime's sha differs (a HASH MISMATCH), else the
        // manifest (a version/owned-group mismatch).
        mismatchHookScopes.push({ dir, path: owner.hookHash !== digest ? runtimeDir : manifestPath });
      }
    } catch (error) {
      const { cause, path } = classifyScopeReadError(error, readingPath);
      if (cause === SCOPE_CAUSE.UNSAFE) { unsafeHookScopes.push({ dir, reason: error.message }); continue; }
      // Still count the scope as stale for aggregate health (unchanged), and
      // record its DISTINCT cause + path for the enriched detail below.
      staleHookScopes.push(dir);
      hookCauseFailures.push({ dir, cause, path, message: error.message });
    }
  }
  const hookStatus = staleHookScopes.length === 0 ? hookStatuses[0] || null : null;
  const otherStaleHookScopes = staleHookScopes.filter(dir => !legacyHookScopes.includes(dir));
  const legacyHookDetail = legacyHookScopes.length ? legacyRemediation(legacyHookScopes) : null;
  const unsafeHookDetail = unsafeHookScopes.length ? `unsafe managed hook scope read rejected: ${unsafeHookScopes.map(item => `${item.dir} (${item.reason})`).join(", ")}` : null;
  const hooksOk = Boolean(hookStatus) && unsafeHookScopes.length === 0;
  // Each non-legacy stale scope appears in exactly one clause: MISMATCH scopes
  // in the stale/differ clause (naming the runtime/manifest path), and the
  // caught MISSING/MALFORMED/OTHER scopes in their own cause clauses -- so a
  // missing hooks.json is never also reported as a hash/coherence mismatch.
  checks.push({ name: "codex-hooks", ok: hooksOk, detail: hooksOk
    ? `managed lifecycle hooks configured at ${hookStatus}; non-managed hooks require one-time trust review in /hooks`
    : [
        legacyHookDetail,
        mismatchHookScopes.length ? `managed lifecycle hooks are stale or differ from their exact ownership manifest at ${mismatchHookScopes.map(item => `${item.dir} (${item.path})`).join(", ")}; rerun muster install codex for each scope` : null,
        ...scopeCauseClauses("hook", hookCauseFailures),
        unsafeHookDetail
      ].filter(Boolean).join("; ") || "managed Codex lifecycle hooks are not installed; run muster install codex for the intended project or user scope" });
  // The hook runtime itself has no cross-copy dedupe (each installed copy
  // independently emits its own event context; wave 1 removed the CODEX_HOME
  // bookkeeping that used to attempt it — see codex.test.js's "no cross-copy
  // dedupe" coverage). Dual live scopes therefore fire every advisory twice —
  // per the 2026-07-18 canonical-scope decision this is now an actionable
  // finding (user scope wins; collapse the duplicate), not an accepted state.
  checks.push({ name: "codex-hooks-overlap", ok: staleHookScopes.length === 0 && unsafeHookScopes.length === 0 && hookStatuses.length <= 1, detail: (staleHookScopes.length || unsafeHookScopes.length)
    ? [legacyHookDetail, otherStaleHookScopes.length ? "Project/user hook copies are not hash/exact-group coherent with their ownership manifest; refresh every stale scope" : null, unsafeHookDetail].filter(Boolean).join("; ")
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
    let unsafeCacheRead = null;
    try {
      // Read the installed cache's hooks.json through the SAME no-follow bounded
      // reader (readRegularJson -> readRegularFile, O_NOFOLLOW + fstat size bound at
      // DOCTOR_READ_MAX_BYTES) the scope reads use. A symlink / non-regular /
      // oversized / symlinked-ancestor file throws a musterUnsafeRead we surface as
      // an ACTIVE fail-closed rejection below -- never following the link to its
      // target or allocating the oversized file. A benign absence returns null
      // (nothing fires), and a malformed-but-ordinary hooks.json stays swallowed as
      // "unreadable = nothing fires" exactly as before; only the unsafe-read verdict
      // is new (the raw read used to swallow a followed symlink / oversized file too).
      const cacheHooks = await readRegularJson(cacheHooksPath);
      cacheHookCount = Object.values(cacheHooks?.hooks || {}).flat()
        .reduce((total, group) => total + (Array.isArray(group?.hooks) ? group.hooks.length : 0), 0);
    } catch (error) {
      if (error?.musterUnsafeRead) unsafeCacheRead = error;
      /* else: absent or unreadable cache hooks file = nothing fires from the plugin */
    }
    checks.push({ name: "codex-plugin-cache-hooks", ok: !cacheHookCount && !unsafeCacheRead, detail: unsafeCacheRead
      ? `refused to read the installed muster plugin cache hooks at ${cacheHooksPath}: ${unsafeCacheRead.message}; rerun muster install codex to reinstall the hooks-free Codex plugin`
      : cacheHookCount
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
