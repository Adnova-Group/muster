// codex-install-shared.js -- leaf module for codex-install.js's split (split-codex-install).
// Generic fs/snapshot/path/scope-registry primitives with no install/uninstall/
// hooks/marketplace/config-transaction domain meaning. Depends only on node
// builtins and fs-safe.js/codex-runtime-identity.js -- never imports from any
// sibling codex-install-*.js file, so every other concern module (and the
// facade) can depend on this one without risking a cycle.
import { constants as fsConstants } from "node:fs";
import { lstat, open, readFile, readdir, realpath, stat, unlink } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, parse, relative, resolve, sep } from "node:path";
import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";
import { atomicWrite, ordinaryDirectoryPath as walkOrdinaryDirectoryPath, readNoFollowRegular } from "./fs-safe.js";
import { runCodexCommand } from "./codex-runtime-identity.js";

export const execFileDefault = promisify(execFileCb);

export const MANIFEST = ".muster-managed.json";

export const codexHome = home => process.env.CODEX_HOME || join(home, ".codex");

export const configDir = (scope, cwd, home) => scope === "user" ? codexHome(home) : join(cwd, ".codex");

const scopeRegistryPath = home => join(codexHome(home), "muster", "install-scopes.json");

export const scopeRegistryLockPath = home => `${scopeRegistryPath(home)}.lock`;

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

export const ordinaryDirectoryPath = (path, options = {}) => walkOrdinaryDirectoryPath(path, {
  ...options,
  unsafeError: current => new Error(`Codex configuration ancestry must be an ordinary directory: ${current}`),
});


export async function regularFileState(path) {
  await ordinaryDirectoryPath(dirname(path));
  let stat;
  try { stat = await lstat(path); }
  catch (error) { if (error.code === "ENOENT") return null; throw error; }
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(`Codex configuration target must be a regular file: ${path}`);
  return stat;
}


export async function safeExists(path) { return Boolean(await regularFileState(path)); }

export async function readSafe(path, encoding = "utf8") {
  if (!(await regularFileState(path))) throw new Error(`Codex configuration file is missing: ${path}`);
  return readFile(path, encoding);
}

export async function physicalFileSnapshot(path) {
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

export function samePhysicalFile(left, right) {
  if (left.unsafe || right.unsafe) return left.unsafe === true && right.unsafe === true
    && left.code === right.code && left.message === right.message;
  return left.exists === right.exists && left.dev === right.dev && left.ino === right.ino
    && (!left.exists || left.bytes.equals(right.bytes));
}

export const readJson = async path => { try { return JSON.parse(await readSafe(path, "utf8")); } catch (error) {
  if (/symlink|ordinary|regular/i.test(error.message)) throw error;
  return null;
} };


export function validateScopeRegistry(path, registry) {
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


export async function readScopeRegistry(home) {
  const path = scopeRegistryPath(home), present = await safeExists(path);
  if (!present) return { path, present: false, entries: [] };
  const registry = await readJson(path);
  return { path, present: true, entries: validateScopeRegistry(path, registry) };
}


export async function scopeEntry(scope, cwd, home) {
  const dir = configDir(scope, cwd, home);
  try { return { scope, configDir: await realpath(dir) }; }
  catch (error) { if (error.code === "ENOENT") return { scope, configDir: resolve(dir) }; throw error; }
}


export const sameScopeEntry = (left, right) => left.scope === right.scope && left.configDir === right.configDir;

export const registryText = entries => JSON.stringify({ format: 1, owner: "muster", entries }, null, 2) + "\n";

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

export async function atomicWriteSafe(path, content) {
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


export async function removeSafe(path) {
  const stat = await regularFileState(path);
  if (stat) await unlink(path);
}

export const run = (execFile, args, runtimeIdentity, commandOptions = {}) => runtimeIdentity
  ? runCodexCommand(execFile, runtimeIdentity, args, { timeout: 30_000, maxBuffer: 4 * 1024 * 1024, ...commandOptions })
  : execFile("muster:injected-codex-runner", args, { timeout: 30_000, maxBuffer: 4 * 1024 * 1024, ...commandOptions });

export async function runJson(execFile, args, runtimeIdentity, commandOptions) { return JSON.parse((await run(execFile, args, runtimeIdentity, commandOptions)).stdout); }

export async function snapshot(originals, changed, path) {
  if (originals.has(path)) return;
  const exact = await exactFileSnapshot(path);
  originals.set(path, exact.exists ? exact.bytes : null);
  changed.push(path);
}


export async function restoreFilesystem(originals, changed, { skip = new Set(), written = null } = {}) {
  const errors = [];
  for (const destination of [...changed].reverse()) {
    if (skip.has(destination)) continue;
    try {
      if (written) {
        const expected = written.get(destination);
        let current;
        try { current = await physicalFileSnapshot(destination); }
        catch { continue; }
        if (!expected || !samePhysicalFile(expected, current)) continue;
      }
      if (originals.get(destination) === null) await removeSafe(destination);
      else await atomicWriteSafe(destination, originals.get(destination));
    } catch (error) { errors.push(error); }
  }
  if (errors.length) throw new AggregateError(errors, `${errors.length} filesystem rollback operation(s) failed`);
}


export async function exactFileSnapshot(path) {
  const expectedInfo = await regularFileState(path);
  if (!expectedInfo) return { exists: false, bytes: null, dev: null, ino: null };
  const { bytes, info } = await readNoFollowRegular(path, {
    maxBytes: expectedInfo.size,
    label: path,
    expectedInfo
  });
  return { exists: true, bytes, dev: info.dev, ino: info.ino };
}


export function sameExactFileSnapshot(left, right) {
  return left.exists === right.exists
    && (!left.exists || (left.dev === right.dev && left.ino === right.ino && left.bytes.equals(right.bytes)));
}
