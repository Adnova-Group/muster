import { constants as fsConstants } from "node:fs";
import { link, lstat, mkdir, open, readFile, readdir, realpath, rename, rmdir, stat, unlink } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { exists, readdirSafe } from "./fs-util.js";
import { atomicWrite } from "./fs-safe.js";
import { basename, dirname, isAbsolute, join, parse, posix, relative, resolve, sep, win32 } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { execFile as execFileCb } from "node:child_process";
import { spawn } from "node:child_process";
import { promisify } from "node:util";
import { codexAvailable } from "./codex-inventory.js";
import { codexMcpOverlay, resolveCodexRuntimeIdentity, runCodexCommand } from "./codex-runtime-identity.js";
import { escapeRe } from "./keyword.js";
import { generateCodexProfiles } from "./codex-release.js";
import { processAlive, processStartIdentity } from "./codex-lock.js";
import {
  CODEX_THREAD_LIMIT_REMEDIATION,
  REQUIRED_CODEX_THREAD_LIMITS,
  codexThreadLimitConfigPath,
  codexThreadLimitManifestPath,
  ensureCodexThreadLimits,
  restoreCodexThreadLimits
} from "./codex-thread-limits.js";

const execFileDefault = promisify(execFileCb);
export const CODEX_MARKETPLACE = "Adnova-Group/muster";
export const CODEX_PLUGIN = "muster@muster";
const MANIFEST = ".muster-managed.json";
const PROFILE_FILENAME = /^[a-z0-9]+(?:-[a-z0-9]+)*\.toml$/;
const HOOK_FILES = ["hooks/muster-hook.mjs", "hooks/action-guard.mjs"];
const SCOPE_LOCK_STALE_MS = 5 * 60_000;
const SCOPE_LOCK_MAX_STALE_MS = 15 * 60_000;
const AGENT_DECLARATIONS_START = "# >>> muster managed agent declarations >>>";
const AGENT_DECLARATIONS_END = "# <<< muster managed agent declarations <<<";

const codexHome = home => process.env.CODEX_HOME || join(home, ".codex");
const agentsDir = (scope, cwd, home) => scope === "user" ? join(codexHome(home), "agents") : join(cwd, ".codex", "agents");
const configDir = (scope, cwd, home) => scope === "user" ? codexHome(home) : join(cwd, ".codex");
const scopeRegistryPath = home => join(codexHome(home), "muster", "install-scopes.json");
const scopeRegistryLockPath = home => `${scopeRegistryPath(home)}.lock`;
export async function codexProjectRoot(cwd) {
  const invocationRoot = resolve(cwd);
  try {
    const { stdout } = await execFileDefault("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd: invocationRoot });
    const lines = String(stdout).trim().split(/\r?\n/);
    if (lines.length !== 1 || !isAbsolute(lines[0])) return invocationRoot;
    const commonDir = resolve(lines[0]);
    if (basename(commonDir) !== ".git" || !(await stat(commonDir)).isDirectory()) return invocationRoot;
    return dirname(commonDir);
  } catch {
    return invocationRoot;
  }
}
export async function codexInvocationRoot(cwd) {
  const invocationCwd = resolve(cwd);
  try {
    const { stdout } = await execFileDefault("git", ["rev-parse", "--path-format=absolute", "--show-toplevel"], { cwd: invocationCwd });
    const lines = String(stdout).trim().split(/\r?\n/);
    if (lines.length !== 1 || !isAbsolute(lines[0])) return invocationCwd;
    const root = resolve(lines[0]);
    const rel = relative(root, invocationCwd);
    return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`)) ? root : invocationCwd;
  } catch {
    return invocationCwd;
  }
}

export async function codexInvocationConfigDirs(cwd) {
  const invocationCwd = resolve(cwd), root = await codexInvocationRoot(invocationCwd);
  const dirs = [join(root, ".codex")];
  let current = root;
  for (const part of relative(root, invocationCwd).split(sep).filter(Boolean)) {
    current = join(current, part);
    dirs.push(join(current, ".codex"));
  }
  return [...new Set(dirs)];
}

export async function codexActivationConfigDirs(commonRoot, invocationCwd) {
  const invocationRoot = await codexInvocationRoot(invocationCwd);
  const relativeParts = relative(invocationRoot, resolve(invocationCwd)).split(sep).filter(Boolean);
  const dirs = [];
  for (const root of [resolve(commonRoot), invocationRoot]) {
    let current = root;
    dirs.push(join(current, ".codex"));
    for (const part of relativeParts) {
      current = join(current, part);
      dirs.push(join(current, ".codex"));
    }
  }
  return [...new Set(dirs)];
}
async function ordinaryDirectoryPath(path, { create = false } = {}) {
  const absolute = resolve(path), root = parse(absolute).root;
  let current = root;
  for (const part of relative(root, absolute).split(sep).filter(Boolean)) {
    current = join(current, part);
    let stat;
    try { stat = await lstat(current); }
    catch (error) {
      if (error.code !== "ENOENT") throw error;
      if (!create) return false;
      try { await mkdir(current, { mode: 0o700 }); }
      catch (mkdirError) { if (mkdirError.code !== "EEXIST") throw mkdirError; }
      stat = await lstat(current);
    }
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`Codex configuration ancestry must be an ordinary directory: ${current}`);
  }
  return true;
}

async function regularFileState(path) {
  await ordinaryDirectoryPath(dirname(path));
  let stat;
  try { stat = await lstat(path); }
  catch (error) { if (error.code === "ENOENT") return null; throw error; }
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(`Codex configuration target must be a regular file: ${path}`);
  return stat;
}

async function safeExists(path) { return Boolean(await regularFileState(path)); }
async function readSafe(path, encoding = "utf8") {
  if (!(await regularFileState(path))) throw new Error(`Codex configuration file is missing: ${path}`);
  return readFile(path, encoding);
}
async function ownershipFileSnapshot(path) {
  if (!(await regularFileState(path))) return { exists: false, bytes: null };
  return { exists: true, bytes: await readFile(path) };
}
async function physicalFileSnapshot(path) {
  await ordinaryDirectoryPath(dirname(path));
  let handle;
  try { handle = await open(path, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW || 0)); }
  catch (error) { if (error.code === "ENOENT") return { exists: false, dev: null, ino: null, bytes: null }; throw error; }
  try {
    const before = await handle.stat();
    if (!before.isFile()) throw new Error(`Codex configuration target must be a regular file: ${path}`);
    const bytes = await handle.readFile();
    const after = await handle.stat();
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size) {
      throw new Error(`Codex hook activation file changed while being read: ${path}`);
    }
    return { exists: true, dev: String(after.dev), ino: String(after.ino), bytes };
  } finally { await handle.close(); }
}
function samePhysicalFile(left, right) {
  if (left.unsafe || right.unsafe) return left.unsafe === true && right.unsafe === true
    && left.code === right.code && left.message === right.message;
  return left.exists === right.exists && left.dev === right.dev && left.ino === right.ino
    && (!left.exists || left.bytes.equals(right.bytes));
}
async function physicalFilesSnapshot(paths) {
  const snapshot = new Map();
  for (const path of paths) snapshot.set(path, await physicalFileSnapshot(path));
  return snapshot;
}
function samePhysicalFilesSnapshot(left, right) {
  if (left.size !== right.size) return false;
  for (const [path, expected] of left) {
    const current = right.get(path);
    if (!current || !samePhysicalFile(expected, current)) return false;
  }
  return true;
}
async function activationFileSnapshot(path) {
  try { return await physicalFileSnapshot(path); }
  catch (error) { return { unsafe: true, code: error.code || null, message: error.message }; }
}
async function activationDirectorySnapshot(path) {
  try {
    const metadata = await lstat(path);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error(`Codex activation directory must be an ordinary directory: ${path}`);
    return { exists: true, dev: String(metadata.dev), ino: String(metadata.ino), bytes: Buffer.alloc(0) };
  } catch (error) {
    if (error.code === "ENOENT") return { exists: false, dev: null, ino: null, bytes: null };
    return { unsafe: true, code: error.code || null, message: error.message };
  }
}
async function declarationOwnershipSnapshot(manifestPath, configPath) {
  const [manifest, config] = await Promise.all([
    ownershipFileSnapshot(manifestPath),
    ownershipFileSnapshot(configPath)
  ]);
  return { manifest, config };
}
function ownershipSnapshotText(file) {
  return file.exists ? file.bytes.toString("utf8") : "";
}
function ownershipSnapshotManifest(file) {
  if (!file.exists) return null;
  try { return JSON.parse(file.bytes.toString("utf8")); }
  catch { return null; }
}
function sameOwnershipFile(left, right) {
  return left.exists === right.exists
    && (!left.exists || left.bytes.equals(right.bytes));
}
async function verifyDeclarationOwnershipSnapshot(expected, manifestPath, configPath) {
  const current = await declarationOwnershipSnapshot(manifestPath, configPath);
  if (!sameOwnershipFile(expected.manifest, current.manifest)
    || !sameOwnershipFile(expected.config, current.config)) {
    throw new Error("Codex agent declaration concurrent state change detected; no installation state was modified.");
  }
  return current;
}
const readJson = async path => { try { return JSON.parse(await readSafe(path, "utf8")); } catch (error) {
  if (/symlink|ordinary|regular/i.test(error.message)) throw error;
  return null;
} };

function validateScopeRegistry(path, registry) {
  if (registry?.format !== 1 || registry.owner !== "muster" || !Array.isArray(registry.entries)) {
    throw new Error(`Codex managed-scope registry ownership is invalid: ${path}`);
  }
  const entries = [], seen = new Set();
  for (const entry of registry.entries) {
    if (!entry || !["project", "user"].includes(entry.scope) || typeof entry.configDir !== "string" || !isAbsolute(entry.configDir)) {
      throw new Error(`Codex managed-scope registry has an invalid entry: ${path}`);
    }
    const key = `${entry.scope}:${entry.configDir}`;
    if (seen.has(key)) throw new Error(`Codex managed-scope registry has a duplicate entry: ${path}`);
    seen.add(key); entries.push({ scope: entry.scope, configDir: entry.configDir });
  }
  return entries;
}

async function readScopeRegistry(home) {
  const path = scopeRegistryPath(home), present = await safeExists(path);
  if (!present) return { path, present: false, entries: [] };
  const registry = await readJson(path);
  return { path, present: true, entries: validateScopeRegistry(path, registry) };
}

export async function hookActivationSnapshot({ home, cwd, inventoryCwd = cwd, userCodexHome = codexHome(home) }) {
  const registryPath = join(userCodexHome, "muster", "install-scopes.json");
  let registryFile = await activationFileSnapshot(registryPath);
  let entries = [];
  if (!registryFile.unsafe && registryFile.exists) {
    let registry;
    try {
      registry = JSON.parse(registryFile.bytes.toString("utf8"));
      entries = validateScopeRegistry(registryPath, registry);
    } catch (error) {
      registryFile = { unsafe: true, code: "INVALID_REGISTRY", message: error.message };
    }
  }
  const dirs = new Set([userCodexHome, join(cwd, ".codex"), ...entries.map(entry => resolve(entry.configDir))]);
  const activationConfigDirs = await codexActivationConfigDirs(cwd, inventoryCwd);
  for (const dir of activationConfigDirs) dirs.add(dir);
  const paths = [registryPath];
  for (const dir of dirs) paths.push(
    join(dir, "hooks.json"),
    join(dir, "config.toml"),
    join(dir, "muster", MANIFEST),
    join(dir, "muster", "hooks", "muster-hook.mjs"),
    join(dir, "muster", "hooks", "action-guard.mjs")
  );
  const files = new Map([[registryPath, registryFile]]);
  for (const path of [...new Set(paths)].sort()) if (path !== registryPath) files.set(path, await activationFileSnapshot(path));
  for (const activationConfigDir of activationConfigDirs) files.set(activationConfigDir, await activationDirectorySnapshot(activationConfigDir));
  return files;
}

export function sameHookActivationSnapshot(left, right) {
  if (left.size !== right.size) return false;
  for (const [path, file] of left) if (!right.has(path) || !samePhysicalFile(file, right.get(path))) return false;
  return true;
}

function activationSnapshotMatchesWrites(activationSnapshot, written) {
  for (const [path, expected] of written) {
    if (activationSnapshot.has(path) && !samePhysicalFile(expected, activationSnapshot.get(path))) return false;
  }
  return true;
}

async function liveManagedHookScripts(home, extraConfigDirs = []) {
  const registry = await readScopeRegistry(home);
  const dirs = new Set([codexHome(home), ...extraConfigDirs, ...registry.entries.map(entry => entry.configDir)]);
  return [...dirs].map(dir => join(dir, "muster", "hooks", "muster-hook.mjs"));
}

async function validateManagedHookAliasGraph({ home, cwd, inventoryCwd = cwd, entries, currentDir, currentConfig }) {
  const currentProjectDir = join(cwd, ".codex");
  const invocationProjectDirs = await codexActivationConfigDirs(cwd, inventoryCwd);
  const registeredDirs = new Set(entries.map(entry => resolve(entry.configDir)));
  const scopes = [
    { scope: "user", configDir: codexHome(home) },
    { scope: "project", configDir: currentProjectDir },
    ...invocationProjectDirs.filter(dir => resolve(dir) !== resolve(currentProjectDir)).map(configDir => ({ scope: "project", configDir })),
    ...entries,
    ...(currentDir ? [{ scope: currentDir === codexHome(home) ? "user" : "project", configDir: currentDir }] : [])
  ];
  const unique = new Map(scopes.map(entry => [resolve(entry.configDir), { ...entry, configDir: resolve(entry.configDir) }]));
  const runtimeScripts = [...unique.values()].map(entry => join(entry.configDir, "muster", "hooks", "muster-hook.mjs"));
  const projectCwds = [...unique.values()].filter(entry => entry.scope === "project").map(entry => dirname(entry.configDir));
  for (const entry of unique.values()) {
    const configPath = join(entry.configDir, "hooks.json");
    let config = currentDir && resolve(currentDir) === entry.configDir ? currentConfig : null;
    if (!config) {
      if (!(await safeExists(configPath))) continue;
      config = await readJson(configPath);
      if (!config || typeof config !== "object" || Array.isArray(config)) {
        throw new Error(`Codex hook configuration conflict: ${configPath} is malformed while validating managed runtime aliases.`);
      }
    }
    const invocationCwds = invocationProjectDirs.map(dirname);
    const cwds = entry.scope === "user" ? [...new Set([cwd, inventoryCwd, ...invocationCwds, ...projectCwds])]
      : [currentProjectDir, ...invocationProjectDirs].some(dir => entry.configDir === resolve(dir))
        ? [...new Set([cwd, inventoryCwd, ...invocationCwds])] : [dirname(entry.configDir)];
    const unownedCurrentProject = [currentProjectDir, ...invocationProjectDirs].some(dir => entry.configDir === resolve(dir))
      && entry.configDir !== resolve(currentDir || "") && !registeredDirs.has(entry.configDir);
    if (unownedCurrentProject && Object.values(config.hooks || {}).some(groups => Array.isArray(groups)
      && groups.some(group => groupCommands(group).some(isMusterHookCommand)))) {
      throw new Error(`Codex hook conflict: ${configPath} contains an unmanaged Muster hook in the unregistered current project.`);
    }
    if (await hasMusterHookCommandAlias(config, runtimeScripts, { cwds })) {
      throw new Error(`Codex hook conflict: ${configPath} contains a command aliased to a live managed Muster runtime.`);
    }
  }
}

async function scopeEntry(scope, cwd, home) {
  const dir = configDir(scope, cwd, home);
  try { return { scope, configDir: await realpath(dir) }; }
  catch (error) { if (error.code === "ENOENT") return { scope, configDir: resolve(dir) }; throw error; }
}

const sameScopeEntry = (left, right) => left.scope === right.scope && left.configDir === right.configDir;
const registryText = entries => JSON.stringify({ format: 1, owner: "muster", entries }, null, 2) + "\n";

// Walks `path` from its root, matching each segment against its parent's
// real directory listing (preferring an exact match, falling back to a
// case-insensitive one) to recover the actual on-disk casing. On a
// case-insensitive mount (e.g. WSL's /mnt/c DrvFS), `realpath` does not
// correct casing -- see codex-install.js's WSL-path tests -- so this is the
// only reliable way to learn which casing is canonical.
async function canonicalDiskCasing(path, { readdirFn = readdir } = {}) {
  const absolute = resolve(path), root = parse(absolute).root;
  let current = root;
  for (const part of relative(root, absolute).split(sep).filter(Boolean)) {
    let names;
    try { names = await readdirFn(current); }
    catch (error) { if (error.code === "ENOENT" || error.code === "ENOTDIR") return null; throw error; }
    const match = names.includes(part) ? part : names.find(name => name.toLowerCase() === part.toLowerCase());
    if (match === undefined) return null;
    current = join(current, match);
  }
  return current;
}

// Reconciles a managed-scope registry's entries: prunes any entry whose
// configDir no longer exists on disk (an orphaned deleted-worktree scope),
// and collapses entries that are the SAME physical directory (matched by
// dev/ino -- filesystem-agnostic, unlike a string/case comparison, and safe
// on both case-sensitive and case-insensitive mounts) into one survivor
// cased however the filesystem actually has it. Order-preserving: the
// surviving entry appears at its first physical occurrence.
export async function reconcileScopeRegistryEntries(entries, { lstatFn = lstat, readdirFn = readdir, onPrune = () => {} } = {}) {
  const survivors = new Map();
  for (const entry of entries) {
    let stat;
    try { stat = await lstatFn(entry.configDir); }
    catch (error) {
      if (error.code !== "ENOENT" && error.code !== "ENOTDIR") throw error;
      // Accepted ambiguity: an unmounted-but-still-valid path (e.g. a WSL
      // /mnt/* drive not yet attached) looks identical to a truly deleted
      // one, so an ENOENT prune here is only ever a best guess -- the
      // caller-visible listing (see runCodexInstall's prunedScopes) is the
      // mitigation, not a fix, for that ambiguity.
      onPrune({ scope: entry.scope, configDir: entry.configDir, reason: "configDir missing" });
      continue;
    }
    if (typeof stat.isDirectory === "function" ? !stat.isDirectory() : !stat.isDirectory) continue;
    if (typeof stat.isSymbolicLink === "function" ? stat.isSymbolicLink() : stat.isSymbolicLink) continue;
    const key = `${stat.dev}:${stat.ino}`;
    const existing = survivors.get(key);
    if (existing) {
      if (existing.scope !== entry.scope) {
        throw new Error(`Codex managed-scope registry maps one physical directory to both ${existing.scope} and ${entry.scope} scope: ${entry.configDir}`);
      }
      continue;
    }
    const canonicalConfigDir = await canonicalDiskCasing(entry.configDir, { readdirFn }) ?? entry.configDir;
    survivors.set(key, { scope: entry.scope, configDir: canonicalConfigDir });
  }
  return [...survivors.values()];
}

// -- config.toml [hooks.state] trust-cache reconciliation --------------------
//
// Codex records a permanent trust decision per hook definition in the
// shared config.toml under `[hooks.state."<hooksJsonPath>:<event>:<matcher
// index>:<hook index>"]` (see docs/research/codex-cli.md section 4.1 and the
// real fixture inspected while diagnosing codex-hook-bombardment). Nothing
// prunes it as scopes are deleted or case-duplicated -- mirroring
// reconcileScopeRegistryEntries' own justification above, a dead or
// duplicate scope keeps a LIVE trust-cache entry (and, per that research
// doc, a live hook-firing source) forever. This is a scoped, hand-rolled
// editor in codex-thread-limits.js's spirit: it recognizes exactly the one
// table shape above and passes every other line through byte-for-byte; it
// never needs a general TOML parser because it only ever PRUNES whole
// sections Codex itself already wrote, never creates new ones. A `[[...]]`
// array-of-tables header (e.g. an `[[mcp_servers.*.env_http_headers]]`
// block) ends a section's span exactly like a `[...]` table header does --
// codex-hook-bombardment review iteration 1 PoC-proved that omitting this
// let a pruned section's span swallow (and delete) an adjacent array-of-
// tables block it never owned.
//
// `[projects."<projectRoot>"]` is Codex's own trusted-directory record (see
// docs/research/codex-cli.md section 4.1) gating the whole .codex layer for
// that project -- muster never created it and cannot reliably attribute it
// as muster-owned, so this editor never touches it at all (fix iteration 1:
// a prior revision pruned the paired project-trust entry alongside a pruned
// project scope and was PoC-proven to revoke a user's deliberate trust,
// plus any of that entry's non-muster keys, on an ordinary uninstall of a
// still-existing project). A leftover trust record is harmless; revoking a
// user's trust decision muster never made is not.
function decodeTomlQuotedKey(raw) {
  if (typeof raw !== "string" || raw.length < 2) return null;
  const quote = raw[0];
  if (quote === "'") return raw.at(-1) === "'" && !raw.slice(1, -1).includes("'") ? raw.slice(1, -1) : null;
  if (quote !== '"' || raw.at(-1) !== '"') return null;
  const body = raw.slice(1, -1);
  if (!/^(?:[^"\\]|\\[\\"tnrbf]|\\u[0-9a-fA-F]{4}|\\U[0-9a-fA-F]{8})*$/.test(body)) return null;
  return body.replace(/\\(u[0-9a-fA-F]{4}|U[0-9a-fA-F]{8}|.)/g, (_, escape) => {
    if (escape[0] === "u" || escape[0] === "U") return String.fromCodePoint(parseInt(escape.slice(1), 16));
    return { "\\": "\\", '"': '"', t: "\t", n: "\n", r: "\r", b: "\b", f: "\f" }[escape] ?? escape;
  });
}

const HOOK_STATE_HEADER = /^\s*\[hooks\.state\.((?:"(?:[^"\\]|\\.)*")|(?:'[^']*'))\]\s*(?:#.*)?$/;
const HOOK_STATE_KEY = /^(.*):([a-z][a-z0-9_]*):(\d+):(\d+)$/;

function basicQuoteEscaped(line, index) {
  let slashes = 0;
  for (let cursor = index - 1; cursor >= 0 && line[cursor] === "\\"; cursor--) slashes++;
  return slashes % 2 === 1;
}

function inspectTomlHeader(line) {
  const start = line.search(/\S/);
  if (start < 0 || line[start] !== "[") return { header: false, safe: true };
  const array = line[start + 1] === "[";
  let index = start + (array ? 2 : 1);
  const whitespace = () => { while (/\s/.test(line[index] ?? "")) index++; };
  const component = () => {
    if (line[index] === '"' || line[index] === "'") {
      const start = index;
      const quote = line[index++];
      while (index < line.length) {
        if (line[index] === quote && (quote === "'" || !basicQuoteEscaped(line, index))) {
          index++;
          let decoded;
          try { decoded = decodeTomlQuotedKey(line.slice(start, index)); } catch { return false; }
          return decoded !== null && !/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\uD800-\uDFFF]/u.test(decoded);
        }
        index++;
      }
      return false;
    }
    const match = line.slice(index).match(/^[A-Za-z0-9_-]+/);
    if (!match) return false;
    index += match[0].length;
    return true;
  };
  whitespace();
  if (!component()) return { header: false, safe: false };
  while (true) {
    whitespace();
    const closes = array ? line.startsWith("]]", index) : line[index] === "]";
    if (closes) {
      const rest = line.slice(index + (array ? 2 : 1));
      return /^\s*(?:#.*)?$/.test(rest)
        ? { header: true, safe: true }
        : { header: false, safe: false };
    }
    if (line[index++] !== ".") return { header: false, safe: false };
    whitespace();
    if (!component()) return { header: false, safe: false };
  }
}

// TOML table-shaped text is inert while it lives inside a multiline string.
// Track only the lexical states that can cross line boundaries; ordinary
// basic/literal strings and comments are consumed within their own line. If a
// single-line string is unterminated, mark the document unsafe so trust fails
// closed and reconciliation returns the original bytes unchanged.
function scanTomlLine(line, multiline, arrayDepth) {
  let mode = multiline;
  let depth = arrayDepth;
  for (let index = 0; index < line.length;) {
    if (mode === "basic") {
      if (line[index] === '"' && !basicQuoteEscaped(line, index)) {
        let run = 1;
        while (line[index + run] === '"') run++;
        if (run >= 3 && run <= 5) { mode = null; index += run; }
        else if (run > 5) return { multiline: mode, arrayDepth: depth, safe: false };
        else index += run;
      } else index++;
      continue;
    }
    if (mode === "literal") {
      if (line[index] === "'") {
        let run = 1;
        while (line[index + run] === "'") run++;
        if (run >= 3 && run <= 5) { mode = null; index += run; }
        else if (run > 5) return { multiline: mode, arrayDepth: depth, safe: false };
        else index += run;
      } else index++;
      continue;
    }
    const char = line[index];
    if (char === "#") break;
    if (line.startsWith('"""', index)) { mode = "basic"; index += 3; continue; }
    if (line.startsWith("'''", index)) { mode = "literal"; index += 3; continue; }
    if (char === '"') {
      let closed = false;
      for (index++; index < line.length; index++) if (line[index] === '"' && !basicQuoteEscaped(line, index)) {
        index++; closed = true; break;
      }
      if (!closed) return { multiline: null, arrayDepth: depth, safe: false };
      continue;
    }
    if (char === "'") {
      const closing = line.indexOf("'", index + 1);
      if (closing < 0) return { multiline: null, arrayDepth: depth, safe: false };
      index = closing + 1;
      continue;
    }
    if (char === "[") depth++;
    else if (char === "]") {
      if (depth === 0) return { multiline: mode, arrayDepth: depth, safe: false };
      depth--;
    }
    index++;
  }
  return { multiline: mode, arrayDepth: depth, safe: true };
}

function splitTomlLines(text) {
  const lines = [], endings = [];
  let offset = 0;
  while (offset < text.length) {
    const newline = text.indexOf("\n", offset);
    if (newline < 0) { lines.push(text.slice(offset)); endings.push(""); break; }
    const crlf = newline > offset && text[newline - 1] === "\r";
    lines.push(text.slice(offset, crlf ? newline - 1 : newline));
    endings.push(crlf ? "\r\n" : "\n");
    offset = newline + 1;
  }
  return { lines, endings };
}

function parseConfigTomlTrustSections(text) {
  const { lines, endings } = splitTomlLines(text);
  const sections = [];
  let current = null;
  let multiline = null;
  let arrayDepth = 0;
  let safe = true;
  const closeCurrent = end => { if (current) { current.end = end; sections.push(current); current = null; } };
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    const syntaxActive = multiline === null && arrayDepth === 0;
    const hookMatch = syntaxActive ? line.match(HOOK_STATE_HEADER) : null;
    const header = syntaxActive ? inspectTomlHeader(line) : { header: false, safe: true };
    safe &&= header.safe;
    if (syntaxActive && (hookMatch || header.header)) closeCurrent(index);
    if (hookMatch) current = { table: "hooks.state", key: decodeTomlQuotedKey(hookMatch[1]), headerLine: index };
    const scanned = header.header
      ? { multiline, arrayDepth, safe: true }
      : scanTomlLine(line, multiline, arrayDepth);
    multiline = scanned.multiline;
    arrayDepth = scanned.arrayDepth;
    safe &&= scanned.safe;
  }
  closeCurrent(lines.length);
  return { lines, endings, sections, safe, multiline, arrayDepth };
}

const renderConfigTomlTrustSections = state => state.lines.map((line, index) => line + state.endings[index]).join("");

// Converts a hooks.json event key (PascalCase, e.g. "SessionStart") to the
// snake_case form Codex records in a [hooks.state] key's <event> segment
// (e.g. "session_start") -- see docs/research/codex-cli.md section 4.1 and
// codex/hooks/hooks.json's event keys vs. the real fixture's trust keys.
const hookStateEventName = pascal => pascal.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();

// Computes the EXACT `<event>:<groupIndex>:<hookIndex>` compound keys a
// specific scope's OWN muster-authored hook groups currently occupy inside
// its live hooks.json -- fix iteration 1's answer to over-revocation blocker
// (b): locating a muster group by content (mirroring removeOwnedHookGroups'
// own `findIndex(candidate => same(candidate, group))` matching, including
// consumed-index tracking so two owned groups for the same event never
// collide on one position without shifting their original positions) rather than by hooksJsonPath alone means a
// co-located NON-muster hook definition -- sharing the same hooks.json but a
// different group/hook index -- is never included here, and so never gets
// swept up by a path-level prune.
function ownedHookStateEntries(config, hookGroups) {
  const entries = [];
  for (const [event, groups] of Object.entries(hookGroups || {})) {
    if (!Array.isArray(groups)) continue;
    const current = [...(Array.isArray(config?.hooks?.[event]) ? config.hooks[event] : [])];
    const consumed = new Set();
    const snakeEvent = hookStateEventName(event);
    for (const group of groups) {
      const index = current.findIndex((candidate, candidateIndex) => !consumed.has(candidateIndex) && same(candidate, group));
      if (index < 0) continue;
      consumed.add(index);
      const hooks = Array.isArray(group.hooks) ? group.hooks : [];
      for (let hookIndex = 0; hookIndex < hooks.length; hookIndex++) {
        entries.push({ key: `${snakeEvent}:${index}:${hookIndex}`, event, group, hook: hooks[hookIndex] });
      }
    }
  }
  return entries;
}

function ownedHookStateKeys(config, hookGroups) {
  return ownedHookStateEntries(config, hookGroups).map(entry => entry.key);
}

// Reconciles config.toml's [hooks.state] trust cache against the
// Muster-known scope universe: `registeredEntries` is every scope Muster has
// ever recorded (the scope registry's raw entries, BEFORE its own
// reconcileScopeRegistryEntries pass -- the only place that still remembers
// a since-deleted scope's configDir at all), `keptEntries` is the subset
// that should still have a live trust-cache entry (typically that same
// reconcileScopeRegistryEntries' output for install/doctor, or the
// remaining scopes after removing the one being uninstalled). A hooks.state
// entry is pruned when its exact `<configDir>/hooks.json` prefix matches a
// REGISTERED entry that is NOT in `keptEntries` -- i.e. never touching an
// entry this pass cannot positively attribute to Muster (a plugin-bundled
// key such as "muster@muster:hooks/hooks.json:...", another tool's
// unrelated hooks.json, or any path this scope registry never recorded).
//
// A registered entry MAY additionally carry `ownedHookStateKeys` (an array
// of the exact compound keys `ownedHookStateKeys()` above computed for it):
// when present, pruning for THAT entry narrows to exactly those keys
// instead of every entry under its hooksJsonPath -- fix iteration 1's answer
// to over-revocation blocker (b), used by `muster uninstall codex` for the
// one scope actually departing (whose directory and hooks.json still fully
// exist). Every OTHER not-kept entry (a genuinely dead or case-duplicate
// scope reconciled away as a byproduct) has no such per-key attribution
// available or needed -- either its configDir no longer exists at all (no
// file left for any other tool to still depend on), or it is the exact same
// physical hooks.json as its kept survivor under a different on-disk casing
// -- so it keeps the original whole-path prune, unchanged from before this
// fix. `[projects."<root>"]` is never inspected or touched at all (see this
// section's header comment).
//
// A KEPT entry (present in `keptEntries`) with `ownedHookStateKeys` set is a
// second, narrower case (codex-hook-scope-collapse): `muster install codex`
// itself uses this when a canonical-scope collapse vacates every hook group
// a still-registered, still-live scope held (nothing re-added in its
// place) -- the scope's directory/registration survives (its profiles still
// install), but its now-orphaned hook trust does not. Without
// `ownedHookStateKeys` a kept entry is never a pruning candidate at all (an
// ordinary reinstall re-adding equivalent groups must never re-prompt
// Codex's own trust review); WITH it, pruning narrows to exactly those keys
// instead of being skipped outright.
export function reconcileConfigTomlHookState(text, registeredEntries, keptEntries, { onPrune = () => {} } = {}) {
  const state = parseConfigTomlTrustSections(text);
  if (!state.safe || state.multiline || state.arrayDepth !== 0) return { text, prunedHookState: [], prunedProjects: [], parseOk: false };
  const registered = (registeredEntries || []).map(entry => ({
    scope: entry.scope,
    configDir: entry.configDir,
    hooksJsonPath: join(entry.configDir, "hooks.json"),
    ownedHookStateKeys: Array.isArray(entry.ownedHookStateKeys) ? new Set(entry.ownedHookStateKeys) : null
  }));
  const keptHooksJsonPaths = new Set((keptEntries || []).map(entry => join(entry.configDir, "hooks.json")));
  const remove = new Array(state.lines.length).fill(false);
  const markRemoved = section => { for (let index = section.headerLine; index < section.end; index++) remove[index] = true; };
  const prunedHookState = [];
  for (const section of state.sections) {
    if (section.table !== "hooks.state" || section.key == null) continue;
    const match = section.key.match(HOOK_STATE_KEY);
    if (!match) continue;
    const [, prefix, event, groupIndex, hookIndex] = match;
    if (!isAbsolute(prefix)) continue;
    const known = registered.find(entry => entry.hooksJsonPath === prefix);
    if (!known) continue;
    if (keptHooksJsonPaths.has(known.hooksJsonPath) && !known.ownedHookStateKeys) continue;
    if (known.ownedHookStateKeys && !known.ownedHookStateKeys.has(`${event}:${groupIndex}:${hookIndex}`)) continue;
    markRemoved(section);
    const pruned = { type: "hooks.state", scope: known.scope, configDir: known.configDir, hooksJsonPath: known.hooksJsonPath, event, groupIndex: Number(groupIndex), hookIndex: Number(hookIndex) };
    prunedHookState.push(pruned);
    onPrune(pruned);
  }
  state.endings = state.endings.filter((_, index) => !remove[index]);
  state.lines = state.lines.filter((_, index) => !remove[index]);
  // prunedProjects is always empty: [projects] is never touched (see above).
  // Kept in the return shape for API stability with existing callers.
  return { text: renderConfigTomlTrustSections(state), prunedHookState, prunedProjects: [], parseOk: true };
}

// -- hook TRUST gaps: the inverse of the stale-entry reconciliation above -----
//
// Codex trusts hooks per CONTENT HASH and, per its docs, "records trust against
// the hook's current hash, so new or changed hooks are marked for review and
// SKIPPED until trusted". So the dangerous direction is not a leftover entry --
// reconcileConfigTomlHookState already handles that -- but a MISSING one: every
// `muster install codex` that alters a hook body silently stops that hook from
// firing until a human trusts it, and nothing in muster noticed. A gate that
// quietly stops firing is precisely the failure this project's guard design
// exists to prevent, so it must be reported loudly rather than inferred.
//
const HOOK_CONTEXT_EVENTS = new Set(["PreToolUse", "PostToolUse", "SessionStart", "UserPromptSubmit", "SubagentStart"]);
const MATCHER_IGNORED_EVENTS = new Set(["UserPromptSubmit", "Stop"]);
const DEFAULT_HOOK_OUTPUT_TOKEN_LIMIT = 2_500;
const HOOK_INVENTORY_MAX_BYTES = 4 * 1024 * 1024;
const HOOK_INVENTORY_TIMEOUT_MS = 10_000;

function canonicalJson(value) {
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonicalJson(value[key])]));
}

// Mirrors Codex's command_hook_hash in codex-rs/hooks/src/engine/discovery.rs:
// hash the canonical JSON serialization of a normalized, config-derived hook
// identity. Trust is deliberately verified, never created or bypassed here.
function currentCodexHookHash(event, group, hook) {
  const command = process.platform === "win32" ? (hook?.commandWindows ?? hook?.command) : hook?.command;
  const rawTimeout = Number.isSafeInteger(hook?.timeout) ? hook.timeout : null;
  const timeout = event === "SessionEnd"
    ? Math.min(3, Math.max(1, rawTimeout ?? 1))
    : Math.max(1, rawTimeout ?? 600);
  const normalizedHook = {
    type: "command",
    command,
    timeout,
    async: hook?.async === true
  };
  if (typeof hook?.statusMessage === "string") normalizedHook.statusMessage = hook.statusMessage;
  if (HOOK_CONTEXT_EVENTS.has(event)
    && Number.isSafeInteger(hook?.additionalContextLimit)
    && hook.additionalContextLimit >= 0
    && hook.additionalContextLimit !== DEFAULT_HOOK_OUTPUT_TOKEN_LIMIT) {
    normalizedHook.additionalContextLimit = hook.additionalContextLimit;
  }
  const identity = {
    event_name: hookStateEventName(event),
    hooks: [normalizedHook]
  };
  if (!MATCHER_IGNORED_EVENTS.has(event) && typeof group?.matcher === "string") identity.matcher = group.matcher;
  return `sha256:${createHash("sha256").update(JSON.stringify(canonicalJson(identity))).digest("hex")}`;
}

function hookTrustSectionState(state, section) {
  let enabled = true;
  let trustedHash = null;
  let malformed = false;
  let sawEnabled = false;
  let sawTrustedHash = false;
  for (let index = section.headerLine + 1; index < section.end; index++) {
    const line = state.lines[index];
    if (!line.trim() || /^\s*#/.test(line)) continue;
    const assignment = line.match(/^\s*((?:"(?:[^"\\]|\\.)*")|(?:'[^']*')|[A-Za-z0-9_-]+)\s*=\s*(.*?)\s*$/);
    const key = assignment ? (assignment[1][0] === "\"" || assignment[1][0] === "'"
      ? decodeTomlQuotedKey(assignment[1])
      : assignment[1]) : null;
    const enabledMatch = key === "enabled" ? assignment[2].match(/^(true|false)\s*(?:#.*)?$/) : null;
    if (key === "enabled" && enabledMatch) {
      if (sawEnabled) malformed = true;
      sawEnabled = true;
      enabled = enabledMatch[1] === "true";
      continue;
    }
    const hashMatch = key === "trusted_hash" ? assignment[2].match(/^(?:"([^"]*)"|'([^']*)')\s*(?:#.*)?$/) : null;
    if (key === "trusted_hash" && hashMatch) {
      if (sawTrustedHash) malformed = true;
      sawTrustedHash = true;
      trustedHash = hashMatch[1] ?? hashMatch[2];
      continue;
    }
    // A partial TOML interpretation must never certify this section. Unknown,
    // malformed, or future assignments fail closed until this reader can
    // model their effect on Codex hook activation.
    malformed = true;
  }
  return { enabled, trustedHash, malformed };
}

export async function readCodexHookInventory({ runtimeIdentity, cwds, env = process.env, spawnFn = spawn, timeoutMs = HOOK_INVENTORY_TIMEOUT_MS } = {}) {
  if (!runtimeIdentity?.node || !runtimeIdentity?.codex) return { ok: false, error: "pinned Codex runtime unavailable", data: [] };
  return new Promise(resolveInventory => {
    let settled = false, stdout = "", stderr = "", initialized = false;
    const finish = result => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (child.exitCode === null) child.kill();
      resolveInventory(result);
    };
    const child = spawnFn(runtimeIdentity.node, [runtimeIdentity.codex, "app-server"], {
      env,
      stdio: ["pipe", "pipe", "pipe"]
    });
    const timer = setTimeout(() => finish({ ok: false, error: "Codex hooks/list timed out", data: [] }), timeoutMs);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", chunk => { stderr = (stderr + chunk).slice(-HOOK_INVENTORY_MAX_BYTES); });
    child.stdout.on("data", chunk => {
      stdout += chunk;
      if (Buffer.byteLength(stdout) > HOOK_INVENTORY_MAX_BYTES) return finish({ ok: false, error: "Codex hooks/list output exceeded its byte limit", data: [] });
      let newline;
      while ((newline = stdout.indexOf("\n")) >= 0) {
        const line = stdout.slice(0, newline); stdout = stdout.slice(newline + 1);
        let message;
        try { message = JSON.parse(line); } catch { continue; }
        if (message.id === 1 && message.result && !initialized) {
          initialized = true;
          child.stdin.write(`${JSON.stringify({ method: "initialized", params: {} })}\n`);
          child.stdin.write(`${JSON.stringify({ method: "hooks/list", id: 2, params: { cwds } })}\n`);
        } else if (message.id === 1 && message.error) {
          finish({ ok: false, error: `Codex hooks/list initialize failed: ${message.error.message || "unknown error"}`, data: [] });
        } else if (message.id === 2 && message.result?.data) {
          finish({ ok: true, data: message.result.data });
        } else if (message.id === 2 && message.error) {
          finish({ ok: false, error: `Codex hooks/list failed: ${message.error.message || "unknown error"}`, data: [] });
        }
      }
    });
    child.on("error", error => finish({ ok: false, error: `Codex hooks/list launch failed: ${error.message}`, data: [] }));
    child.on("exit", code => {
      if (!settled) finish({ ok: false, error: `Codex hooks/list exited before a response (code ${code}; ${stderr.trim().slice(0, 300)})`, data: [] });
    });
    child.stdin.on("error", error => finish({ ok: false, error: `Codex hooks/list stdin failed: ${error.message}`, data: [] }));
    child.stdin.write(`${JSON.stringify({ method: "initialize", id: 1, params: { clientInfo: { name: "muster", title: "Muster", version: "0.6.0" } } })}\n`);
  });
}

const HOOK_INVENTORY_CONTROLS = /[\u0000-\u001F\u007F-\u009F]/u;
const HOOK_CONTENT_HASH = /^sha256:[0-9a-f]{64}$/;
const HOOK_RESULT_STATUSES = new Set(["invalid", "disabled", "trusted", "untrusted", "modified"]);
const validCanonicalHookPath = value => typeof value === "string" && value.length > 0
  && isAbsolute(value) && !HOOK_INVENTORY_CONTROLS.test(value) && resolve(value) === value;
const exactObject = (value, keys) => value && typeof value === "object" && !Array.isArray(value)
  && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
  && Reflect.ownKeys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const denseArray = value => Array.isArray(value) && Reflect.ownKeys(value).every((key, index, keys) => {
  if (key === "length") return index === keys.length - 1;
  return typeof key === "string" && key === String(index);
}) && Reflect.ownKeys(value).length === value.length + 1;
function validHookPosition(value) {
  if (typeof value !== "string") return false;
  const match = value.match(/^([a-z][a-z0-9_]*):(0|[1-9]\d*):(0|[1-9]\d*)$/);
  return Boolean(match && Number.isSafeInteger(Number(match[2])) && Number.isSafeInteger(Number(match[3])));
}
function parseHookInventoryKey(value, { sourcePath, pluginId } = {}) {
  if (typeof value !== "string" || HOOK_INVENTORY_CONTROLS.test(value)) return null;
  const match = value.match(/^(.+):([a-z][a-z0-9_]*):(0|[1-9]\d*):(0|[1-9]\d*)$/);
  if (!match || !Number.isSafeInteger(Number(match[3])) || !Number.isSafeInteger(Number(match[4]))) return null;
  let path = match[1];
  if (!validCanonicalHookPath(path)) {
    const pluginPrefix = typeof pluginId === "string" ? `${pluginId}:hooks/` : null;
    const relativePluginPath = pluginPrefix && path.startsWith(pluginPrefix) ? path.slice(pluginPrefix.length) : null;
    if (!relativePluginPath || relativePluginPath.split(/[\\/]/).some(part => !part || part === "." || part === "..")
      || !validCanonicalHookPath(sourcePath)
      || !sourcePath.replaceAll("\\", "/").endsWith(`/hooks/${relativePluginPath.replaceAll("\\", "/")}`)) return null;
    path = sourcePath;
  }
  return { path, position: `${match[2]}:${match[3]}:${match[4]}` };
}

const parseInventoryHook = hook => parseHookInventoryKey(hook?.key, { sourcePath: hook?.sourcePath, pluginId: hook?.pluginId });

function validHookInventoryRecord(entry) {
  if (!exactObject(entry, ["cwd", "warnings", "errors", "hooks"])
    || !validCanonicalHookPath(entry.cwd)
    || !denseArray(entry.warnings) || !entry.warnings.every(item => typeof item === "string")
    || !denseArray(entry.errors) || !entry.errors.every(item => typeof item === "string")
    || !denseArray(entry.hooks)) return false;
  return entry.hooks.every(hook => {
    const parsed = parseInventoryHook(hook);
    const legacyShape = exactObject(hook, ["key", "enabled", "trustStatus", "currentHash"]);
    const currentShape = exactObject(hook, [
      "key", "eventName", "handlerType", "matcher", "command", "timeoutSec", "statusMessage",
      "additionalContextLimit", "sourcePath", "source", "pluginId", "displayOrder", "enabled",
      "isManaged", "currentHash", "trustStatus"
    ])
      && typeof hook.eventName === "string" && hook.eventName.length > 0 && !HOOK_INVENTORY_CONTROLS.test(hook.eventName)
      && hook.handlerType === "command"
      && (hook.matcher === null || typeof hook.matcher === "string")
      && typeof hook.command === "string" && hook.command.length > 0
      && Number.isSafeInteger(hook.timeoutSec) && hook.timeoutSec > 0
      && (hook.statusMessage === null || typeof hook.statusMessage === "string")
      && (hook.additionalContextLimit === null || (Number.isSafeInteger(hook.additionalContextLimit) && hook.additionalContextLimit >= 0))
      && validCanonicalHookPath(hook.sourcePath) && hook.sourcePath === parsed?.path
      && typeof hook.source === "string" && hook.source.length > 0 && !HOOK_INVENTORY_CONTROLS.test(hook.source)
      && (hook.pluginId === null || (typeof hook.pluginId === "string" && hook.pluginId.length > 0 && !HOOK_INVENTORY_CONTROLS.test(hook.pluginId)))
      && Number.isSafeInteger(hook.displayOrder) && hook.displayOrder >= 0
      && typeof hook.isManaged === "boolean";
    return (legacyShape || currentShape)
    && parsed !== null
    && typeof hook.enabled === "boolean"
    && typeof hook.trustStatus === "string" && hook.trustStatus.length > 0 && !HOOK_INVENTORY_CONTROLS.test(hook.trustStatus)
    && typeof hook.currentHash === "string" && HOOK_CONTENT_HASH.test(hook.currentHash);
  });
}

export function effectiveHookTrust(inventory, cwd, hooksJsonPath, results, { knownKeys } = {}) {
  if (inventory?.ok !== true) return { verified: false, ok: false, error: inventory?.error || "Codex hooks/list unavailable", results: [] };
  if (!exactObject(inventory, ["ok", "data"])) {
    return { verified: true, ok: false, error: "Codex hooks/list returned a malformed response envelope", results: [] };
  }
  if (!validCanonicalHookPath(cwd) || !validCanonicalHookPath(hooksJsonPath)) {
    return { verified: true, ok: false, error: "requested hook scope CWD or hooks.json path is malformed or noncanonical", results: [] };
  }
  if (!denseArray(results) || results.length === 0
    || !results.every(result => exactObject(result, ["key", "currentHash", "trustedHash", "enabled", "status"])
      && validHookPosition(result.key)
      && typeof result.currentHash === "string" && HOOK_CONTENT_HASH.test(result.currentHash)
      && (result.trustedHash === null || typeof result.trustedHash === "string")
      && typeof result.enabled === "boolean" && HOOK_RESULT_STATUSES.has(result.status))
    || new Set(results.map(result => result.key)).size !== results.length) {
    return { verified: true, ok: false, error: "no valid, unique expected Muster hooks were supplied for activation verification", results: [] };
  }
  if (knownKeys !== undefined && (!denseArray(knownKeys) || !knownKeys.every(validHookPosition)
    || new Set(knownKeys).size !== knownKeys.length || results.some(result => !knownKeys.includes(result.key)))) {
    return { verified: true, ok: false, error: "known hook positions are malformed, duplicate, or incomplete", results: [] };
  }
  if (!denseArray(inventory.data) || !inventory.data.every(validHookInventoryRecord)) {
    return { verified: true, ok: false, error: "Codex hooks/list returned a malformed scope or hook record", results: [] };
  }
  const inventoryCwds = inventory.data.map(entry => entry.cwd);
  if (new Set(inventoryCwds).size !== inventoryCwds.length
    || inventory.data.some(entry => new Set(entry.hooks.map(hook => hook.key)).size !== entry.hooks.length)) {
    return { verified: true, ok: false, error: "Codex hooks/list returned duplicate scope or hook records", results: [] };
  }
  const scopes = inventory.data.filter(entry => entry.cwd === cwd);
  if (scopes.length !== 1) {
    return { verified: true, ok: false, error: scopes.length ? `Codex hooks/list returned duplicate records for ${cwd}` : "Codex hooks/list omitted the requested scope", results: [] };
  }
  const scope = scopes[0];
  if (Array.isArray(scope.errors) && scope.errors.length) {
    return { verified: true, ok: false, error: scope?.errors?.join("; ") || "Codex hooks/list omitted the requested scope", results: [] };
  }
  const hooks = Array.isArray(scope.hooks) ? scope.hooks : [];
  const parsedHooks = hooks.map(hook => ({ hook, parsed: parseInventoryHook(hook) }));
  const foreignHooks = parsedHooks.filter(({ parsed }) => parsed.path !== hooksJsonPath);
  if (foreignHooks.some(({ hook }) => typeof hook.command !== "string" || isMusterHookCommand(hook.command)
    || hasUnresolvedShellExpansion(hook.command))) {
    return { verified: true, ok: false, error: "Codex hooks/list reported another source that may invoke the managed Muster runtime", results: [] };
  }
  const managedKeys = parsedHooks.filter(({ parsed }) => parsed.path === hooksJsonPath).map(({ parsed }) => parsed.position);
  if (new Set(managedKeys).size !== managedKeys.length) {
    return { verified: true, ok: false, error: `Codex hooks/list returned duplicate hook positions for ${hooksJsonPath}`, results: [] };
  }
  if (knownKeys) {
    const known = new Set(knownKeys);
    const unexpected = parsedHooks.find(({ parsed }) => parsed.path === hooksJsonPath && !known.has(parsed.position));
    if (unexpected) return { verified: true, ok: false, error: `Codex hooks/list reported an unexpected active hook position for ${hooksJsonPath}: ${unexpected.hook.key}`, results: [] };
  }
  const effectiveResults = results.map(result => {
    const expectedKey = `${hooksJsonPath}:${result.key}`;
    const hook = hooks.find(candidate => candidate?.key === expectedKey);
    const active = Boolean(hook && hook.enabled === true && hook.trustStatus === "trusted"
      && hook.currentHash === result.currentHash);
    return { key: result.key, expectedKey, present: Boolean(hook), enabled: hook?.enabled ?? null,
      trustStatus: hook?.trustStatus ?? null, currentHash: hook?.currentHash ?? null, status: active ? "active" : "inactive" };
  });
  return { verified: true, ok: effectiveResults.every(result => result.status === "active"), error: null, results: effectiveResults };
}

// Pure and text-scoped, mirroring reconcileConfigTomlHookState: verifies every
// exact owned hook against Codex's current content hash and enabled state.
export function musterHookTrustGaps({ configTomlText, hooksJsonPath, config, hookGroups } = {}) {
  const entries = ownedHookStateEntries(config, hookGroups);
  const owned = entries.map(entry => entry.key);
  if (!owned.length) return { owned: [], untrusted: [], trusted: [], results: [], stale: [] };
  const parsed = parseConfigTomlTrustSections(configTomlText ?? "");
  const states = new Map();
  const scopeKeys = [];
  for (const section of parsed.sections) {
    if (section.table !== "hooks.state" || section.key == null) continue;
    const match = section.key.match(HOOK_STATE_KEY);
    if (!match) continue;
    const [, prefix, event, groupIndex, hookIndex] = match;
    if (prefix !== hooksJsonPath) continue;
    const key = `${event}:${groupIndex}:${hookIndex}`;
    scopeKeys.push(key);
    const sectionState = hookTrustSectionState(parsed, section);
    if (states.has(key)) sectionState.malformed = true;
    states.set(key, sectionState);
  }
  const results = entries.map(({ key, event, group, hook }) => {
    const currentHash = currentCodexHookHash(event, group, hook);
    const state = states.get(key);
    const enabled = state?.enabled !== false;
    const trustedHash = state?.trustedHash ?? null;
    const status = !parsed.safe || parsed.multiline || parsed.arrayDepth !== 0 || state?.malformed ? "invalid"
      : !enabled ? "disabled"
      : trustedHash === currentHash ? "trusted"
      : trustedHash === null ? "untrusted"
      : "modified";
    return { key, currentHash, trustedHash, enabled, status };
  });
  const trusted = results.filter(result => result.status === "trusted").map(result => result.key);
  const untrusted = results.filter(result => result.status !== "trusted").map(result => result.key);
  // A state entry is stale only when its positional key no longer names ANY
  // current hook. Non-Muster hooks share this hooks.json and have legitimate
  // trust entries of their own; they are outside our exact-trust verdict but
  // must not be mistaken for removed Muster positions.
  const currentKeys = new Set();
  for (const [event, groups] of Object.entries(config?.hooks || {})) {
    if (!Array.isArray(groups)) continue;
    for (let groupIndex = 0; groupIndex < groups.length; groupIndex++) {
      const hooks = Array.isArray(groups[groupIndex]?.hooks) ? groups[groupIndex].hooks : [];
      for (let hookIndex = 0; hookIndex < hooks.length; hookIndex++) {
        currentKeys.add(`${hookStateEventName(event)}:${groupIndex}:${hookIndex}`);
      }
    }
  }
  const stale = [...new Set(scopeKeys.filter(key => !currentKeys.has(key)))];
  return { owned, untrusted, trusted, results, stale };
}

async function scopeLockText(token) {
  return JSON.stringify({
    format: 1,
    owner: "muster",
    pid: process.pid,
    processIdentity: await processStartIdentity(),
    token,
    createdAt: Date.now()
  }) + "\n";
}
const pause = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

async function writeExclusiveSafe(path, content) {
  await ordinaryDirectoryPath(dirname(path), { create: true });
  await regularFileState(path);
  let handle, created = false;
  try {
    handle = await open(path, "wx", 0o600);
    created = true;
    await handle.writeFile(content, "utf8");
    await handle.sync();
  } catch (error) {
    if (handle) await handle.close().catch(() => {});
    if (created) try { await unlink(path); } catch (unlinkError) { if (unlinkError.code !== "ENOENT") throw unlinkError; }
    throw error;
  }
  await handle.close();
}

function parseScopeLock(text, path) {
  let lock;
  try { lock = JSON.parse(text); } catch { throw new Error(`Codex managed-scope lock is invalid: ${path}`); }
  if (lock?.format !== 1 || lock.owner !== "muster" || !Number.isSafeInteger(lock.pid) || lock.pid < 1
    || typeof lock.token !== "string" || !lock.token || !Number.isFinite(lock.createdAt) || lock.createdAt < 0
    || (Object.hasOwn(lock, "processIdentity") && lock.processIdentity !== null && typeof lock.processIdentity !== "string")) {
    throw new Error(`Codex managed-scope lock is invalid: ${path}`);
  }
  return lock;
}

async function readScopeLock(path) {
  const before = await regularFileState(path);
  if (!before) return null;
  let handle;
  try {
    handle = await open(path, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW || 0));
    const stat = await handle.stat();
    if (!stat.isFile() || stat.dev !== before.dev || stat.ino !== before.ino) return null;
    return { stat, lock: parseScopeLock(await handle.readFile("utf8"), path) };
  } catch (error) { if (error.code === "ENOENT") return null; throw error; }
  finally { if (handle) await handle.close().catch(() => {}); }
}

async function staleScopeLock(state) {
  const age = Date.now() - Math.max(state.lock.createdAt, state.stat.mtimeMs);
  if (age < SCOPE_LOCK_STALE_MS) return false;
  const alive = processAlive(state.lock.pid);
  if (!alive) return true;
  const recordedIdentity = typeof state.lock.processIdentity === "string" ? state.lock.processIdentity : null;
  const actualIdentity = await processStartIdentity(state.lock.pid);
  if (recordedIdentity && actualIdentity && recordedIdentity !== actualIdentity) return true;
  return age >= SCOPE_LOCK_MAX_STALE_MS;
}

const sameScopeLockInode = (left, right) => left.dev === right.dev && left.ino === right.ino;
const sameScopeLockOwner = (left, right) => left.token === right.token && left.pid === right.pid
  && left.processIdentity === right.processIdentity && left.createdAt === right.createdAt
  && left.owner === right.owner && left.format === right.format;

function defaultScopeRetirementModeCapability({ stat }) {
  return (stat.mode & 0o777) !== 0o777;
}

async function assertPrivateScopeRetirementDirectory(dir, { expectedStat = null, requirePrivateMode = true } = {}) {
  const stat = await lstat(dir);
  const uid = typeof process.getuid === "function" ? process.getuid() : null;
  const ownerMismatch = process.platform !== "win32" && typeof uid === "number" && stat.uid !== uid;
  const ownerChanged = expectedStat && stat.uid !== expectedStat.uid;
  const directoryChanged = expectedStat && !sameScopeLockInode(stat, expectedStat);
  const unsafeMode = requirePrivateMode && process.platform !== "win32"
    && ((stat.mode & 0o700) !== 0o700 || (stat.mode & 0o077) !== 0);
  if (stat.isSymbolicLink() || !stat.isDirectory() || ownerMismatch || ownerChanged || directoryChanged || unsafeMode) {
    throw new Error(`unsafe Codex managed-scope retirement directory: ${dir}`);
  }
  return stat;
}

async function privateScopeRetirement(path, { modeCapability = defaultScopeRetirementModeCapability } = {}) {
  for (let attempt = 0; attempt < 8; attempt++) {
    const dir = join(dirname(path), `.muster-retired-${process.pid}-${randomUUID()}`);
    try { await mkdir(dir, { mode: 0o700 }); }
    catch (error) { if (error.code === "EEXIST" && attempt < 7) continue; throw error; }
    const stat = await lstat(dir);
    const requirePrivateMode = await modeCapability({ dir, stat });
    if (typeof requirePrivateMode !== "boolean") throw new Error(`invalid Codex managed-scope retirement mode capability for ${dir}`);
    await assertPrivateScopeRetirementDirectory(dir, { expectedStat: stat, requirePrivateMode });
    return { dir, path: join(dir, "lock"), stat, expectedStat: stat, requirePrivateMode };
  }
  throw new Error(`could not create Codex managed-scope retirement directory for ${path}`);
}

async function removeEmptyScopeRetirementDirectory(retirement) {
  await assertPrivateScopeRetirementDirectory(retirement.dir, retirement);
  await rmdir(retirement.dir);
}

async function restoreRetiredScopeLock(path, retirement, stat) {
  await assertPrivateScopeRetirementDirectory(retirement.dir, retirement);
  const current = await lstat(retirement.path);
  if (!sameScopeLockInode(current, stat)) return false;
  try { await link(retirement.path, path); }
  catch (error) { if (error.code === "EEXIST") return false; throw error; }
  const restored = await lstat(path);
  if (!sameScopeLockInode(restored, stat)) throw new Error(`Codex managed-scope lock restore changed identity: ${path}`);
  await assertPrivateScopeRetirementDirectory(retirement.dir, retirement);
  await unlink(retirement.path);
  await removeEmptyScopeRetirementDirectory(retirement);
  return true;
}

async function restoreQuarantinedScopeLock(path, quarantine, stat, { modeCapability } = {}) {
  const retirement = await privateScopeRetirement(quarantine, { modeCapability });
  try { await rename(quarantine, retirement.path); }
  catch (error) {
    try { await removeEmptyScopeRetirementDirectory(retirement); } catch { /* preserve an ambiguous retirement directory */ }
    if (error.code === "ENOENT") return false;
    throw error;
  }
  return restoreRetiredScopeLock(path, retirement, stat);
}

async function retireOwnedScopeLock(path, expectedStat, expectedLock, {
  restorePath = path,
  stale = null,
  afterRetirement = async () => {},
  modeCapability
} = {}) {
  const current = await readScopeLock(path);
  if (!current || !sameScopeLockInode(current.stat, expectedStat) || !sameScopeLockOwner(current.lock, expectedLock)) return false;
  const retirement = await privateScopeRetirement(path, { modeCapability });
  try { await rename(path, retirement.path); }
  catch (error) {
    try { await removeEmptyScopeRetirementDirectory(retirement); } catch { /* preserve an ambiguous retirement directory */ }
    if (error.code === "ENOENT") return false;
    throw error;
  }
  await afterRetirement({ dir: retirement.dir, path: retirement.path, sourcePath: path });
  await assertPrivateScopeRetirementDirectory(retirement.dir, retirement);
  let retired;
  try { retired = await readScopeLock(retirement.path); }
  catch { return false; }
  if (!retired || !sameScopeLockInode(retired.stat, expectedStat) || !sameScopeLockOwner(retired.lock, expectedLock)) {
    return false;
  }
  if (stale && !await stale(retired)) {
    await restoreRetiredScopeLock(restorePath, retirement, expectedStat);
    return false;
  }
  await assertPrivateScopeRetirementDirectory(retirement.dir, retirement);
  const final = await readScopeLock(retirement.path);
  if (!final || !sameScopeLockInode(final.stat, expectedStat) || !sameScopeLockOwner(final.lock, expectedLock)) return false;
  await unlink(retirement.path);
  await removeEmptyScopeRetirementDirectory(retirement);
  return true;
}

async function releaseScopeLock(path, token, {
  beforeRelease = async () => {},
  afterRetirement = async () => {},
  modeCapability = defaultScopeRetirementModeCapability
} = {}) {
  const state = await readScopeLock(path);
  if (!state || state.lock.token !== token) throw new Error(`Codex managed-scope lock ownership changed: ${path}`);
  await beforeRelease({ path });
  if (!await retireOwnedScopeLock(path, state.stat, state.lock, { afterRetirement, modeCapability })) {
    throw new Error(`Codex managed-scope lock ownership changed: ${path}`);
  }
}

async function acquireRecoveryScopeLock(path, token, lockOptions) {
  try {
    await writeExclusiveSafe(path, await scopeLockText(token));
    return true;
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
  }
  const state = await readScopeLock(path);
  if (!state || !await staleScopeLock(state)) return false;
  if (!await retireOwnedScopeLock(path, state.stat, state.lock, {
    stale: staleScopeLock,
    afterRetirement: lockOptions?.afterRetirement,
    modeCapability: lockOptions?.modeCapability
  })) return false;
  try {
    await writeExclusiveSafe(path, await scopeLockText(token));
    return true;
  } catch (error) {
    if (error.code === "EEXIST") return false;
    throw error;
  }
}

async function recoverStaleScopeLock(path, {
  afterQuarantine = async () => {},
  afterValidation = async () => {},
  afterRetirement = async () => {},
  modeCapability = defaultScopeRetirementModeCapability
} = {}) {
  const recoveryPath = `${path}.recover`, token = randomUUID();
  if (!await acquireRecoveryScopeLock(recoveryPath, token, { afterRetirement, modeCapability })) return false;
  try {
    const state = await readScopeLock(path);
    if (!state || !await staleScopeLock(state)) return false;
    const quarantine = `${path}.muster-reclaim-${process.pid}-${randomUUID()}`;
    try { await rename(path, quarantine); }
    catch (error) { if (error.code === "ENOENT") return true; throw error; }
    await afterQuarantine({ path, quarantine });
    const quarantined = await readScopeLock(quarantine);
    if (!quarantined || !sameScopeLockInode(quarantined.stat, state.stat)
      || !sameScopeLockOwner(quarantined.lock, state.lock) || !await staleScopeLock(quarantined)) {
      if (quarantined) await restoreQuarantinedScopeLock(path, quarantine, quarantined.stat, { modeCapability });
      return false;
    }
    await afterValidation({ path, quarantine });
    const finalCandidate = await readScopeLock(quarantine);
    if (!finalCandidate) return false;
    if (!sameScopeLockInode(finalCandidate.stat, quarantined.stat) || !sameScopeLockOwner(finalCandidate.lock, quarantined.lock)
      || !await staleScopeLock(finalCandidate)) {
      await restoreQuarantinedScopeLock(path, quarantine, finalCandidate.stat, { modeCapability });
      return false;
    }
    return retireOwnedScopeLock(quarantine, finalCandidate.stat, finalCandidate.lock, {
      restorePath: path,
      stale: staleScopeLock,
      afterRetirement,
      modeCapability
    });
  } finally {
    await releaseScopeLock(recoveryPath, token, { afterRetirement, modeCapability });
  }
}

async function acquireScopeLock(home, {
  maxAttempts = 1_000,
  afterAcquire = async () => {},
  afterQuarantine = async () => {},
  afterValidation = async () => {},
  afterRetirement = async () => {},
  modeCapability = defaultScopeRetirementModeCapability
} = {}) {
  const path = scopeRegistryLockPath(home), token = randomUUID();
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      await writeExclusiveSafe(path, await scopeLockText(token));
      await afterAcquire({ path, token });
      return { path, token };
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
    }
    const state = await readScopeLock(path);
    if (!state || ((await staleScopeLock(state)) && await recoverStaleScopeLock(path, { afterQuarantine, afterValidation, afterRetirement, modeCapability }))) continue;
    await pause(10);
  }
  throw new Error(`Codex managed-scope lock did not become available: ${path}`);
}

async function withScopeRegistryTransaction(home, action, lockOptions) {
  const held = await acquireScopeLock(home, lockOptions);
  try { return await action(await readScopeRegistry(home)); }
  finally { await releaseScopeLock(held.path, held.token, lockOptions); }
}

// Temp-write-then-rename via fs-safe.js's shared atomicWrite (audit S4); the
// ordinary-directory/regular-file re-assertions stay as the beforeRename hook
// so a swap landing between staging and publish still aborts before the
// rename. Temp naming is preserved verbatim.
async function atomicWriteSafe(path, content) {
  const parent = dirname(path);
  let stagedIdentity = null;
  await ordinaryDirectoryPath(parent, { create: true });
  await regularFileState(path);
  await atomicWrite(path, content, {
    tempName: (targetPath) => join(parent, `.${basename(targetPath)}.muster-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.tmp`),
    beforeRename: async (temporary) => {
      const staged = await regularFileState(temporary);
      stagedIdentity = { dev: String(staged.dev), ino: String(staged.ino) };
      await ordinaryDirectoryPath(parent);
      await regularFileState(path);
    },
  });
  const published = await physicalFileSnapshot(path);
  if (!published.exists || published.dev !== stagedIdentity?.dev || published.ino !== stagedIdentity?.ino) {
    throw new Error(`Codex configuration target changed immediately after Muster wrote it: ${path}`);
  }
  return published;
}

async function removeSafe(path) {
  const stat = await regularFileState(path);
  if (stat) await unlink(path);
}
const profileFiles = async root => (await readdirSafe(root)).filter(name => name.endsWith(".toml")).sort();
const run = (execFile, args, runtimeIdentity) => runtimeIdentity
  ? runCodexCommand(execFile, runtimeIdentity, args, { timeout: 30_000, maxBuffer: 4 * 1024 * 1024 })
  : execFile("muster:injected-codex-runner", args, { timeout: 30_000, maxBuffer: 4 * 1024 * 1024 });
async function runJson(execFile, args, runtimeIdentity) { return JSON.parse((await run(execFile, args, runtimeIdentity)).stdout); }

// Defense in depth (arbitrary-write containment) behind generateCodexProfiles'
// manifest-id guard: every profile filename here is one join() away from
// becoming a write destination under `dir`. generateCodexProfiles already
// rejects unsafe manifest ids at the trust boundary and profileFiles only
// yields readdir basenames, but re-assert -- BEFORE any safeExists probe or
// atomicWriteSafe touches it -- that each name is a bare `<id>.toml` resolving
// back inside `dir`. A traversing name must never read or write outside
// agentsDir. Mirrors validateManagedFiles' basename/containment shape.
export function assertContainedProfiles(files, dir) {
  const base = resolve(dir);
  for (const file of files) {
    if (typeof file !== "string" || file !== basename(file) || !PROFILE_FILENAME.test(file) || dirname(resolve(base, file)) !== base) {
      throw new Error(`Refusing to write a Codex profile outside ${dir}: ${JSON.stringify(file)}`);
    }
  }
}

function validateManagedFiles(manifest, dir, manifestPath) {
  if (manifest?.owner !== "muster" || manifest.format !== 1 || !Array.isArray(manifest.files)) {
    throw new Error(`Codex installation manifest conflict: ${manifestPath}. Move it or remove it, then rerun the command.`);
  }
  if ((manifest.declarationConfigCreated !== undefined && typeof manifest.declarationConfigCreated !== "boolean")
    || (manifest.declarationSeparatorAdded !== undefined && typeof manifest.declarationSeparatorAdded !== "boolean")
    || (manifest.declarationRegion !== undefined
      && (manifest.declarationRegion?.format !== 1
        || manifest.declarationRegion.algorithm !== "sha256"
        || !/^[a-f0-9]{64}$/.test(manifest.declarationRegion.digest)))) {
    throw new Error(`Codex installation manifest conflict: ${manifestPath}. Move it or remove it, then rerun the command.`);
  }
  const base = resolve(dir), seen = new Set();
  for (const file of manifest.files) {
    const destination = typeof file === "string" ? resolve(base, file) : "";
    if (typeof file !== "string" || file !== basename(file) || dirname(destination) !== base || !PROFILE_FILENAME.test(file) || seen.has(file)) {
      throw new Error(`Invalid Muster-owned Codex profile in ${manifestPath}: ${JSON.stringify(file)}. Remove the invalid manifest before retrying.`);
    }
    seen.add(file);
  }
  return [...seen];
}

function agentDescription(profile, file) {
  const match = String(profile).match(/^description\s*=\s*("(?:[^"\\]|\\.)*")\s*(?:#.*)?$/m);
  if (!match) throw new Error(`Codex profile ${file} has no valid description`);
  try {
    const description = JSON.parse(match[1]);
    if (typeof description !== "string" || !description) throw new Error("empty description");
    return description;
  } catch (error) {
    throw new Error(`Codex profile ${file} has no valid description`, { cause: error });
  }
}

function declarationRegion(declarations, newline = "\n") {
  const lines = [AGENT_DECLARATIONS_START];
  for (const [name, description] of declarations) {
    lines.push(
      `[agents.${name}]`,
      `description = ${JSON.stringify(description)}`,
      `config_file = ${JSON.stringify(`agents/${name}.toml`)}`,
      ""
    );
  }
  lines.push(AGENT_DECLARATIONS_END);
  return lines.join(newline) + newline;
}

function declarationBounds(text) {
  const markerLines = marker => [...text.matchAll(new RegExp(`^${escapeRe(marker)}\\r?$`, "gm"))];
  const starts = markerLines(AGENT_DECLARATIONS_START);
  const ends = markerLines(AGENT_DECLARATIONS_END);
  if (starts.length !== ends.length || starts.length > 1
    || (starts.length === 1 && ends[0].index < starts[0].index)) {
    throw new Error("Codex config.toml has malformed Muster agent declaration ownership markers");
  }
  if (!starts.length) return null;
  const start = starts[0].index;
  let end = ends[0].index + ends[0][0].length;
  if (text.startsWith("\r\n", end)) end += 2;
  else if (text.startsWith("\n", end)) end += 1;
  return { start, end };
}

function declarationRegionReceipt(text) {
  const bounds = declarationBounds(text);
  if (!bounds) throw new Error("Cannot receipt a missing Muster agent declaration region");
  return {
    format: 1,
    algorithm: "sha256",
    digest: createHash("sha256").update(text.slice(bounds.start, bounds.end), "utf8").digest("hex")
  };
}

function verifiedDeclarationBounds(text, receipt, manifestPath) {
  const bounds = declarationBounds(text);
  if (!receipt) {
    if (bounds) {
      throw new Error(`Codex config.toml has Muster agent declaration markers without an explicit ownership receipt in ${manifestPath}. Move or remove the ambiguous markers before retrying.`);
    }
    return null;
  }
  if (!bounds) {
    throw new Error(`Codex agent declaration integrity check failed: the receipted region from ${manifestPath} is missing.`);
  }
  const digest = createHash("sha256").update(text.slice(bounds.start, bounds.end), "utf8").digest("hex");
  if (digest !== receipt.digest) {
    throw new Error(`Codex agent declaration integrity check failed: the receipted region from ${manifestPath} was modified.`);
  }
  return bounds;
}

function removeAgentDeclarations(text, { separatorAdded = false, receipt, manifestPath } = {}) {
  const bounds = verifiedDeclarationBounds(text, receipt, manifestPath);
  if (!bounds) return text;
  let start = bounds.start;
  if (separatorAdded && bounds.end === text.length) {
    if (text.slice(Math.max(0, start - 2), start) === "\r\n") start -= 2;
    else if (text[start - 1] === "\n") start -= 1;
    else throw new Error("Codex config.toml Muster agent declaration separator was modified");
  }
  return text.slice(0, start) + text.slice(bounds.end);
}

function agentDeclarationHeaderPath(line) {
  let cursor = 0;
  const whitespace = () => { while (/\s/.test(line[cursor] ?? "")) cursor++; };
  const component = () => {
    const start = cursor;
    if (line[cursor] === "'" || line[cursor] === '"') {
      const quote = line[cursor++];
      while (cursor < line.length) {
        if (line[cursor] === quote) {
          cursor++;
          return decodeTomlQuotedKey(line.slice(start, cursor));
        }
        if (quote === '"' && line[cursor] === "\\") cursor++;
        cursor++;
      }
      return null;
    }
    const match = line.slice(cursor).match(/^[A-Za-z0-9_-]+/);
    if (!match) return null;
    cursor += match[0].length;
    return match[0];
  };

  whitespace();
  if (line[cursor++] !== "[") return null;
  whitespace();
  const first = component();
  if (first === null) return null;
  whitespace();
  if (line[cursor++] !== ".") return null;
  whitespace();
  const second = component();
  if (second === null) return null;
  whitespace();
  if (line[cursor++] !== "]") return null;
  whitespace();
  if (cursor < line.length && line[cursor] !== "#") return null;
  return [first, second];
}

function foreignAgentDeclarationNames(text) {
  const names = new Set();
  for (const line of text.split(/\r?\n/)) {
    const path = agentDeclarationHeaderPath(line);
    if (path?.[0] === "agents") names.add(path[1]);
  }
  return names;
}

function reconcileAgentDeclarations(text, declarations, { separatorAdded = false, receipt, manifestPath } = {}) {
  const unrelated = removeAgentDeclarations(text, { separatorAdded, receipt, manifestPath });
  const foreignNames = foreignAgentDeclarationNames(unrelated);
  for (const name of declarations.keys()) {
    if (foreignNames.has(name)) {
      throw new Error(`Codex agent declaration conflict for ${name}. Move or remove the unrelated [agents.${name}] table, then rerun muster install codex.`);
    }
  }
  const newline = unrelated.includes("\r\n") ? "\r\n" : "\n";
  const region = declarationRegion(declarations, newline);
  const nextSeparatorAdded = unrelated !== "" && !unrelated.endsWith("\n");
  return {
    text: unrelated + (nextSeparatorAdded ? newline : "") + region,
    separatorAdded: nextSeparatorAdded,
    receipt: declarationRegionReceipt(unrelated + (nextSeparatorAdded ? newline : "") + region)
  };
}

function validateHookManifest(manifest, dir, manifestPath) {
  if (manifest?.owner !== "muster" || manifest.format !== 1 || !Array.isArray(manifest.files) || typeof manifest.hookGroups !== "object" || !manifest.hookGroups) {
    throw new Error(`Codex hook installation manifest conflict: ${manifestPath}. Move it or remove it, then rerun the command.`);
  }
  const base = resolve(dir), seen = new Set();
  for (const file of manifest.files) {
    const destination = typeof file === "string" ? resolve(base, file) : "";
    const rel = destination ? relative(base, destination) : "";
    if (typeof file !== "string" || !file || isAbsolute(file) || rel === ".." || rel.startsWith(`..${sep}`) || seen.has(file)) {
      throw new Error(`Invalid Muster-owned Codex hook runtime in ${manifestPath}: ${JSON.stringify(file)}. Remove the invalid manifest before retrying.`);
    }
    seen.add(file);
  }
  return { files: [...seen], hookGroups: manifest.hookGroups, hookConfigCreated: manifest.hookConfigCreated === true };
}

function validateThreadLimitManifest(manifest, manifestPath, expectedConfigPath) {
  const currentKeys = Object.keys(REQUIRED_CODEX_THREAD_LIMITS);
  const legacyKeys = ["max_threads", "max_depth"];
  const receiptInteger = value => typeof value === "string"
    && /^[1-9]\d*$/.test(value)
    && BigInt(value) > BigInt(Number.MAX_SAFE_INTEGER)
    ? BigInt(value)
    : Number.isSafeInteger(value) && value >= 0 ? BigInt(value) : null;
  const sameReceiptInteger = (left, right) => {
    const leftExact = receiptInteger(left);
    const rightExact = receiptInteger(right);
    return leftExact !== null && rightExact !== null && leftExact === rightExact;
  };
  const schemaFor = value => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const keys = Object.keys(value).sort();
    const exact = schema => keys.length === schema.length
      && keys.every((key, index) => key === [...schema].sort()[index]);
    const schema = exact(currentKeys) ? "current" : exact(legacyKeys) ? "legacy" : null;
    return schema && Object.values(value).every(item => item === null || receiptInteger(item) !== null)
      ? schema
      : null;
  };
  const beforeSchema = schemaFor(manifest?.before);
  const installedSchema = schemaFor(manifest?.installed);
  const legacyInstalledValue = (before, floor) => {
    const exact = receiptInteger(before) ?? 0n;
    return exact > BigInt(floor) ? exact : BigInt(floor);
  };
  const validLegacyReceipt = beforeSchema !== "legacy" || (
    receiptInteger(manifest.installed.max_threads) === legacyInstalledValue(manifest.before.max_threads, 12)
    && receiptInteger(manifest.installed.max_depth) === legacyInstalledValue(manifest.before.max_depth, 2)
  );
  const validCurrentReceipt = beforeSchema !== "current" || (
    (manifest.before.max_concurrent_threads_per_session === null
      || (receiptInteger(manifest.before.max_concurrent_threads_per_session) > 0n
        && sameReceiptInteger(
          manifest.before.max_concurrent_threads_per_session,
          manifest.installed.max_concurrent_threads_per_session,
        )))
    && receiptInteger(manifest.installed.max_concurrent_threads_per_session) > 0n
  );
  if (manifest?.owner !== "muster" || manifest.format !== 1 || manifest.configPath !== expectedConfigPath
    || typeof manifest.configCreated !== "boolean" || typeof manifest.sectionCreated !== "boolean"
    || !beforeSchema || beforeSchema !== installedSchema || !validLegacyReceipt || !validCurrentReceipt) {
    throw new Error(`Codex thread-limit manifest conflict: ${manifestPath}. Move it or remove it, then rerun the command.`);
  }
  return manifest;
}

function clone(value) { return JSON.parse(JSON.stringify(value)); }
const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);
const groupCommands = group => (group?.hooks || []).flatMap(hook => [hook?.command, hook?.commandWindows, hook?.command_windows]).filter(Boolean);
const MUSTER_HOOK_POSIX_SUFFIX = "/muster/hooks/muster-hook.mjs";
const MUSTER_HOOK_WINDOWS_SUFFIX = "\\muster\\hooks\\muster-hook.mjs";
export function isMusterHookCommand(command) {
  if (typeof command !== "string") return false;
  if (command.replaceAll("\\", "/").toLowerCase().includes("muster-hook.mjs")) return true;
  for (const windows of [false, true]) {
    const parsed = parseHookCommand(command, { windows });
    if (!parsed) continue;
    const script = parsed.script;
    if (posix.isAbsolute(script) && posix.normalize(script).endsWith(MUSTER_HOOK_POSIX_SUFFIX)) return true;
    if (win32.isAbsolute(script) && win32.normalize(script).toLowerCase().endsWith(MUSTER_HOOK_WINDOWS_SUFFIX)) return true;
  }
  return false;
}

function shellPathCandidates(command) {
  if (typeof command !== "string") return [];
  const candidates = new Set();
  const addCandidate = value => {
    if (!value) return;
    candidates.add(value);
    const assignment = value.match(/^[A-Za-z_][A-Za-z0-9_]*=(.+)$/s);
    if (assignment?.[1]) candidates.add(assignment[1].replace(/^["']+|["']+$/g, ""));
    const option = value.match(/^(?:--?|\/)[^:=\s]+[:=](.+)$/s);
    if (option?.[1]) candidates.add(option[1].replace(/^["']+|["']+$/g, ""));
  };
  for (const tokens of [parsePosixShellTokens(command), parseWindowsShellTokens(command)]) {
    if (tokens) for (const token of tokens) addCandidate(token);
  }
  for (const match of command.matchAll(/'([^']+)'|"([^"]+)"/g)) addCandidate(match[1] ?? match[2]);
  for (const token of command.split(/[\s;&|<>()]+/)) {
    const value = token.replace(/^["']+|["']+$/g, "");
    addCandidate(value);
  }
  return [...candidates].filter(value => value && !value.startsWith("-"));
}

function hasDynamicInterpreterEval(command) {
  for (const tokens of [parsePosixShellTokens(command), parseWindowsShellTokens(command)]) {
    if (!tokens) continue;
    for (let index = 0; index < tokens.length; index++) {
      const executable = tokens[index].replaceAll("\\", "/").split("/").pop().toLowerCase();
      const flags = [];
      for (const rawFlag of tokens.slice(index + 1)) {
        if (rawFlag === "--") break;
        flags.push(rawFlag.toLowerCase());
      }
      if (["sh", "bash", "dash", "fish", "ksh", "zsh", "sh.exe", "bash.exe", "dash.exe", "fish.exe", "ksh.exe", "zsh.exe"].includes(executable)
        && flags.some(flag => /^-[^-]*c/.test(flag))) return true;
      if (["cmd", "cmd.exe"].includes(executable) && flags.some(flag => /^\/(?:c|k)/i.test(flag))) return true;
      if (["powershell", "powershell.exe", "pwsh", "pwsh.exe"].includes(executable)
        && flags.some(flag => /^-(?:c|command|e|enc|encodedcommand)$/i.test(flag))) return true;
      if (/^(?:pythonw?|pypy)(?:\d+(?:\.\d+)*)?(?:\.exe)?$/.test(executable)
        && flags.some(flag => flag.startsWith("-c"))) return true;
      if (/^(?:ruby|perl|lua|luajit|r|rscript|osascript)(?:\.exe)?$/.test(executable)
        && flags.some(flag => /^-[^-]*e/i.test(flag))) return true;
      if (/^php(?:\.exe)?$/.test(executable) && flags.some(flag => /^-[^-]*r/i.test(flag))) return true;
      if (!["node", "node.exe", "nodejs", "nodejs.exe", "bun", "bun.exe", "deno", "deno.exe"].includes(executable)) continue;
      for (let flagIndex = 0; flagIndex < flags.length; flagIndex++) {
        const moduleOption = flags[flagIndex].match(/^--(?:experimental-loader|import|loader|preload)(?:=(.*))?$/);
        if (!moduleOption) continue;
        const specifier = moduleOption[1] ?? flags[flagIndex + 1];
        if (specifier && /^[a-z][a-z0-9+.-]*:/i.test(specifier)
          && !/^file:/i.test(specifier) && !win32.isAbsolute(specifier)) return true;
      }
      for (const flag of flags) {
        if (/^-[^-]*[ep]/.test(flag) || flag === "--eval" || flag.startsWith("--eval=")
          || flag === "--print" || flag.startsWith("--print=")
          || ((executable === "deno" || executable === "deno.exe") && flag === "eval")) return true;
      }
    }
  }
  return false;
}

const hasUnresolvedShellExpansion = command => typeof command === "string"
  && (/[\r\n]/.test(command)
    || /(^|[^\\])(?:\$[({A-Za-z_]|`)/.test(command)
    || /![^!\r\n]+!|%[^%\r\n]+%|%[0-9*~]/.test(command)
    || /(^|[\s=])~(?:[\\/]|$)|[*?]|\[[^\]\r\n]*\]/.test(command)
    || /(?:^|[;&|('"\s])(?:cd|chdir|pushd|popd)(?:\s|$)/i.test(command)
    || (!parsePosixShellTokens(command) && !parseWindowsShellTokens(command))
    || hasDynamicInterpreterEval(command));

async function physicalHookIdentity(path) {
  const canonical = await realpath(path);
  const metadata = await stat(canonical);
  if (metadata.ino !== 0) return `inode:${metadata.dev}:${metadata.ino}`;
  return `path:${process.platform === "win32" ? canonical.toLowerCase() : canonical}`;
}

export async function hasMusterHookCommandAlias(config, expectedScripts, { cwds = [], includeDirect = false } = {}) {
  const expectedIdentities = new Set();
  for (const expectedScript of Array.isArray(expectedScripts) ? expectedScripts : [expectedScripts]) {
    try { expectedIdentities.add(await physicalHookIdentity(expectedScript)); } catch { /* absent managed runtimes cannot be alias targets */ }
  }
  if (!expectedIdentities.size) return false;
  for (const groups of Object.values(config?.hooks || {})) {
    if (!Array.isArray(groups)) continue;
    for (const group of groups) for (const command of groupCommands(group)) {
      if (!includeDirect && isMusterHookCommand(command)) continue;
      if (hasUnresolvedShellExpansion(command)) return true;
      for (const candidate of shellPathCandidates(command)) {
        let filesystemCandidate = candidate;
        if (/^file:/i.test(candidate)) {
          try { filesystemCandidate = fileURLToPath(candidate); }
          catch { return true; }
        }
        const paths = posix.isAbsolute(filesystemCandidate) || win32.isAbsolute(filesystemCandidate)
          ? [filesystemCandidate]
          : cwds.map(cwd => resolve(cwd, filesystemCandidate));
        for (const path of paths) try {
          if (expectedIdentities.has(await physicalHookIdentity(path))) return true;
        } catch { /* missing and foreign scripts are not managed aliases */ }
      }
    }
  }
  return false;
}

export async function hasManagedRuntimeInventoryAlias(inventory, { cwd, hooksJsonPath, activationSnapshot }) {
  const scope = Array.isArray(inventory?.data) ? inventory.data.find(entry => entry?.cwd === cwd) : null;
  if (!scope || !Array.isArray(scope.hooks)) return false;
  const commands = scope.hooks.flatMap(hook => {
    const parsed = parseInventoryHook(hook);
    return parsed && parsed.path !== hooksJsonPath && typeof hook.command === "string" ? [hook.command] : [];
  });
  if (!commands.length) return false;
  if (commands.some(hasUnresolvedShellExpansion)) return true;
  const expectedScripts = [...activationSnapshot.keys()].filter(path => path.endsWith(join("muster", "hooks", "muster-hook.mjs")));
  const config = { hooks: { Stop: commands.map(command => ({ hooks: [{ command }] })) } };
  return hasMusterHookCommandAlias(config, expectedScripts, { cwds: [cwd], includeDirect: true });
}

export async function inventoryAliasCandidateSnapshot(inventory, { cwd, hooksJsonPath }) {
  const scope = Array.isArray(inventory?.data) ? inventory.data.find(entry => entry?.cwd === cwd) : null;
  const paths = new Set();
  for (const hook of Array.isArray(scope?.hooks) ? scope.hooks : []) {
    const parsed = parseInventoryHook(hook);
    if (!parsed || parsed.path === hooksJsonPath || typeof hook.command !== "string") continue;
    for (const candidate of shellPathCandidates(hook.command)) {
      let filesystemCandidate = candidate;
      if (/^file:/i.test(candidate)) {
        try { filesystemCandidate = fileURLToPath(candidate); }
        catch { paths.add(`invalid:${candidate}`); continue; }
      }
      for (const path of posix.isAbsolute(filesystemCandidate) || win32.isAbsolute(filesystemCandidate)
        ? [filesystemCandidate] : [resolve(cwd, filesystemCandidate)]) paths.add(path);
    }
  }
  const snapshot = new Map();
  for (const path of [...paths].sort()) {
    if (path.startsWith("invalid:")) { snapshot.set(path, { invalid: true }); continue; }
    try {
      const linkMetadata = await lstat(path);
      const canonical = await realpath(path);
      const targetMetadata = await stat(canonical);
      snapshot.set(path, { canonical, linkDev: linkMetadata.dev, linkIno: linkMetadata.ino, targetDev: targetMetadata.dev, targetIno: targetMetadata.ino });
    } catch (error) {
      snapshot.set(path, { missing: error.code === "ENOENT", code: error.code || "ERROR" });
    }
  }
  return snapshot;
}

export const sameAliasCandidateSnapshot = (left, right) => same([...left], [...right]);

async function verifiedHookInventory({ inventoryReader, inventoryArgs, cwd, hooksJsonPath, activationSnapshot }) {
  const first = await inventoryReader(inventoryArgs);
  const candidatesFirst = await inventoryAliasCandidateSnapshot(first, { cwd, hooksJsonPath });
  const inventory = await inventoryReader(inventoryArgs);
  const candidatesBeforeAlias = await inventoryAliasCandidateSnapshot(inventory, { cwd, hooksJsonPath });
  const alias = await hasManagedRuntimeInventoryAlias(inventory, { cwd, hooksJsonPath, activationSnapshot });
  const candidatesAfterAlias = await inventoryAliasCandidateSnapshot(inventory, { cwd, hooksJsonPath });
  return {
    inventory,
    alias,
    stable: same(first, inventory)
      && sameAliasCandidateSnapshot(candidatesFirst, candidatesBeforeAlias)
      && sameAliasCandidateSnapshot(candidatesBeforeAlias, candidatesAfterAlias)
  };
}

function exactMusterHookGroups(config, expectedHookGroups) {
  if (!config?.hooks || typeof config.hooks !== "object" || Array.isArray(config.hooks)) return false;
  const expected = [];
  for (const [event, groups] of Object.entries(expectedHookGroups || {})) {
    if (!Array.isArray(groups)) return false;
    for (const group of groups) {
      if (!groupCommands(group).some(isMusterHookCommand)) return false;
      expected.push({ event, group });
    }
  }
  const actual = [];
  for (const [event, groups] of Object.entries(config.hooks)) {
    if (!Array.isArray(groups)) return false;
    for (const group of groups) if (groupCommands(group).some(isMusterHookCommand)) actual.push({ event, group });
  }
  if (!expected.length || actual.length !== expected.length) return false;
  for (const item of expected) {
    const index = actual.findIndex(candidate => candidate.event === item.event && same(candidate.group, item.group));
    if (index < 0) return false;
    actual.splice(index, 1);
  }
  return actual.length === 0;
}

export function codexHookStateKeys(config) {
  const keys = [];
  for (const [event, groups] of Object.entries(config?.hooks || {})) {
    if (!Array.isArray(groups)) continue;
    for (let groupIndex = 0; groupIndex < groups.length; groupIndex++) {
      const hooks = Array.isArray(groups[groupIndex]?.hooks) ? groups[groupIndex].hooks : [];
      for (let hookIndex = 0; hookIndex < hooks.length; hookIndex++) keys.push(`${hookStateEventName(event)}:${groupIndex}:${hookIndex}`);
    }
  }
  return keys;
}

function removeOwnedHookGroups(config, owned, configPath) {
  const next = clone(config);
  next.hooks ||= {};
  for (const [event, groups] of Object.entries(owned || {})) {
    if (!Array.isArray(groups)) throw new Error(`Invalid Muster-owned Codex hook groups in ${configPath}: ${event}`);
    const current = Array.isArray(next.hooks[event]) ? next.hooks[event] : [];
    for (const group of groups) {
      const exact = current.findIndex(candidate => same(candidate, group));
      if (exact >= 0) current.splice(exact, 1);
      else if (current.some(candidate => groupCommands(candidate).some(command => groupCommands(group).includes(command)))) {
        throw new Error(`Codex hook conflict: a Muster-owned hook was modified in ${configPath}. Restore it or remove the Muster hook manifest before retrying.`);
      }
    }
    if (current.length) next.hooks[event] = current;
    else delete next.hooks[event];
  }
  return next;
}

export function formatCodexWindowsPath(path) {
  const normalized = path.replaceAll("\\", "/");
  const wslDrive = normalized.match(/^\/mnt\/([a-z])(?:\/(.*))?$/i);
  if (wslDrive) return `${wslDrive[1].toUpperCase()}:/${wslDrive[2] || ""}`.replace(/\/$/, "");
  const windowsDrive = normalized.match(/^([a-z]):\/(.*)$/i);
  return windowsDrive ? `${windowsDrive[1].toUpperCase()}:/${windowsDrive[2]}` : normalized;
}

const posixShellQuote = value => `'${value.replaceAll("'", `'\\''`)}'`;
const windowsShellQuote = value => `"${formatCodexWindowsPath(value).replaceAll('"', '\\"')}"`;

// Pin an ABSOLUTE, validated Node interpreter into the generated hook commands
// instead of a bare `node` (run-5 security audit Med #5, src/codex-install.js):
// a bare `node` is resolved through PATH on EVERY lifecycle event, so an
// attacker who prepends a directory to PATH with a malicious `node` hijacks the
// interpreter on every hook fire. `process.execPath` is machine-specific --
// exactly like the hook SCRIPT path this same command already bakes (the reason
// .codex/hooks.json is gitignored, not tracked; see scripts/check-codex.mjs) --
// so pinning it stays consistent with the existing per-checkout, machine-baked
// trust model rather than introducing a new kind of machine dependence.
function shellCommand(scriptPath, nodePath) {
  for (const value of [nodePath, scriptPath]) {
    if (/[\r\n\0]/.test(value)) throw new Error(`Codex hook path contains unsupported control characters: ${value}`);
  }
  return {
    command: `${posixShellQuote(nodePath)} ${posixShellQuote(scriptPath)}`,
    commandWindows: `${windowsShellQuote(nodePath)} ${windowsShellQuote(scriptPath)}`
  };
}

// Resolve the current Node executable to an absolute path and validate it is an
// ordinary regular file before it is baked into a hook command's interpreter
// slot. Follows symlinks (a nvm/homebrew node reached through a symlink is a
// legitimate interpreter) but rejects a missing path, a directory, or a
// non-absolute value so a bare/relative token can never be emitted.
async function validatedHookNode(execPath) {
  if (typeof execPath !== "string" || !execPath || !isAbsolute(execPath)) {
    throw new Error(`Cannot pin the Codex hook Node interpreter: ${JSON.stringify(execPath)} is not an absolute path. Rerun muster install codex from a normal Node installation.`);
  }
  let info;
  try { info = await stat(execPath); }
  catch (error) { throw new Error(`Cannot pin the Codex hook Node interpreter: ${execPath} is not accessible (${error.code || error.message}). Rerun muster install codex from a normal Node installation.`); }
  if (!info.isFile()) throw new Error(`Cannot pin the Codex hook Node interpreter: ${execPath} is not a regular file. Rerun muster install codex from a normal Node installation.`);
  return realpath(execPath);
}

// Parse a hook command emitted by shellCommand back into its two pinned tokens.
// POSIX (`command`): single-quoted segments with '\'' escaping. Windows
// (`commandWindows`): double-quoted segments with \" escaping. Returns
// { interpreter, script } or null when the string is not the expected
// two-token shape -- used by `muster doctor --codex` to verify the persisted
// interpreter still exists, and by scripts/check-codex.mjs to coherence-check a
// materialized hooks.json against this checkout.
export function parseHookCommand(command, { windows = false } = {}) {
  if (typeof command !== "string" || /[\0\r\n]/.test(command)) return null;
  const tokens = typeof command === "string" ? (windows ? parseWindowsShellTokens(command) : parsePosixShellTokens(command)) : null;
  return tokens && tokens.length === 2 ? { interpreter: tokens[0], script: tokens[1] } : null;
}

function parsePosixShellTokens(command) {
  const tokens = [];
  let index = 0;
  while (index < command.length) {
    while (index < command.length && (command[index] === " " || command[index] === "\t")) index++;
    if (index >= command.length) break;
    let token = "";
    while (index < command.length && command[index] !== " " && command[index] !== "\t") {
      const char = command[index];
      if (";&|<>()`".includes(char) || char === "$") return null;
      if (char === "'") {
        index++;
        while (index < command.length && command[index] !== "'") token += command[index++];
        if (index >= command.length) return null;
        index++;
      } else if (char === '"') {
        index++;
        while (index < command.length && command[index] !== '"') {
          if ("$`".includes(command[index])) return null;
          if (command[index] === "\\" && index + 1 < command.length) {
            const escaped = command[index + 1];
            if ('$`"\\'.includes(escaped)) token += escaped;
            else token += `\\${escaped}`;
            index += 2;
          }
          else token += command[index++];
        }
        if (index >= command.length) return null;
        index++;
      } else if (char === "\\") {
        if (index + 1 >= command.length) return null;
        token += command[index + 1];
        index += 2;
      } else {
        token += char;
        index++;
      }
    }
    tokens.push(token);
  }
  return tokens;
}

function parseWindowsShellTokens(command) {
  const tokens = [];
  let index = 0;
  while (index < command.length) {
    while (index < command.length && (command[index] === " " || command[index] === "\t")) index++;
    if (index >= command.length) break;
    if (command[index] !== '"') return null;
    index++;
    let token = "";
    while (index < command.length && command[index] !== '"') {
      if (command[index] === "\\" && command[index + 1] === '"') { token += '"'; index += 2; }
      else token += command[index++];
    }
    if (index >= command.length) return null;
    index++;
    tokens.push(token);
    if (index < command.length && command[index] !== " " && command[index] !== "\t") return null;
  }
  return tokens;
}

// Canonical-scope collapse (2026-07-18 decision, doctor's codex-hooks-overlap
// check): the user scope is canonical for Codex hooks. A project-scope
// install skips writing its own hook runtime/config entirely once the USER
// scope already carries a healthy Muster hook install -- installing project
// hooks on top would only double-fire every event (hook-bombardment), and a
// REINSTALL is how a dual-scope machine converges to one firing scope
// instead of requiring a manual `muster uninstall codex --scope project`.
// Read-only and best-effort: any validation failure (corrupt manifest,
// missing/foreign hooks.json, a group that no longer matches exactly)
// reports "not healthy" rather than throwing, so a broken user scope never
// silently blocks a project-scope install -- that project scope just
// installs its own hooks exactly as it always has (prepareHooks below only
// calls this for scope === "project"; the user scope is never a candidate
// to skip its own hooks).
//
// Requires the user manifest's OWN recorded `packageVersion` to match the
// version about to be installed (review fix: a self-consistent-but-stale
// user manifest -- e.g. missing an event a newer template added -- used to
// report "healthy" purely from internal agreement between its own manifest
// and its own hooks.json, silently skipping the project scope's install and
// leaving that event firing from NEITHER scope with no signal at install
// time; `muster doctor --codex` would eventually catch the drift, but only
// if rerun). A version mismatch fails closed to "not healthy" here, exactly
// like every other validation failure above -- the project scope then
// installs its own (current) hooks rather than trusting a stale peer.
export async function expectedCodexHookInstall({ dir, hookSourceRoot, nodeExecPath }) {
  const runtimeDir = join(dir, "muster");
  const template = await readJson(join(hookSourceRoot, "hooks.json"));
  if (!template?.hooks || typeof template.hooks !== "object" || Array.isArray(template.hooks)) return null;
  const hookGroups = clone(template.hooks);
  const command = shellCommand(join(runtimeDir, "hooks", "muster-hook.mjs"), await validatedHookNode(nodeExecPath));
  let hookCount = 0;
  for (const groups of Object.values(hookGroups)) {
    if (!Array.isArray(groups) || !groups.length) return null;
    for (const group of groups) {
      if (!Array.isArray(group?.hooks) || !group.hooks.length) return null;
      for (const hook of group.hooks) {
        if (hook?.type !== "command") return null;
        hook.command = command.command;
        hook.commandWindows = command.commandWindows;
        hookCount++;
      }
    }
  }
  if (!hookCount) return null;
  const hash = createHash("sha256");
  for (const file of HOOK_FILES) hash.update(file).update("\0").update(await readSafe(join(hookSourceRoot, basename(file))));
  return { dir, runtimeDir, files: HOOK_FILES, hookGroups, hookCount, hookHash: hash.digest("hex") };
}

async function inspectUserScopeHooks({ home, packageVersion, expected, cwd }) {
  if (!expected?.hookCount || expected.hookCount < 1) return null;
  const dir = codexHome(home);
  const runtimeDir = join(dir, "muster"), manifestPath = join(runtimeDir, MANIFEST), configPath = join(dir, "hooks.json");
  if (!(await safeExists(manifestPath))) return null;
  let manifestText;
  try { manifestText = await readSafe(manifestPath); } catch { return null; }
  let manifestRaw;
  try { manifestRaw = JSON.parse(manifestText); } catch { return null; }
  if (manifestRaw?.packageVersion !== packageVersion) return null;
  let manifest;
  try { manifest = validateHookManifest(manifestRaw, runtimeDir, manifestPath); }
  catch { return null; }
  if (!same(manifest.files, HOOK_FILES) || !same(manifest.hookGroups, expected.hookGroups)
    || typeof manifestRaw.hookHash !== "string" || manifestRaw.hookHash !== expected.hookHash) return null;
  const runtimeHash = createHash("sha256"), snapshotHash = createHash("sha256").update(manifestText).update("\0");
  try {
    for (const file of HOOK_FILES) {
      const bytes = await readSafe(join(runtimeDir, file));
      runtimeHash.update(file).update("\0").update(bytes);
      snapshotHash.update(file).update("\0").update(bytes);
    }
  } catch { return null; }
  if (runtimeHash.digest("hex") !== manifestRaw.hookHash) return null;
  if (!(await safeExists(configPath))) return null;
  let configText, config;
  try { configText = await readSafe(configPath); config = JSON.parse(configText); }
  catch { return null; }
  if (!config || typeof config !== "object" || Array.isArray(config) || typeof config.hooks !== "object" || !config.hooks || Array.isArray(config.hooks)) return null;
  if (await hasMusterHookCommandAlias(config, await liveManagedHookScripts(home, [dir]), { cwds: [cwd] })) return null;
  if (!exactMusterHookGroups(config, expected.hookGroups)) return null;
  let matchedHookCount = 0;
  for (const [event, groups] of Object.entries(expected.hookGroups)) {
    const current = Array.isArray(config.hooks[event]) ? config.hooks[event] : [];
    for (const group of groups) {
      if (current.filter(candidate => same(candidate, group)).length !== 1) return null;
      matchedHookCount += group.hooks.length;
    }
    if (current.filter(group => groupCommands(group).some(isMusterHookCommand)).length !== groups.length) return null;
  }
  if (matchedHookCount !== expected.hookCount) return null;
  const configTomlPath = join(dir, "config.toml");
  const configTomlText = await safeExists(configTomlPath) ? await readSafe(configTomlPath) : "";
  const gaps = musterHookTrustGaps({ configTomlText, hooksJsonPath: configPath, config, hookGroups: manifest.hookGroups });
  snapshotHash.update("config\0").update(configText).update("\0toml\0").update(configTomlText);
  return { dir, configPath, config, hookGroups: manifest.hookGroups, gaps, knownKeys: codexHookStateKeys(config), snapshot: snapshotHash.digest("hex") };
}

async function inspectEffectiveUserScopeHooks({ home, packageVersion, expected, cwd, activationCwd = cwd, runtimeIdentity, hookInventory }) {
  const before = await inspectUserScopeHooks({ home, packageVersion, expected, cwd });
  if (!before || before.gaps.untrusted.length || before.gaps.stale.length) return null;
  const activationBefore = await hookActivationSnapshot({ home, cwd: activationCwd, inventoryCwd: cwd });
  const inventoryReader = hookInventory || readCodexHookInventory;
  const proof = await verifiedHookInventory({ inventoryReader, inventoryArgs: {
    runtimeIdentity,
    cwds: [cwd],
    env: { ...process.env, CODEX_HOME: codexHome(home) }
  }, cwd, hooksJsonPath: before.configPath, activationSnapshot: activationBefore });
  const inspected = await inspectUserScopeHooks({ home, packageVersion, expected, cwd });
  const activationAfter = await hookActivationSnapshot({ home, cwd: activationCwd, inventoryCwd: cwd });
  if (!inspected || inspected.snapshot !== before.snapshot || inspected.gaps.untrusted.length || inspected.gaps.stale.length
    || inspected.gaps.results.length !== expected.hookCount
    || proof.alias || !proof.stable || !sameHookActivationSnapshot(activationBefore, activationAfter)) return null;
  const effective = effectiveHookTrust(proof.inventory, cwd, inspected.configPath, inspected.gaps.results, { knownKeys: inspected.knownKeys });
  return effective.ok ? { ...inspected, effective, activationSnapshot: activationAfter } : null;
}

async function userScopeHooksHealthy(options) {
  return Boolean(await inspectEffectiveUserScopeHooks(options));
}

async function prepareHooks({ scope, cwd, inventoryCwd = cwd, home, hookSourceRoot, packageVersion, nodeExecPath, canonicalUserHooksActive }) {
  const dir = configDir(scope, cwd, home);
  const runtimeDir = join(dir, "muster"), manifestPath = join(runtimeDir, MANIFEST), configPath = join(dir, "hooks.json");
  const runtimeScript = join(runtimeDir, "hooks", "muster-hook.mjs");
  await ordinaryDirectoryPath(dir);
  await ordinaryDirectoryPath(runtimeDir);
  const manifestExists = await safeExists(manifestPath), configExists = await safeExists(configPath);
  const manifestRaw = manifestExists ? await readJson(manifestPath) : null;
  const previous = manifestExists ? validateHookManifest(manifestRaw, runtimeDir, manifestPath) : null;
  let config = { hooks: {} };
  let configSnapshot = null;
  if (configExists) {
    try { configSnapshot = await readSafe(configPath); config = JSON.parse(configSnapshot); }
    catch { config = null; }
    if (!config || typeof config !== "object" || Array.isArray(config) || (config.hooks !== undefined && (typeof config.hooks !== "object" || Array.isArray(config.hooks)))) {
      throw new Error(`Codex hook configuration conflict: ${configPath} is not a valid hooks.json object. Repair it, then rerun the command.`);
    }
    config.hooks ||= {};
    for (const [event, groups] of Object.entries(config.hooks)) if (!Array.isArray(groups)) {
      throw new Error(`Codex hook configuration conflict: ${configPath} has a non-array ${event} hook group.`);
    }
  }
  if (!previous && Object.values(config.hooks).flat().some(group => groupCommands(group).some(isMusterHookCommand))) {
    throw new Error(`Codex hook conflict: ${configPath} contains an unmanaged Muster hook. Remove it or restore its Muster manifest, then rerun the command.`);
  }
  if (await hasMusterHookCommandAlias(config, await liveManagedHookScripts(home, [dir]), { cwds: [...new Set([cwd, inventoryCwd])] })) {
    throw new Error(`Codex hook conflict: ${configPath} contains an aliased Muster hook command. Remove the alias or restore the exact Muster hook manifest, then rerun the command.`);
  }
  const originalConfig = clone(config);
  const skipped = scope === "project" && canonicalUserHooksActive === true;
  // Captured BEFORE removeOwnedHookGroups mutates `config` below, at exactly
  // the group/hook indices this scope's PRIOR install currently occupies in
  // its own live hooks.json -- the same exact-key technique runCodexUninstall
  // uses for its own departingScopeOwnedHookStateKeys (see ownedHookStateKeys'
  // rationale above). Only consumed by runCodexInstall's writer, and only
  // when a canonical-scope collapse (skipped below) just vacated every owned
  // group this scope held with nothing re-added in its place -- an ordinary
  // reinstall that re-adds equivalent groups never reads this, so
  // config.toml's [hooks.state] trust cache stays untouched on every normal
  // reinstall exactly as before this feature.
  const previousOwnedHookStateKeys = previous ? ownedHookStateKeys(config, previous.hookGroups) : [];
  const previousExpectedOwnedCount = previous ? Object.values(previous.hookGroups || {}).reduce((total, groups) => total
    + (Array.isArray(groups) ? groups.reduce((groupTotal, group) => groupTotal
      + (Array.isArray(group?.hooks) ? group.hooks.length : 0), 0) : 0), 0) : 0;
  const previousLiveHookCount = previous ? codexHookStateKeys(config).length : 0;
  if (skipped && previous && previousLiveHookCount > 0 && previousOwnedHookStateKeys.length !== previousExpectedOwnedCount) {
    throw new Error(`Codex hook conflict: a Muster-owned hook was modified or removed in ${configPath}; not every Muster-owned hook position can be identified. Restore the managed hooks or remove unrelated hooks before retrying.`);
  }
  const pruneWholePreviousHookState = Boolean(skipped && previous && previousLiveHookCount === 0);
  if (previous) config = removeOwnedHookGroups(config, previous.hookGroups, configPath);
  if (Object.values(config.hooks).flat().some(group => groupCommands(group).some(isMusterHookCommand))) {
    throw new Error(`Codex hook conflict: ${configPath} contains a duplicate or unmanaged Muster hook outside manifest ownership. Remove the extra group, then rerun the command.`);
  }
  const templatePath = join(hookSourceRoot, "hooks.json");
  const template = await readJson(templatePath);
  if (!template?.hooks || typeof template.hooks !== "object") throw new Error(`Codex hook template is missing or malformed: ${templatePath}`);
  const command = skipped ? null : shellCommand(runtimeScript, await validatedHookNode(nodeExecPath));
  const hookGroups = skipped ? {} : clone(template.hooks);
  if (!skipped) {
    for (const groups of Object.values(hookGroups)) for (const group of groups) for (const hook of group.hooks || []) {
      hook.command = command.command;
      hook.commandWindows = command.commandWindows;
    }
    for (const [event, groups] of Object.entries(hookGroups)) config.hooks[event] = [...(config.hooks[event] || []), ...groups];
  }
  const hookFiles = skipped ? [] : HOOK_FILES;
  const sourcePaths = skipped ? new Map() : new Map([
    ["hooks/muster-hook.mjs", join(hookSourceRoot, "muster-hook.mjs")],
    ["hooks/action-guard.mjs", join(hookSourceRoot, "action-guard.mjs")]
  ]);
  const sourceFiles = new Map();
  const hookHash = createHash("sha256");
  for (const [file, sourcePath] of sourcePaths) {
    const bytes = await readSafe(sourcePath);
    sourceFiles.set(file, bytes);
    hookHash.update(file).update("\0").update(bytes);
  }
  return {
    dir, runtimeDir, manifestPath, manifestExists, configPath, configExists, config, configSnapshot, originalConfig,
    staleFiles: (previous?.files || []).filter(file => !hookFiles.includes(file)),
    manifest: { format: 1, owner: "muster", files: hookFiles, packageVersion, hookHash: hookHash.digest("hex"), hookConfigCreated: previous?.hookConfigCreated ?? !configExists, hookGroups },
    sourceFiles, hookFiles,
    skipped: skipped ? "user-scope-canonical" : null,
    previousOwnedHookStateKeys,
    pruneWholePreviousHookState
  };
}

async function snapshot(originals, changed, path) {
  if (originals.has(path)) return;
  originals.set(path, await safeExists(path) ? await readSafe(path, "utf8") : null);
  changed.push(path);
}

async function transactionWrite(written, path, content) {
  written.set(path, await atomicWriteSafe(path, content));
}

async function transactionRemove(written, path) {
  await removeSafe(path);
  written.set(path, { exists: false, dev: null, ino: null, bytes: null });
}

async function restoreFilesystem(originals, changed, written) {
  for (const destination of [...changed].reverse()) {
    const expected = written.get(destination);
    let current;
    try { current = await physicalFileSnapshot(destination); }
    catch { continue; }
    if (!expected || !samePhysicalFile(expected, current)) continue;
    if (originals.get(destination) === null) await removeSafe(destination);
    else await atomicWriteSafe(destination, originals.get(destination));
  }
}

function normalizedLocalRoot(value) {
  if (typeof value !== "string" || !value.trim()) return null;
  const input = value.trim().replaceAll("\\", "/");
  const drive = input.match(/^([a-z]):\/(.*)$/i);
  return (drive ? `/mnt/${drive[1].toLowerCase()}/${drive[2]}` : resolve(input)).replace(/\/+$/, "");
}

async function sameLocalRoot(left, right) {
  const actual = normalizedLocalRoot(left), expected = normalizedLocalRoot(right);
  if (!actual || !expected) return false;
  try {
    const canonical = async path => {
      try { return await realpath(path); }
      catch (error) {
        if (!/^\/mnt\/[a-z](?:\/|$)/i.test(path)) throw error;
        return realpath(path.toLowerCase());
      }
    };
    const [actualPath, expectedPath] = await Promise.all([canonical(actual), canonical(expected)]);
    const [actualStat, expectedStat] = await Promise.all([lstat(actualPath), lstat(expectedPath)]);
    return actualStat.isDirectory() && expectedStat.isDirectory()
      && actualStat.dev === expectedStat.dev && actualStat.ino === expectedStat.ino;
  } catch { return false; }
}

async function trustedMusterMarketplace(item, repoRoot) {
  const source = item?.marketplaceSource;
  return source?.sourceType === "local"
    && await sameLocalRoot(item.root, repoRoot)
    && await sameLocalRoot(source.source, repoRoot);
}

async function existingMusterMarketplace(execFile, repoRoot, runtimeIdentity) {
  const result = await runJson(execFile, ["plugin", "marketplace", "list", "--json"], runtimeIdentity);
  const matches = Array.isArray(result?.marketplaces) ? result.marketplaces.filter(item => item.name === "muster") : [];
  const trusted = await Promise.all(matches.map(item => trustedMusterMarketplace(item, repoRoot)));
  if (trusted.some(value => !value)) {
    throw new Error(`Codex marketplace conflict: "muster" is registered from an unexpected source. Run "codex plugin marketplace remove muster", then rerun muster install codex.`);
  }
  return matches[0];
}

// File-local, so the flag is an OPTIONS object rather than a positional
// boolean: `registerPlugin(execFile, root, { dryRun: true })` reads at the call
// site; the old `registerPlugin(execFile, true, root)` did not.
async function registerPlugin(execFile, repoRoot, { dryRun, runtimeIdentity }) {
  if (dryRun) return [`codex plugin marketplace add ${repoRoot}`, `codex plugin add ${CODEX_PLUGIN}`];
  let marketplaceAdded = false, pluginAdded = false;
  try {
    const marketplace = await existingMusterMarketplace(execFile, repoRoot, runtimeIdentity);
    if (!marketplace) {
      await run(execFile, ["plugin", "marketplace", "add", repoRoot], runtimeIdentity);
      marketplaceAdded = true;
    }
    await runJson(execFile, ["plugin", "list", "--available", "--json"], runtimeIdentity);
    await run(execFile, ["plugin", "add", CODEX_PLUGIN], runtimeIdentity);
    pluginAdded = true;
    return [];
  } catch (error) {
    if (pluginAdded) try { await run(execFile, ["plugin", "remove", CODEX_PLUGIN], runtimeIdentity); } catch { /* best-effort transaction rollback */ }
    if (marketplaceAdded) try { await run(execFile, ["plugin", "marketplace", "remove", "muster"], runtimeIdentity); } catch { /* best-effort transaction rollback */ }
    throw error;
  }
}

// Wave 2 teardown: profile materialization no longer reads a committed,
// pre-built generation. `generateCodexProfiles` (src/codex-release.js) is a
// pure, dependency-free reader of the frozen codex/agents.manifest.json plus
// its markdown sources, so `.codex/agents/` (the CONSTRAINT-protected
// project-scope surface the model-tiering wave depends on) always works with
// no build step, independent of the heavier plugin build below.
async function profileSource(root, isPluginRoot) {
  if (isPluginRoot) {
    const dir = join(root, "agents");
    const files = await profileFiles(dir);
    return { files, read: file => readFile(join(dir, file), "utf8") };
  }
  const generated = await generateCodexProfiles(root);
  return { files: [...generated.keys()].sort(), read: async file => generated.get(file) };
}

// Preparation phase for runCodexInstall: everything the transaction below
// needs to know, computed read-only (no snapshot()/atomicWriteSafe()/removeSafe()
// touches the rollback-covered filesystem here). Validation throws, source
// resolution, path derivation, hook preparation, conflict probes, the
// marketplace pre-flight, the (non-transactional) plugin staging build, and the
// planned-op listing all live here so the transactional core stays a pure
// snapshot/write/restore sequence. Ordering is preserved exactly: profile
// conflict probe precedes the marketplace + build pre-flight, which precede the
// transaction. The only side effects are the pre-existing esbuild staging build
// and ordinaryDirectoryPath probes (create:false) -- neither is rollback-owned.
async function prepareCodexInstall({ scope, dryRun, cwd, inventoryCwd, home, repoRoot, execFile, runtimeIdentity, hookInventory, allowInjected, nodeExecPath }) {
  if (!["project", "user"].includes(scope)) throw new Error("codex install scope must be project or user");
  const root = repoRoot || fileURLToPath(new URL("../", import.meta.url));
  const pluginRoot = await exists(join(root, ".codex-plugin", "plugin.json"));
  const packageVersion = JSON.parse(await readSafe(join(root, "package.json"))).version;
  if (typeof packageVersion !== "string" || !packageVersion.trim()) throw new Error("Codex installation source is missing a coherent package version");
  const { files, read: readProfile } = await profileSource(root, pluginRoot);
  if (!files.length) throw new Error("Codex profiles are missing; run npm run build:codex first");
  const profileContents = new Map();
  for (const file of files) profileContents.set(file, await readProfile(file));
  const declarations = new Map(files.map(file => [file.slice(0, -".toml".length), agentDescription(profileContents.get(file), file)]));
  // The richer Codex "plugin" (skills/commands/MCP) is generated fresh at
  // install time into `<distributionRoot>/.agents/plugins/`, a gitignored
  // staging directory alongside muster's own source — never into a
  // git-tracked path. The other install-time-generation target this wave
  // names (the user's CODEX_HOME) is already where scope="user" profile
  // TOMLs land via `agentsDir`/`configDir` above; the plugin tree does not
  // need a second CODEX_HOME copy of itself per scope.
  const distributionRoot = pluginRoot ? resolve(root, "..") : root;
  const dir = agentsDir(scope, cwd, home), manifestPath = join(dir, MANIFEST);
  const declarationConfigPath = join(configDir(scope, cwd, home), "config.toml");
  // Contain every generated profile filename to agentsDir before it is used as
  // a write destination below (conflict probe, planned ops, write loop).
  assertContainedProfiles(files, dir);
  // Thread-limit enforcement targets the single shared CODEX_HOME
  // config.toml (Codex CLI/IDE/Desktop all read the same file -- see
  // docs/research/codex-desktop.md section 5), independent of the profile
  // install scope above: a project-scope install still raises the global
  // floor, since that is the file Codex itself actually reads it from.
  const threadLimitConfigPath = codexThreadLimitConfigPath(codexHome(home));
  const threadLimitManifestPath = codexThreadLimitManifestPath(codexHome(home));
  await ordinaryDirectoryPath(configDir(scope, cwd, home));
  await ordinaryDirectoryPath(dir);
  const declarationOwnership = await declarationOwnershipSnapshot(manifestPath, declarationConfigPath);
  const manifest = ownershipSnapshotManifest(declarationOwnership.manifest);
  const manifestExists = declarationOwnership.manifest.exists;
  const managedFiles = manifestExists ? validateManagedFiles(manifest, dir, manifestPath) : [];
  const declarationConfigExists = declarationOwnership.config.exists;
  const declarationSeparatorAdded = manifestExists && manifest.declarationSeparatorAdded === true;
  reconcileAgentDeclarations(
    ownershipSnapshotText(declarationOwnership.config),
    declarations,
    {
      separatorAdded: declarationSeparatorAdded,
      receipt: manifest?.declarationRegion,
      manifestPath
    }
  );
  const hookSourceRoot = pluginRoot ? join(root, "runtime", "install-hooks") : join(root, "codex", "hooks");
  // Canonical collapse removes the project fallback, so it is authorized only
  // by a pre-mutation persisted AND effective user-hook verdict. A later
  // hooks/list failure may block install success, but can never retroactively
  // justify deleting the fallback that was active when the command began.
  const canonicalUserExpected = scope === "project"
    ? await expectedCodexHookInstall({ dir: codexHome(home), hookSourceRoot, nodeExecPath })
    : null;
  const canonicalUserHooksActive = scope === "project" && await userScopeHooksHealthy({
    home, packageVersion, expected: canonicalUserExpected, cwd: inventoryCwd, activationCwd: cwd, runtimeIdentity, hookInventory
  });
  const hooks = await prepareHooks({ scope, cwd, inventoryCwd, home, hookSourceRoot, packageVersion, nodeExecPath, canonicalUserHooksActive });
  const managed = new Set(managedFiles.map(file => resolve(dir, file)));
  const staleFiles = managedFiles.filter(file => !files.includes(file));
  for (const file of files) {
    const destination = join(dir, file);
    if (await safeExists(destination) && !managed.has(resolve(destination))) throw new Error(`Codex profile conflict: ${destination}. Move it or remove it, then rerun muster install codex.`);
  }
  const present = await codexAvailable({ execFile, runtimeIdentity, allowInjected });
  if (present && !dryRun) {
    await existingMusterMarketplace(execFile, distributionRoot, runtimeIdentity);
    if (pluginRoot) {
      await atomicWriteSafe(join(root, ".mcp.json"), JSON.stringify(codexMcpOverlay(nodeExecPath), null, 2) + "\n");
    } else {
      // buildCodexPlugin is itself idempotent (skips regeneration when
      // outDir already holds a current-version plugin), so this fires an
      // esbuild rebuild only when actually needed — including for the many
      // tests whose actual subject is unrelated registry/hook transaction
      // behavior, not plugin generation.
      const { buildCodexPlugin } = await import("../scripts/build-codex.mjs");
      await buildCodexPlugin({ root, outDir: join(distributionRoot, ".agents", "plugins"), nodeExecPath });
    }
  }
  const planned = [
    ...files.map(file => ({ op: "write", path: join(dir, file) })),
    ...staleFiles.map(file => ({ op: "remove", path: join(dir, file) })),
    // Follows hooks.hookFiles (empty under a canonical-scope collapse), not
    // the constant HOOK_FILES -- a skipped scope writes no hook runtime.
    ...hooks.hookFiles.map(file => ({ op: "write", path: join(hooks.runtimeDir, file) })),
    ...hooks.staleFiles.map(file => ({ op: "remove", path: join(hooks.runtimeDir, file) })),
    { op: "merge", path: hooks.configPath },
    { op: "merge", path: declarationConfigPath },
    { op: "merge", path: threadLimitConfigPath }
  ];
  return { files, profileContents, declarations, distributionRoot, dir, manifestPath, declarationConfigPath, declarationOwnership, threadLimitConfigPath, threadLimitManifestPath, packageVersion, canonicalUserExpected, hooks, staleFiles, present, planned };
}

export async function runCodexInstall({ scope = "project", dryRun = false, cwd = process.cwd(), home = homedir(), repoRoot, execFile, runtimeIdentity, hookInventory, scopeLockOptions, nodeExecPath = process.execPath } = {}) {
  const inventoryCwd = resolve(cwd);
  cwd = await codexProjectRoot(cwd);
  const executor = execFile || execFileDefault;
  let identity = runtimeIdentity;
  if (!identity && !execFile) try { identity = resolveCodexRuntimeIdentity({ nodeExecPath }); } catch { /* Codex absent: local install still proceeds without PATH probing */ }
  const { files, profileContents, declarations, distributionRoot, dir, manifestPath, declarationConfigPath, declarationOwnership, threadLimitConfigPath, threadLimitManifestPath, packageVersion, canonicalUserExpected, hooks, staleFiles, present, planned } =
    await prepareCodexInstall({ scope, dryRun, cwd, inventoryCwd, home, repoRoot, execFile: executor, runtimeIdentity: identity, hookInventory, allowInjected: Boolean(execFile), nodeExecPath });
  let originals, changed, written, activationProofStart;
  let actions = [];
  let canonicalUserTrust = null;
  const prunedScopes = [], prunedHookState = [], prunedProjectTrust = [];
  if (!dryRun) {
    originals = new Map(); changed = []; written = new Map();
    await withScopeRegistryTransaction(home, async registry => {
      const checkedOwnership = await verifyDeclarationOwnershipSnapshot(
        declarationOwnership, manifestPath, declarationConfigPath
      );
      const manifest = ownershipSnapshotManifest(checkedOwnership.manifest);
      const manifestExists = checkedOwnership.manifest.exists;
      const declarationConfigExists = checkedOwnership.config.exists;
      const declarationSeparatorAdded = manifestExists && manifest.declarationSeparatorAdded === true;
      const currentHookConfigSnapshot = await safeExists(hooks.configPath) ? await readSafe(hooks.configPath) : null;
      if (currentHookConfigSnapshot !== hooks.configSnapshot) {
        throw new Error(`Codex hook configuration concurrent state change detected at ${hooks.configPath}; no installation state was modified.`);
      }
      await validateManagedHookAliasGraph({ home, cwd, inventoryCwd, entries: registry.entries, currentDir: dir, currentConfig: hooks.originalConfig });
      await ordinaryDirectoryPath(dir, { create: true });
      try {
        const currentScope = await scopeEntry(scope, cwd, home);
        await snapshot(originals, changed, registry.path);
        // Reconcile on every install: prune scopes whose configDir no
        // longer exists (deleted worktrees) and collapse any case-duplicate
        // scope (e.g. a WSL /mnt/c path registered under two castings) into
        // one canonical-case survivor. currentScope is appended, not
        // pre-filtered against the existing entries: reconcileScopeRegistryEntries'
        // dev/ino keying (order-preserving, first physical occurrence wins)
        // already collapses a plain reinstall's already-registered scope
        // with the freshly appended currentScope for the same physical
        // directory, so a separate sameScopeEntry pre-filter here would be
        // redundant -- proven by the reinstall/dedup assertions in
        // test/codex.test.js, which stay green without it.
        // Every pruned entry is reported below (path + reason) instead of
        // removed silently, since a prune is a best-effort guess (see
        // reconcileScopeRegistryEntries).
        const candidateScopeEntries = [...registry.entries, currentScope];
        const reconciled = await reconcileScopeRegistryEntries(
          candidateScopeEntries,
          { onPrune: pruned => prunedScopes.push(pruned) }
        );
        await transactionWrite(written, registry.path, registryText(reconciled));
        for (const file of files) {
          const destination = join(dir, file);
          await snapshot(originals, changed, destination);
          await transactionWrite(written, destination, profileContents.get(file));
        }
        for (const file of staleFiles) {
          const destination = join(dir, file);
          await snapshot(originals, changed, destination);
          await transactionRemove(written, destination);
        }
        const declarationConfigCreated = manifestExists && manifest.declarationConfigCreated !== undefined
          ? manifest.declarationConfigCreated
          : !declarationConfigExists;
        for (const [file, sourceBytes] of hooks.sourceFiles) {
          const destination = join(hooks.runtimeDir, file);
          await snapshot(originals, changed, destination);
          await transactionWrite(written, destination, sourceBytes);
        }
        for (const file of hooks.staleFiles) {
          const destination = join(hooks.runtimeDir, file);
          await snapshot(originals, changed, destination);
          await transactionRemove(written, destination);
        }
        await snapshot(originals, changed, hooks.configPath);
        await transactionWrite(written, hooks.configPath, JSON.stringify(hooks.config, null, 2) + "\n");
        await snapshot(originals, changed, hooks.manifestPath);
        await transactionWrite(written, hooks.manifestPath, JSON.stringify(hooks.manifest, null, 2) + "\n");
        try {
          const configExistedBefore = await safeExists(threadLimitConfigPath);
          const existingConfigText = configExistedBefore ? await readSafe(threadLimitConfigPath) : "";
          // Reconcile config.toml's [hooks.state] trust cache against the
          // SAME candidate/survivor scope sets the registry reconciliation
          // above just computed, before raising the thread limits on the
          // result -- see reconcileConfigTomlHookState's own rationale: this
          // is the fix for codex-hook-bombardment (a dead or case-duplicated
          // scope's hook definitions stay trusted, and thus still fire,
          // forever without this). No ownedHookStateKeys is threaded through
          // here for an ORDINARY reinstall: the current scope is always in
          // `reconciled` (kept), so it is never a pruning candidate in the
          // first place -- a plain reinstall that re-adds equivalent groups
          // must never re-prompt Codex's own hook trust review.
          //
          // A canonical-scope collapse (hooks.skipped, see prepareHooks'
          // userScopeHooksHealthy) is the one install-time exception: it just
          // vacated every owned group this scope held with nothing re-added
          // in its place, so its now-orphaned trust-cache entries must be
          // pruned too -- exactly like runCodexUninstall's own departing-
          // scope prune, narrowed to the EXACT keys previousOwnedHookStateKeys
          // captured (see that field's rationale in prepareHooks) so a
          // co-located non-muster hooks.state entry at this same path is
          // never swept up. `reconciled` (kept) is unchanged either way --
          // this scope's profiles/registration stay live; only its own
          // vacated hook trust is eligible for narrowed pruning.
          const hookStateEntries = hooks.skipped && hooks.previousOwnedHookStateKeys.length
            ? candidateScopeEntries.map(entry => sameScopeEntry(entry, currentScope)
                ? { ...entry, ownedHookStateKeys: hooks.previousOwnedHookStateKeys }
                : entry)
            : candidateScopeEntries;
          const hookStateKeptEntries = hooks.skipped && hooks.pruneWholePreviousHookState
            ? reconciled.filter(entry => !sameScopeEntry(entry, currentScope))
            : reconciled;
          const hookStateReconcile = reconcileConfigTomlHookState(existingConfigText, hookStateEntries, hookStateKeptEntries, {
            onPrune: pruned => (pruned.type === "hooks.state" ? prunedHookState : prunedProjectTrust).push(pruned)
          });
          if (!hookStateReconcile.parseOk) throw new Error("Codex config.toml cannot be safely reconciled because its TOML string, array, or table boundaries are malformed or unsupported");
          const previousManifest = await safeExists(threadLimitManifestPath)
            ? validateThreadLimitManifest(
              await readJson(threadLimitManifestPath),
              threadLimitManifestPath,
              threadLimitConfigPath,
            )
            : null;
          const legacyManifest = Object.hasOwn(previousManifest?.installed || {}, "max_threads");
          const reconciledThreadText = legacyManifest
            ? restoreCodexThreadLimits(hookStateReconcile.text, previousManifest)
            : hookStateReconcile.text;
          const threadLimits = ensureCodexThreadLimits(reconciledThreadText);
          // A repeat install must not re-derive before/sectionCreated/
          // configCreated from the already-managed file -- that would
          // permanently lose the true pre-Muster baseline the very first
          // install recorded, so an eventual last-scope uninstall could
          // never fully restore it. Mirrors prepareHooks' identical
          // `previous?.hookConfigCreated ?? !configExists` guard above.
          const currentCanonicalValue = threadLimits.before.max_concurrent_threads_per_session;
          // A missing live key is an authoritative user deletion, not an
          // unchanged managed value. Rebase this key's ownership so the
          // default added by this reinstall is removed on uninstall instead
          // of resurrecting the stale pre-deletion user value.
          const before = previousManifest && !legacyManifest && currentCanonicalValue !== null
            ? previousManifest.before
            : threadLimits.before;
          const installed = previousManifest && !legacyManifest && currentCanonicalValue !== null
            ? previousManifest.installed
            : threadLimits.installed;
          const ownershipRebased = previousManifest && !legacyManifest && currentCanonicalValue === null;
          const sectionCreated = previousManifest && !legacyManifest && !ownershipRebased
            ? previousManifest.sectionCreated
            : threadLimits.sectionCreated;
          const configCreated = previousManifest && !ownershipRebased
            ? previousManifest.configCreated
            : !(scope === "user" ? declarationConfigExists : configExistedBefore);
          await snapshot(originals, changed, threadLimitConfigPath);
          await transactionWrite(written, threadLimitConfigPath, threadLimits.text);
          await snapshot(originals, changed, threadLimitManifestPath);
          await transactionWrite(written, threadLimitManifestPath, JSON.stringify({
            format: 1, owner: "muster", configPath: threadLimitConfigPath,
            before, installed,
            sectionCreated, configCreated
          }, null, 2) + "\n");
        } catch (error) {
          throw new Error(`Codex config.toml thread limits could not be enforced at ${threadLimitConfigPath}: ${error.message}. ${CODEX_THREAD_LIMIT_REMEDIATION}`);
        }
        // Declarations are appended only after the shared [agents] thread-limit
        // table is reconciled. This keeps pre-existing root assignments at the
        // TOML root and also makes the first user-scope install byte-identical
        // to every reinstall.
        const currentDeclarationText = await safeExists(declarationConfigPath) ? await readSafe(declarationConfigPath) : "";
        const declarationReconcile = reconcileAgentDeclarations(
          currentDeclarationText,
          declarations,
          {
            separatorAdded: declarationSeparatorAdded,
            receipt: manifest?.declarationRegion,
            manifestPath
          }
        );
        await snapshot(originals, changed, declarationConfigPath);
        await transactionWrite(written, declarationConfigPath, declarationReconcile.text);
        await snapshot(originals, changed, manifestPath);
        await transactionWrite(written, manifestPath, JSON.stringify({
          format: 1, owner: "muster", files, packageVersion,
          declarationConfigCreated,
          declarationSeparatorAdded: declarationReconcile.separatorAdded,
          declarationRegion: declarationReconcile.receipt
        }, null, 2) + "\n");
        await validateManagedHookAliasGraph({ home, cwd, inventoryCwd, entries: reconciled, currentDir: dir, currentConfig: hooks.config });
        if (hooks.skipped) {
          canonicalUserTrust = await inspectEffectiveUserScopeHooks({
            home, packageVersion, expected: canonicalUserExpected, cwd: inventoryCwd, activationCwd: cwd,
            runtimeIdentity: identity, hookInventory
          });
          if (!canonicalUserTrust) {
            throw new Error("The canonical user hook scope changed or became inactive during install; cannot remove the project hook fallback");
          }
          await scopeLockOptions?.afterCanonicalVerification?.();
        }
        activationProofStart = await hookActivationSnapshot({ home, cwd, inventoryCwd });
        if (hooks.skipped && !sameHookActivationSnapshot(canonicalUserTrust.activationSnapshot, activationProofStart)) {
          throw new Error("The canonical user hook scope changed after effective verification; cannot remove the project hook fallback");
        }
        if (!activationSnapshotMatchesWrites(activationProofStart, written)) {
          throw new Error("Codex hook activation state diverged from the transaction's exact writes before verification");
        }
        actions = present ? await registerPlugin(executor, distributionRoot, { dryRun: false, runtimeIdentity: identity }) : [];
      } catch (error) {
        await restoreFilesystem(originals, changed, written);
        throw error;
      }
    }, scopeLockOptions);
  } else {
    actions = present ? await registerPlugin(executor, distributionRoot, { dryRun: true, runtimeIdentity: identity }) : [];
  }
  const trustRemediation = "Open Codex, run /hooks, and trust the exact current Muster hook definitions, then rerun muster install codex to verify them";
  let hookTrust;
  if (dryRun) {
    hookTrust = { ok: false, blocking: false, verified: false, results: [], stale: [], effective: { verified: false, ok: false, results: [], error: "dry-run does not verify effective hook activation" }, remediation: null };
  } else {
    if (hooks.skipped) canonicalUserTrust = await inspectEffectiveUserScopeHooks({
      home, packageVersion, expected: canonicalUserExpected, cwd: inventoryCwd, activationCwd: cwd,
      runtimeIdentity: identity, hookInventory
    });
    const trustTarget = hooks.skipped ? canonicalUserTrust : {
      configPath: hooks.configPath,
      config: hooks.config,
      hookGroups: hooks.manifest.hookGroups,
      knownKeys: codexHookStateKeys(hooks.config),
      gaps: musterHookTrustGaps({
        configTomlText: await readSafe(threadLimitConfigPath),
        hooksJsonPath: hooks.configPath,
        config: hooks.config,
        hookGroups: hooks.manifest.hookGroups
      })
    };
    const gaps = trustTarget?.gaps ?? { results: [], untrusted: ["canonical-scope-invalid"], stale: [] };
    const inventoryReader = hookInventory || readCodexHookInventory;
    const activationBefore = activationProofStart;
    const inventoryArgs = {
      runtimeIdentity: identity,
      cwds: [inventoryCwd],
      env: { ...process.env, CODEX_HOME: codexHome(home) }
    };
    const proof = hooks.skipped ? null : await verifiedHookInventory({
      inventoryReader, inventoryArgs, cwd: inventoryCwd,
      hooksJsonPath: trustTarget.configPath, activationSnapshot: activationBefore
    });
    const activationAfter = await hookActivationSnapshot({ home, cwd, inventoryCwd });
    const activationStable = sameHookActivationSnapshot(activationBefore, activationAfter);
    const effective = hooks.skipped
      ? trustTarget && activationStable
        ? canonicalUserTrust.effective
        : { verified: true, ok: false, error: "Codex canonical user hooks changed or became inactive after project fallback removal", results: [] }
      : proof.alias
        ? { verified: true, ok: false, error: "Codex hooks/list reported another source invoking the managed Muster runtime", results: [] }
        : !activationStable || !proof.stable
        ? { verified: true, ok: false, error: "Codex hook activation state changed during hooks/list verification", results: [] }
        : effectiveHookTrust(proof.inventory, inventoryCwd, trustTarget.configPath, gaps.results, { knownKeys: trustTarget.knownKeys });
    const persistedOk = gaps.untrusted.length === 0 && gaps.stale.length === 0;
    hookTrust = {
      ok: persistedOk && effective.ok,
      blocking: !persistedOk || !effective.ok,
      verified: true,
      results: gaps.results,
      stale: gaps.stale,
      effective,
      remediation: !persistedOk || !effective.ok ? trustRemediation : null
    };
  }
  return { ok: dryRun ? true : hookTrust.ok, target: "codex", scope, dryRun, profiles: files.length, hooks: Object.keys(hooks.manifest.hookGroups).length, files: planned,
    hooksSkipped: hooks.skipped,
    hookTrust,
    prunedScopes, prunedHookState, prunedProjectTrust,
    plugin: present ? { registered: !dryRun, actions } : { registered: false, skipped: "codex-not-found" },
    nextSteps: [
      ...(present ? [] : ["npm install -g @openai/codex", `muster install codex --scope ${scope}`]),
      ...(hookTrust.remediation ? [hookTrust.remediation] : [])
    ] };
}

async function remainingManagedScopes(registry, currentScope) {
  const liveScopes = [];
  for (const entry of registry.entries) {
    if (sameScopeEntry(entry, currentScope)) continue;
    if (!(await ordinaryDirectoryPath(entry.configDir))) continue;
    const entryAgents = join(entry.configDir, "agents"), entryManifest = join(entryAgents, MANIFEST);
    if (!(await ordinaryDirectoryPath(entryAgents))) continue;
    if (!(await safeExists(entryManifest))) continue;
    validateManagedFiles(await readJson(entryManifest), entryAgents, entryManifest);
    liveScopes.push(entry);
  }
  return liveScopes;
}

// Preparation phase for runCodexUninstall: resolve profile/hook/thread-limit
// state and the removal decisions read-only, before the transaction. No
// snapshot()/atomicWriteSafe()/removeSafe() runs here -- every rollback-covered
// mutation stays inside uninstallScope's try/restore boundary. Order-sensitive
// steps are preserved exactly: departingScopeOwnedHookStateKeys is captured from
// the raw hooks.json BEFORE removeOwnedHookGroups strips muster's own groups.
async function prepareCodexUninstall({ scope, cwd, activationCwds = [], home, execFile, runtimeIdentity, allowInjected }) {
  if (!["project", "user"].includes(scope)) throw new Error("codex uninstall scope must be project or user");
  const dir = agentsDir(scope, cwd, home), manifestPath = join(dir, MANIFEST);
  const declarationConfigPath = join(configDir(scope, cwd, home), "config.toml");
  await ordinaryDirectoryPath(configDir(scope, cwd, home));
  await ordinaryDirectoryPath(dir);
  const declarationOwnership = await declarationOwnershipSnapshot(manifestPath, declarationConfigPath);
  const manifest = ownershipSnapshotManifest(declarationOwnership.manifest);
  const manifestExists = declarationOwnership.manifest.exists;
  const managedFiles = manifestExists ? validateManagedFiles(manifest, dir, manifestPath) : [];
  const files = managedFiles.map(file => join(dir, file));
  const declarationConfigExists = declarationOwnership.config.exists;
  const declarationSeparatorAdded = manifestExists && manifest.declarationSeparatorAdded === true;
  const declarationConfig = manifestExists
    ? removeAgentDeclarations(
      ownershipSnapshotText(declarationOwnership.config),
      {
        separatorAdded: declarationSeparatorAdded,
        receipt: manifest.declarationRegion,
        manifestPath
      }
    )
    : null;
  const declarationConfigCreated = manifestExists && manifest.declarationConfigCreated === true;
  const hookDir = configDir(scope, cwd, home), hookRuntimeDir = join(hookDir, "muster"), hookManifestPath = join(hookRuntimeDir, MANIFEST), hookConfigPath = join(hookDir, "hooks.json");
  await ordinaryDirectoryPath(hookRuntimeDir);
  const hookManifestExists = await safeExists(hookManifestPath), hookConfigExists = await safeExists(hookConfigPath);
  const hookManifest = hookManifestExists ? validateHookManifest(await readJson(hookManifestPath), hookRuntimeDir, hookManifestPath) : null;
  const hookFiles = hookManifest ? hookManifest.files.map(file => join(hookRuntimeDir, file)) : [];
  let hookConfig = null, removeHookConfig = false, departingScopeOwnedHookStateKeys = null;
  if (hookManifest) {
    const rawHookConfig = hookConfigExists ? await readJson(hookConfigPath) : { hooks: {} };
    if (!rawHookConfig || typeof rawHookConfig !== "object" || Array.isArray(rawHookConfig)) throw new Error(`Codex hook configuration conflict: ${hookConfigPath} is not valid JSON.`);
    // Fix iteration 1 (over-revocation blocker b): compute the departing
    // scope's EXACT owned [hooks.state] keys from its hooks.json BEFORE
    // muster's own groups are stripped out below, so a co-located non-muster
    // hook definition sharing this same hooksJsonPath (a different group or
    // hook index) is never conflated with muster's own and survives.
    const derivedOwnedKeys = hookConfigExists ? ownedHookStateKeys(rawHookConfig, hookManifest.hookGroups) : [];
    const expectedOwnedCount = Object.values(hookManifest.hookGroups || {}).reduce((total, groups) => total
      + (Array.isArray(groups) ? groups.reduce((groupTotal, group) => groupTotal
        + (Array.isArray(group?.hooks) ? group.hooks.length : 0), 0) : 0), 0);
    const liveHookCount = hookConfigExists ? codexHookStateKeys(rawHookConfig).length : 0;
    if (hookConfigExists && liveHookCount > 0 && derivedOwnedKeys.length !== expectedOwnedCount) {
      throw new Error(`Codex hook conflict: a Muster-owned hook was modified or removed in ${hookConfigPath}; not every Muster-owned hook position can be identified. Restore the managed hooks or remove unrelated hooks before retrying.`);
    }
    departingScopeOwnedHookStateKeys = hookConfigExists && liveHookCount > 0 ? derivedOwnedKeys : null;
    hookConfig = removeOwnedHookGroups(rawHookConfig, hookManifest.hookGroups, hookConfigPath);
    if (Object.values(hookConfig.hooks || {}).flat().some(group => groupCommands(group).some(isMusterHookCommand))) {
      throw new Error(`Codex hook conflict: ${hookConfigPath} contains a duplicate or unmanaged Muster hook outside manifest ownership. Remove the extra group, then rerun the command.`);
    }
    if (await hasMusterHookCommandAlias(hookConfig, hookFiles, { cwds: [...new Set([cwd, ...activationCwds])] })) {
      throw new Error(`Codex hook conflict: ${hookConfigPath} contains an aliased Muster hook outside manifest ownership. Remove the alias, then rerun the command.`);
    }
    const otherKeys = Object.keys(hookConfig).filter(key => key !== "hooks");
    removeHookConfig = hookManifest.hookConfigCreated && otherKeys.length === 0 && Object.keys(hookConfig.hooks || {}).length === 0;
  }
  const hookOwnershipPaths = [...new Set([hookManifestPath, hookConfigPath, ...hookFiles])];
  const hookOwnershipSnapshot = await physicalFilesSnapshot(hookOwnershipPaths);
  const present = await codexAvailable({ execFile, runtimeIdentity, allowInjected });
  const ownsScope = manifestExists || hookManifestExists;
  const currentScope = await scopeEntry(scope, cwd, home);
  // Thread limits target the single shared CODEX_HOME config.toml (see
  // runCodexInstall), so restoring them on uninstall is gated on this being
  // the LAST Muster-managed scope -- the same "shared, not per-scope"
  // signal `removePlugin` already uses -- rather than on this scope's own
  // profile/hook ownership: uninstalling one of two managed scopes must not
  // silently lower a floor the other scope still relies on.
  const threadLimitConfigPath = codexThreadLimitConfigPath(codexHome(home));
  const threadLimitManifestPath = codexThreadLimitManifestPath(codexHome(home));
  const threadLimitManifestExists = await safeExists(threadLimitManifestPath);
  const threadLimitManifest = threadLimitManifestExists
    ? validateThreadLimitManifest(
      await readJson(threadLimitManifestPath),
      threadLimitManifestPath,
      threadLimitConfigPath,
    )
    : null;
  return { dir, manifestPath, files, declarationConfigPath, declarationOwnership, declarationConfig, declarationConfigCreated, hookRuntimeDir, hookManifestPath, hookConfigPath, hookManifestExists, hookManifest, hookConfig, removeHookConfig, departingScopeOwnedHookStateKeys, hookFiles, hookOwnershipPaths, hookOwnershipSnapshot, present, ownsScope, currentScope, threadLimitConfigPath, threadLimitManifestPath, threadLimitManifest };
}

export async function runCodexUninstall({ scope = "project", dryRun = false, cwd = process.cwd(), home = homedir(), execFile, runtimeIdentity } = {}) {
  const invocationCwd = resolve(cwd);
  const canonicalRoot = await codexProjectRoot(cwd);
  if (scope === "project") {
    const candidateRoots = [...new Set((await codexActivationConfigDirs(canonicalRoot, invocationCwd)).map(dirname))];
    const ownedRoots = [];
    for (const root of candidateRoots) if (await safeExists(join(root, ".codex", "agents", MANIFEST))
      || await safeExists(join(root, ".codex", "muster", MANIFEST))) ownedRoots.push(root);
    if (ownedRoots.length > 1) throw new Error(`Multiple Muster-owned Codex project scopes match this checkout: ${ownedRoots.join(", ")}. Uninstall each legacy scope from its own root.`);
    cwd = ownedRoots[0] || canonicalRoot;
  } else {
    cwd = canonicalRoot;
  }
  const executor = execFile || execFileDefault;
  let identity = runtimeIdentity;
  if (!identity && !execFile) try { identity = resolveCodexRuntimeIdentity(); } catch { /* Codex absent: local cleanup still proceeds without PATH probing */ }
  const { dir, manifestPath, files, declarationConfigPath, declarationOwnership, declarationConfig: preflightDeclarationConfig, declarationConfigCreated: preflightDeclarationConfigCreated, hookRuntimeDir, hookManifestPath, hookConfigPath, hookManifestExists, hookManifest, hookConfig, removeHookConfig, departingScopeOwnedHookStateKeys, hookFiles, hookOwnershipPaths, hookOwnershipSnapshot, present, ownsScope: preflightOwnsScope, currentScope, threadLimitConfigPath, threadLimitManifestPath, threadLimitManifest } =
    await prepareCodexUninstall({ scope, cwd, activationCwds: [invocationCwd], home, execFile: executor, runtimeIdentity: identity, allowInjected: Boolean(execFile) });
  let liveScopes = [], ownershipCertain = false, removePlugin = false, restoreThreadLimits = false, removeThreadLimitConfig = false;
  let manifestExists = declarationOwnership.manifest.exists;
  let ownsScope = preflightOwnsScope;
  let declarationConfigExists = declarationOwnership.config.exists;
  let declarationConfig = preflightDeclarationConfig;
  let declarationConfigCreated = preflightDeclarationConfigCreated;
  let removeDeclarationConfig = declarationConfigExists && declarationConfigCreated && declarationConfig?.trim() === "";
  const prunedHookState = [], prunedProjectTrust = [];
  const uninstallScope = async registry => {
    if (!dryRun) {
      const checkedHookOwnership = await physicalFilesSnapshot(hookOwnershipPaths);
      if (!samePhysicalFilesSnapshot(hookOwnershipSnapshot, checkedHookOwnership)) {
        throw new Error("Codex hook ownership concurrent state change detected; no installation state was modified.");
      }
      const registeredActivationCwds = registry.entries
        .filter(entry => entry.scope === "project")
        .map(entry => dirname(entry.configDir));
      if (hookManifest && await hasMusterHookCommandAlias(hookConfig, hookFiles, {
        cwds: [...new Set([cwd, invocationCwd, ...registeredActivationCwds])]
      })) {
        throw new Error(`Codex hook conflict: ${hookConfigPath} contains an aliased Muster hook outside manifest ownership. Remove the alias, then rerun the command.`);
      }
      const checkedOwnership = await verifyDeclarationOwnershipSnapshot(
        declarationOwnership, manifestPath, declarationConfigPath
      );
      const checkedManifest = ownershipSnapshotManifest(checkedOwnership.manifest);
      manifestExists = checkedOwnership.manifest.exists;
      ownsScope = manifestExists || hookManifestExists;
      declarationConfigExists = checkedOwnership.config.exists;
      declarationConfigCreated = manifestExists && checkedManifest.declarationConfigCreated === true;
      declarationConfig = manifestExists
        ? removeAgentDeclarations(ownershipSnapshotText(checkedOwnership.config), {
          separatorAdded: checkedManifest.declarationSeparatorAdded === true,
          receipt: checkedManifest.declarationRegion,
          manifestPath
        })
        : null;
      removeDeclarationConfig = declarationConfigExists && declarationConfigCreated && declarationConfig?.trim() === "";
    }
    liveScopes = await remainingManagedScopes(registry, currentScope);
    ownershipCertain = registry.present;
    removePlugin = present && ownsScope && ownershipCertain && liveScopes.length === 0;
    restoreThreadLimits = Boolean(threadLimitManifest) && ownershipCertain && liveScopes.length === 0;
    if (dryRun) return;
    const originals = new Map(), changed = [], written = new Map();
    try {
      await snapshot(originals, changed, registry.path);
      await transactionWrite(written, registry.path, registryText(liveScopes));
      for (const file of files) { await snapshot(originals, changed, file); await transactionRemove(written, file); }
      if (manifestExists) { await snapshot(originals, changed, manifestPath); await transactionRemove(written, manifestPath); }
      if (manifestExists && declarationConfigExists) {
        await snapshot(originals, changed, declarationConfigPath);
        if (removeDeclarationConfig) await transactionRemove(written, declarationConfigPath);
        else await transactionWrite(written, declarationConfigPath, declarationConfig);
      }
      for (const file of hookFiles) { await snapshot(originals, changed, file); await transactionRemove(written, file); }
      if (hookManifestExists) { await snapshot(originals, changed, hookManifestPath); await transactionRemove(written, hookManifestPath); }
      if (hookManifest) {
        await snapshot(originals, changed, hookConfigPath);
        if (removeHookConfig) await transactionRemove(written, hookConfigPath);
        else await transactionWrite(written, hookConfigPath, JSON.stringify(hookConfig, null, 2) + "\n");
      }
      // Fix for codex-hook-bombardment: the scope being uninstalled just had
      // its OWN hooks.json rewritten/removed above, so its config.toml
      // [hooks.state] entries are now orphaned -- registeredEntries (the
      // full pre-removal registry) minus liveScopes (registry.entries with
      // currentScope already excluded) makes reconcileConfigTomlHookState
      // prune exactly that scope's entries regardless of whether its
      // configDir directory still physically exists, plus any other
      // already-stale/duplicate entries as a reconciliation bonus. This
      // scope's own registry entry additionally carries
      // departingScopeOwnedHookStateKeys (fix iteration 1, blocker b) so
      // that -- unlike the OTHER stale/duplicate entries reconciled away as
      // a byproduct, whose whole hooksJsonPath prefix is pruned exactly as
      // before -- only the EXACT keys muster itself registered here are
      // removed; any co-located non-muster hooks.state entry sharing this
      // hooksJsonPath survives. This runs on every uninstall, not only the
      // last-scope thread-limit-restoring one. [projects] is never touched
      // (see reconcileConfigTomlHookState's header comment).
      const configTomlExistedBefore = await safeExists(threadLimitConfigPath);
      if (configTomlExistedBefore || restoreThreadLimits) {
        try {
          await snapshot(originals, changed, threadLimitConfigPath);
          let currentConfigText = configTomlExistedBefore ? await readSafe(threadLimitConfigPath) : "";
          const registeredEntries = registry.entries.map(entry => sameScopeEntry(entry, currentScope) && departingScopeOwnedHookStateKeys
            ? { ...entry, ownedHookStateKeys: departingScopeOwnedHookStateKeys }
            : entry);
          const hookStateReconcile = reconcileConfigTomlHookState(currentConfigText, registeredEntries, liveScopes, {
            onPrune: pruned => (pruned.type === "hooks.state" ? prunedHookState : prunedProjectTrust).push(pruned)
          });
          if (!hookStateReconcile.parseOk) throw new Error("Codex config.toml cannot be safely reconciled because its TOML string, array, or table boundaries are malformed or unsupported");
          currentConfigText = hookStateReconcile.text;
          if (restoreThreadLimits) currentConfigText = restoreCodexThreadLimits(currentConfigText, threadLimitManifest);
          removeThreadLimitConfig = restoreThreadLimits && threadLimitManifest.configCreated && currentConfigText.trim() === "";
          if (removeThreadLimitConfig) await transactionRemove(written, threadLimitConfigPath);
          else await transactionWrite(written, threadLimitConfigPath, currentConfigText);
          if (restoreThreadLimits) {
            await snapshot(originals, changed, threadLimitManifestPath);
            await transactionRemove(written, threadLimitManifestPath);
          }
        } catch (error) {
          throw new Error(`Codex config.toml hook-state/thread-limit reconciliation could not complete at ${threadLimitConfigPath}: ${error.message}. ${CODEX_THREAD_LIMIT_REMEDIATION}`);
        }
      }
      if (removePlugin) await run(executor, ["plugin", "remove", CODEX_PLUGIN], identity);
    } catch (error) {
      await restoreFilesystem(originals, changed, written);
      throw error;
    }
    for (const empty of [join(hookRuntimeDir, "hooks"), hookRuntimeDir]) try {
      await ordinaryDirectoryPath(empty);
      await rmdir(empty);
    } catch { /* preserve non-empty user content */ }
  };
  if (dryRun) await uninstallScope(await readScopeRegistry(home));
  else await withScopeRegistryTransaction(home, uninstallScope);
  const planned = [
    ...files.map(path => ({ op: "remove", path })),
    ...(manifestExists && declarationConfigExists ? [{ op: removeDeclarationConfig ? "remove" : "merge", path: declarationConfigPath }] : []),
    ...hookFiles.map(path => ({ op: "remove", path })),
    ...(hookManifest ? [{ op: removeHookConfig ? "remove" : "merge", path: hookConfigPath }] : []),
    ...(restoreThreadLimits ? [{ op: removeThreadLimitConfig ? "remove" : "merge", path: threadLimitConfigPath }] : [])
  ];
  return { ok: true, target: "codex", scope, dryRun, files: planned,
    prunedHookState, prunedProjectTrust,
    plugin: present ? { removed: !dryRun && removePlugin, retained: liveScopes.length > 0, ownershipCertain } : { removed: false, skipped: "codex-not-found" },
    nextSteps: present ? [] : ["npm install -g @openai/codex", `muster uninstall codex --scope ${scope}`] };
}
