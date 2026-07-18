import { constants as fsConstants } from "node:fs";
import { link, lstat, mkdir, open, readFile, readdir, realpath, rename, rmdir, unlink } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { exists, readdirSafe } from "./fs-util.js";
import { basename, dirname, isAbsolute, join, parse, relative, resolve, sep } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";
import { codexAvailable } from "./codex-inventory.js";
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

const codexHome = home => process.env.CODEX_HOME || join(home, ".codex");
const agentsDir = (scope, cwd, home) => scope === "user" ? join(codexHome(home), "agents") : join(cwd, ".codex", "agents");
const configDir = (scope, cwd, home) => scope === "user" ? codexHome(home) : join(cwd, ".codex");
const scopeRegistryPath = home => join(codexHome(home), "muster", "install-scopes.json");
const scopeRegistryLockPath = home => `${scopeRegistryPath(home)}.lock`;
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
const readJson = async path => { try { return JSON.parse(await readSafe(path, "utf8")); } catch (error) {
  if (/symlink|ordinary|regular/i.test(error.message)) throw error;
  return null;
} };

async function readScopeRegistry(home) {
  const path = scopeRegistryPath(home), present = await safeExists(path);
  if (!present) return { path, present: false, entries: [] };
  const registry = await readJson(path);
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
  return { path, present: true, entries };
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
    const key = `${entry.scope}:${stat.dev}:${stat.ino}`;
    if (survivors.has(key)) continue;
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
// Matches EITHER a `[table.header]` OR a `[[array.of.tables]]` header line --
// both end whatever section preceded them. Checked strictly as alternatives
// (not a lenient `\[{1,2}...\]{1,2}`) so a line can never half-match with
// mismatched bracket counts.
const ANY_TOML_HEADER = /^\s*(?:\[\[[^\]]*\]\]|\[[^\]]*\])\s*(?:#.*)?$/;
const HOOK_STATE_KEY = /^(.*):([a-z][a-z0-9_]*):(\d+):(\d+)$/;

function parseConfigTomlTrustSections(text) {
  const newline = text.includes("\r\n") ? "\r\n" : "\n";
  const finalNewline = text === "" || text.endsWith("\n");
  const lines = text ? text.split(/\r?\n/) : [];
  if (finalNewline && lines.length) lines.pop();
  const sections = [];
  let current = null;
  const closeCurrent = end => { if (current) { current.end = end; sections.push(current); current = null; } };
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    const hookMatch = line.match(HOOK_STATE_HEADER);
    if (hookMatch || ANY_TOML_HEADER.test(line)) closeCurrent(index);
    if (hookMatch) current = { table: "hooks.state", key: decodeTomlQuotedKey(hookMatch[1]), headerLine: index };
  }
  closeCurrent(lines.length);
  return { lines, newline, finalNewline, sections };
}

const renderConfigTomlTrustSections = state => state.lines.join(state.newline) + (state.finalNewline ? state.newline : "");

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
// its splice-as-consumed order so two owned groups for the same event never
// collide on one position) rather than by hooksJsonPath alone means a
// co-located NON-muster hook definition -- sharing the same hooks.json but a
// different group/hook index -- is never included here, and so never gets
// swept up by a path-level prune.
function ownedHookStateKeys(config, hookGroups) {
  const keys = [];
  for (const [event, groups] of Object.entries(hookGroups || {})) {
    if (!Array.isArray(groups)) continue;
    const current = [...(Array.isArray(config?.hooks?.[event]) ? config.hooks[event] : [])];
    const snakeEvent = hookStateEventName(event);
    for (const group of groups) {
      const index = current.findIndex(candidate => same(candidate, group));
      if (index < 0) continue;
      const hookCount = Array.isArray(group.hooks) ? group.hooks.length : 0;
      for (let hookIndex = 0; hookIndex < hookCount; hookIndex++) keys.push(`${snakeEvent}:${index}:${hookIndex}`);
      current.splice(index, 1);
    }
  }
  return keys;
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
  state.lines = state.lines.filter((_, index) => !remove[index]);
  // prunedProjects is always empty: [projects] is never touched (see above).
  // Kept in the return shape for API stability with existing callers.
  return { text: renderConfigTomlTrustSections(state), prunedHookState, prunedProjects: [] };
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
  afterQuarantine = async () => {},
  afterValidation = async () => {},
  afterRetirement = async () => {},
  modeCapability = defaultScopeRetirementModeCapability
} = {}) {
  const path = scopeRegistryLockPath(home), token = randomUUID();
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      await writeExclusiveSafe(path, await scopeLockText(token));
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

async function atomicWriteSafe(path, content) {
  const parent = dirname(path);
  await ordinaryDirectoryPath(parent, { create: true });
  await regularFileState(path);
  const temporary = join(parent, `.${basename(path)}.muster-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.tmp`);
  let handle;
  try {
    handle = await open(temporary, "wx", 0o600);
    await handle.writeFile(content, "utf8");
    await handle.sync();
    await handle.close();
    handle = null;
    await regularFileState(temporary);
    await ordinaryDirectoryPath(parent);
    await regularFileState(path);
    await rename(temporary, path);
  } finally {
    if (handle) await handle.close().catch(() => {});
    try { await unlink(temporary); } catch (error) { if (error.code !== "ENOENT") throw error; }
  }
}

async function removeSafe(path) {
  const stat = await regularFileState(path);
  if (stat) await unlink(path);
}
const profileFiles = async root => (await readdirSafe(root)).filter(name => name.endsWith(".toml")).sort();
const run = (execFile, args) => execFile("codex", args, { timeout: 30_000, maxBuffer: 4 * 1024 * 1024 });
async function runJson(execFile, args) { return JSON.parse((await run(execFile, args)).stdout); }

function validateManagedFiles(manifest, dir, manifestPath) {
  if (manifest?.owner !== "muster" || manifest.format !== 1 || !Array.isArray(manifest.files)) {
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

function validateThreadLimitManifest(manifest, manifestPath) {
  const validValues = value => value && typeof value === "object" && !Array.isArray(value)
    && Object.keys(REQUIRED_CODEX_THREAD_LIMITS).every(key => value[key] === null || Number.isInteger(value[key]));
  if (manifest?.owner !== "muster" || manifest.format !== 1 || typeof manifest.configPath !== "string"
    || typeof manifest.configCreated !== "boolean" || typeof manifest.sectionCreated !== "boolean"
    || !validValues(manifest.before) || !validValues(manifest.installed)) {
    throw new Error(`Codex thread-limit manifest conflict: ${manifestPath}. Move it or remove it, then rerun the command.`);
  }
  return manifest;
}

function clone(value) { return JSON.parse(JSON.stringify(value)); }
const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);
const groupCommands = group => (group?.hooks || []).flatMap(hook => [hook?.command, hook?.commandWindows, hook?.command_windows]).filter(Boolean);
const isMusterHookCommand = command => typeof command === "string" && command.replaceAll("\\", "/").includes("/muster/hooks/muster-hook.mjs");

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

function shellCommand(path) {
  if (/[\r\n\0]/.test(path)) throw new Error(`Codex hook path contains unsupported control characters: ${path}`);
  const posix = `'${path.replaceAll("'", `'\\''`)}'`;
  const windows = formatCodexWindowsPath(path).replaceAll('"', '\\"');
  return { command: `node ${posix}`, commandWindows: `node "${windows}"` };
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
async function userScopeHooksHealthy({ home }) {
  const dir = codexHome(home);
  const runtimeDir = join(dir, "muster"), manifestPath = join(runtimeDir, MANIFEST), configPath = join(dir, "hooks.json");
  if (!(await safeExists(manifestPath))) return false;
  let manifest;
  try { manifest = validateHookManifest(await readJson(manifestPath), runtimeDir, manifestPath); }
  catch { return false; }
  const events = Object.entries(manifest.hookGroups || {});
  if (!manifest.files.length || !events.length) return false;
  for (const file of manifest.files) if (!(await safeExists(join(runtimeDir, file)))) return false;
  if (!(await safeExists(configPath))) return false;
  let config;
  try { config = await readJson(configPath); }
  catch { return false; }
  if (!config || typeof config !== "object" || Array.isArray(config) || typeof config.hooks !== "object" || !config.hooks || Array.isArray(config.hooks)) return false;
  for (const [event, groups] of events) {
    if (!Array.isArray(groups) || !groups.length) return false;
    const current = Array.isArray(config.hooks[event]) ? config.hooks[event] : [];
    for (const group of groups) if (!current.some(candidate => same(candidate, group))) return false;
  }
  return true;
}

async function prepareHooks({ scope, cwd, home, hookSourceRoot, packageVersion }) {
  const dir = configDir(scope, cwd, home);
  const runtimeDir = join(dir, "muster"), manifestPath = join(runtimeDir, MANIFEST), configPath = join(dir, "hooks.json");
  await ordinaryDirectoryPath(dir);
  await ordinaryDirectoryPath(runtimeDir);
  const manifestExists = await safeExists(manifestPath), configExists = await safeExists(configPath);
  const manifestRaw = manifestExists ? await readJson(manifestPath) : null;
  const previous = manifestExists ? validateHookManifest(manifestRaw, runtimeDir, manifestPath) : null;
  let config = { hooks: {} };
  if (configExists) {
    config = await readJson(configPath);
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
  if (previous) config = removeOwnedHookGroups(config, previous.hookGroups, configPath);

  const skipped = scope === "project" && await userScopeHooksHealthy({ home });

  const templatePath = join(hookSourceRoot, "hooks.json");
  const template = await readJson(templatePath);
  if (!template?.hooks || typeof template.hooks !== "object") throw new Error(`Codex hook template is missing or malformed: ${templatePath}`);
  const runtimeScript = join(runtimeDir, "hooks", "muster-hook.mjs");
  const command = shellCommand(runtimeScript);
  const hookGroups = skipped ? {} : clone(template.hooks);
  if (!skipped) {
    for (const groups of Object.values(hookGroups)) for (const group of groups) for (const hook of group.hooks || []) {
      hook.command = command.command;
      hook.commandWindows = command.commandWindows;
    }
    for (const [event, groups] of Object.entries(hookGroups)) config.hooks[event] = [...(config.hooks[event] || []), ...groups];
  }
  const hookFiles = skipped ? [] : HOOK_FILES;
  const sourceFiles = skipped ? new Map() : new Map([
    ["hooks/muster-hook.mjs", join(hookSourceRoot, "muster-hook.mjs")],
    ["hooks/action-guard.mjs", join(hookSourceRoot, "action-guard.mjs")]
  ]);
  const hookHash = createHash("sha256");
  for (const [file, sourcePath] of sourceFiles) hookHash.update(file).update("\0").update(await readSafe(sourcePath));
  return {
    dir, runtimeDir, manifestPath, manifestExists, configPath, configExists, config,
    staleFiles: (previous?.files || []).filter(file => !hookFiles.includes(file)),
    manifest: { format: 1, owner: "muster", files: hookFiles, packageVersion, hookHash: hookHash.digest("hex"), hookConfigCreated: previous?.hookConfigCreated ?? !configExists, hookGroups },
    sourceFiles, hookFiles,
    skipped: skipped ? "user-scope-canonical" : null,
    previousOwnedHookStateKeys
  };
}

async function snapshot(originals, changed, path) {
  if (originals.has(path)) return;
  originals.set(path, await safeExists(path) ? await readSafe(path, "utf8") : null);
  changed.push(path);
}

async function restoreFilesystem(originals, changed) {
  for (const destination of [...changed].reverse()) {
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

async function existingMusterMarketplace(execFile, repoRoot) {
  const result = await runJson(execFile, ["plugin", "marketplace", "list", "--json"]);
  const matches = Array.isArray(result?.marketplaces) ? result.marketplaces.filter(item => item.name === "muster") : [];
  const trusted = await Promise.all(matches.map(item => trustedMusterMarketplace(item, repoRoot)));
  if (trusted.some(value => !value)) {
    throw new Error(`Codex marketplace conflict: "muster" is registered from an unexpected source. Run "codex plugin marketplace remove muster", then rerun muster install codex.`);
  }
  return matches[0];
}

async function registerPlugin(execFile, dryRun, repoRoot) {
  if (dryRun) return [`codex plugin marketplace add ${repoRoot}`, `codex plugin add ${CODEX_PLUGIN}`];
  let marketplaceAdded = false, pluginAdded = false;
  try {
    const marketplace = await existingMusterMarketplace(execFile, repoRoot);
    if (!marketplace) {
      await run(execFile, ["plugin", "marketplace", "add", repoRoot]);
      marketplaceAdded = true;
    }
    await runJson(execFile, ["plugin", "list", "--available", "--json"]);
    await run(execFile, ["plugin", "add", CODEX_PLUGIN]);
    pluginAdded = true;
    return [];
  } catch (error) {
    if (pluginAdded) try { await run(execFile, ["plugin", "remove", CODEX_PLUGIN]); } catch { /* best-effort transaction rollback */ }
    if (marketplaceAdded) try { await run(execFile, ["plugin", "marketplace", "remove", "muster"]); } catch { /* best-effort transaction rollback */ }
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

export async function runCodexInstall({ scope = "project", dryRun = false, cwd = process.cwd(), home = homedir(), repoRoot, execFile = execFileDefault, scopeLockOptions } = {}) {
  if (!["project", "user"].includes(scope)) throw new Error("codex install scope must be project or user");
  const root = repoRoot || fileURLToPath(new URL("../", import.meta.url));
  const pluginRoot = await exists(join(root, ".codex-plugin", "plugin.json"));
  const packageVersion = JSON.parse(await readSafe(join(root, "package.json"))).version;
  if (typeof packageVersion !== "string" || !packageVersion.trim()) throw new Error("Codex installation source is missing a coherent package version");
  const { files, read: readProfile } = await profileSource(root, pluginRoot);
  if (!files.length) throw new Error("Codex profiles are missing; run npm run build:codex first");
  // The richer Codex "plugin" (skills/commands/MCP) is generated fresh at
  // install time into `<distributionRoot>/.agents/plugins/`, a gitignored
  // staging directory alongside muster's own source — never into a
  // git-tracked path. The other install-time-generation target this wave
  // names (the user's CODEX_HOME) is already where scope="user" profile
  // TOMLs land via `agentsDir`/`configDir` above; the plugin tree does not
  // need a second CODEX_HOME copy of itself per scope.
  const distributionRoot = pluginRoot ? resolve(root, "..") : root;
  const dir = agentsDir(scope, cwd, home), manifestPath = join(dir, MANIFEST);
  // Thread-limit enforcement targets the single shared CODEX_HOME
  // config.toml (Codex CLI/IDE/Desktop all read the same file -- see
  // docs/research/codex-desktop.md section 5), independent of the profile
  // install scope above: a project-scope install still raises the global
  // floor, since that is the file Codex itself actually reads it from.
  const threadLimitConfigPath = codexThreadLimitConfigPath(codexHome(home));
  const threadLimitManifestPath = codexThreadLimitManifestPath(codexHome(home));
  await ordinaryDirectoryPath(configDir(scope, cwd, home));
  await ordinaryDirectoryPath(dir);
  const manifest = await readJson(manifestPath);
  const manifestExists = await safeExists(manifestPath);
  const managedFiles = manifestExists ? validateManagedFiles(manifest, dir, manifestPath) : [];
  const hookSourceRoot = pluginRoot ? join(root, "runtime", "install-hooks") : join(root, "codex", "hooks");
  const hooks = await prepareHooks({ scope, cwd, home, hookSourceRoot, packageVersion });
  const managed = new Set(managedFiles.map(file => resolve(dir, file)));
  const staleFiles = managedFiles.filter(file => !files.includes(file));
  for (const file of files) {
    const destination = join(dir, file);
    if (await safeExists(destination) && !managed.has(resolve(destination))) throw new Error(`Codex profile conflict: ${destination}. Move it or remove it, then rerun muster install codex.`);
  }
  const present = await codexAvailable({ execFile });
  if (present && !dryRun) {
    await existingMusterMarketplace(execFile, distributionRoot);
    if (!pluginRoot) {
      // buildCodexPlugin is itself idempotent (skips regeneration when
      // outDir already holds a current-version plugin), so this fires an
      // esbuild rebuild only when actually needed — including for the many
      // tests whose actual subject is unrelated registry/hook transaction
      // behavior, not plugin generation.
      const { buildCodexPlugin } = await import("../scripts/build-codex.mjs");
      await buildCodexPlugin({ root, outDir: join(distributionRoot, ".agents", "plugins") });
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
    { op: "merge", path: threadLimitConfigPath }
  ];
  let originals, changed;
  let actions = [];
  const prunedScopes = [], prunedHookState = [], prunedProjectTrust = [];
  if (!dryRun) {
    originals = new Map(); changed = [];
    await withScopeRegistryTransaction(home, async registry => {
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
        await atomicWriteSafe(registry.path, registryText(reconciled));
        for (const file of files) {
          const destination = join(dir, file);
          await snapshot(originals, changed, destination);
          await atomicWriteSafe(destination, await readProfile(file));
        }
        for (const file of staleFiles) {
          const destination = join(dir, file);
          await snapshot(originals, changed, destination);
          await removeSafe(destination);
        }
        await snapshot(originals, changed, manifestPath);
        await atomicWriteSafe(manifestPath, JSON.stringify({ format: 1, owner: "muster", files, packageVersion }, null, 2) + "\n");
        for (const [file, sourcePath] of hooks.sourceFiles) {
          const destination = join(hooks.runtimeDir, file);
          await snapshot(originals, changed, destination);
          await atomicWriteSafe(destination, await readFile(sourcePath, "utf8"));
        }
        for (const file of hooks.staleFiles) {
          const destination = join(hooks.runtimeDir, file);
          await snapshot(originals, changed, destination);
          await removeSafe(destination);
        }
        await snapshot(originals, changed, hooks.configPath);
        await atomicWriteSafe(hooks.configPath, JSON.stringify(hooks.config, null, 2) + "\n");
        await snapshot(originals, changed, hooks.manifestPath);
        await atomicWriteSafe(hooks.manifestPath, JSON.stringify(hooks.manifest, null, 2) + "\n");
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
          const hookStateReconcile = reconcileConfigTomlHookState(existingConfigText, hookStateEntries, reconciled, {
            onPrune: pruned => (pruned.type === "hooks.state" ? prunedHookState : prunedProjectTrust).push(pruned)
          });
          const threadLimits = ensureCodexThreadLimits(hookStateReconcile.text);
          // A repeat install must not re-derive before/sectionCreated/
          // configCreated from the ALREADY-raised file -- that would
          // permanently lose the true pre-Muster baseline the very first
          // install recorded, so an eventual last-scope uninstall could
          // never fully restore it. Mirrors prepareHooks' identical
          // `previous?.hookConfigCreated ?? !configExists` guard above.
          const previousManifest = await safeExists(threadLimitManifestPath)
            ? validateThreadLimitManifest(await readJson(threadLimitManifestPath), threadLimitManifestPath)
            : null;
          const before = previousManifest?.before ?? threadLimits.before;
          const sectionCreated = previousManifest ? previousManifest.sectionCreated : threadLimits.sectionCreated;
          const configCreated = previousManifest ? previousManifest.configCreated : !configExistedBefore;
          await snapshot(originals, changed, threadLimitConfigPath);
          await atomicWriteSafe(threadLimitConfigPath, threadLimits.text);
          await snapshot(originals, changed, threadLimitManifestPath);
          await atomicWriteSafe(threadLimitManifestPath, JSON.stringify({
            format: 1, owner: "muster", configPath: threadLimitConfigPath,
            before, installed: threadLimits.installed,
            sectionCreated, configCreated
          }, null, 2) + "\n");
        } catch (error) {
          throw new Error(`Codex config.toml thread limits could not be enforced at ${threadLimitConfigPath}: ${error.message}. ${CODEX_THREAD_LIMIT_REMEDIATION}`);
        }
        actions = present ? await registerPlugin(execFile, false, distributionRoot) : [];
      } catch (error) {
        await restoreFilesystem(originals, changed);
        throw error;
      }
    }, scopeLockOptions);
  } else {
    actions = present ? await registerPlugin(execFile, true, distributionRoot) : [];
  }
  return { ok: true, target: "codex", scope, dryRun, profiles: files.length, hooks: Object.keys(hooks.manifest.hookGroups).length, files: planned,
    hooksSkipped: hooks.skipped,
    prunedScopes, prunedHookState, prunedProjectTrust,
    plugin: present ? { registered: !dryRun, actions } : { registered: false, skipped: "codex-not-found" },
    nextSteps: present ? [] : ["npm install -g @openai/codex", `muster install codex --scope ${scope}`] };
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

export async function runCodexUninstall({ scope = "project", dryRun = false, cwd = process.cwd(), home = homedir(), execFile = execFileDefault } = {}) {
  if (!["project", "user"].includes(scope)) throw new Error("codex uninstall scope must be project or user");
  const dir = agentsDir(scope, cwd, home), manifestPath = join(dir, MANIFEST);
  await ordinaryDirectoryPath(configDir(scope, cwd, home));
  await ordinaryDirectoryPath(dir);
  const manifest = await readJson(manifestPath);
  const manifestExists = await safeExists(manifestPath);
  const managedFiles = manifestExists ? validateManagedFiles(manifest, dir, manifestPath) : [];
  const files = managedFiles.map(file => join(dir, file));
  const hookDir = configDir(scope, cwd, home), hookRuntimeDir = join(hookDir, "muster"), hookManifestPath = join(hookRuntimeDir, MANIFEST), hookConfigPath = join(hookDir, "hooks.json");
  await ordinaryDirectoryPath(hookRuntimeDir);
  const hookManifestExists = await safeExists(hookManifestPath), hookConfigExists = await safeExists(hookConfigPath);
  const hookManifest = hookManifestExists ? validateHookManifest(await readJson(hookManifestPath), hookRuntimeDir, hookManifestPath) : null;
  let hookConfig = null, removeHookConfig = false, departingScopeOwnedHookStateKeys = null;
  if (hookManifest) {
    const rawHookConfig = hookConfigExists ? await readJson(hookConfigPath) : { hooks: {} };
    if (!rawHookConfig || typeof rawHookConfig !== "object" || Array.isArray(rawHookConfig)) throw new Error(`Codex hook configuration conflict: ${hookConfigPath} is not valid JSON.`);
    // Fix iteration 1 (over-revocation blocker b): compute the departing
    // scope's EXACT owned [hooks.state] keys from its hooks.json BEFORE
    // muster's own groups are stripped out below, so a co-located non-muster
    // hook definition sharing this same hooksJsonPath (a different group or
    // hook index) is never conflated with muster's own and survives.
    departingScopeOwnedHookStateKeys = ownedHookStateKeys(rawHookConfig, hookManifest.hookGroups);
    hookConfig = removeOwnedHookGroups(rawHookConfig, hookManifest.hookGroups, hookConfigPath);
    const otherKeys = Object.keys(hookConfig).filter(key => key !== "hooks");
    removeHookConfig = hookManifest.hookConfigCreated && otherKeys.length === 0 && Object.keys(hookConfig.hooks || {}).length === 0;
  }
  const hookFiles = hookManifest ? hookManifest.files.map(file => join(hookRuntimeDir, file)) : [];
  const present = await codexAvailable({ execFile });
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
    ? validateThreadLimitManifest(await readJson(threadLimitManifestPath), threadLimitManifestPath)
    : null;
  let liveScopes = [], ownershipCertain = false, removePlugin = false, restoreThreadLimits = false, removeThreadLimitConfig = false;
  const prunedHookState = [], prunedProjectTrust = [];
  const uninstallScope = async registry => {
    liveScopes = await remainingManagedScopes(registry, currentScope);
    ownershipCertain = registry.present;
    removePlugin = present && ownsScope && ownershipCertain && liveScopes.length === 0;
    restoreThreadLimits = Boolean(threadLimitManifest) && ownershipCertain && liveScopes.length === 0;
    if (dryRun) return;
    const originals = new Map(), changed = [];
    try {
      await snapshot(originals, changed, registry.path);
      await atomicWriteSafe(registry.path, registryText(liveScopes));
      for (const file of files) { await snapshot(originals, changed, file); await removeSafe(file); }
      if (manifestExists) { await snapshot(originals, changed, manifestPath); await removeSafe(manifestPath); }
      for (const file of hookFiles) { await snapshot(originals, changed, file); await removeSafe(file); }
      if (hookManifestExists) { await snapshot(originals, changed, hookManifestPath); await removeSafe(hookManifestPath); }
      if (hookManifest) {
        await snapshot(originals, changed, hookConfigPath);
        if (removeHookConfig) await removeSafe(hookConfigPath);
        else await atomicWriteSafe(hookConfigPath, JSON.stringify(hookConfig, null, 2) + "\n");
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
          currentConfigText = hookStateReconcile.text;
          if (restoreThreadLimits) currentConfigText = restoreCodexThreadLimits(currentConfigText, threadLimitManifest);
          removeThreadLimitConfig = restoreThreadLimits && threadLimitManifest.configCreated && currentConfigText.trim() === "";
          if (removeThreadLimitConfig) await removeSafe(threadLimitConfigPath);
          else await atomicWriteSafe(threadLimitConfigPath, currentConfigText);
          if (restoreThreadLimits) {
            await snapshot(originals, changed, threadLimitManifestPath);
            await removeSafe(threadLimitManifestPath);
          }
        } catch (error) {
          throw new Error(`Codex config.toml hook-state/thread-limit reconciliation could not complete at ${threadLimitConfigPath}: ${error.message}. ${CODEX_THREAD_LIMIT_REMEDIATION}`);
        }
      }
      if (removePlugin) await run(execFile, ["plugin", "remove", CODEX_PLUGIN]);
    } catch (error) {
      await restoreFilesystem(originals, changed);
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
    ...hookFiles.map(path => ({ op: "remove", path })),
    ...(hookManifest ? [{ op: removeHookConfig ? "remove" : "merge", path: hookConfigPath }] : []),
    ...(restoreThreadLimits ? [{ op: removeThreadLimitConfig ? "remove" : "merge", path: threadLimitConfigPath }] : [])
  ];
  return { ok: true, target: "codex", scope, dryRun, files: planned,
    prunedHookState, prunedProjectTrust,
    plugin: present ? { removed: !dryRun && removePlugin, retained: liveScopes.length > 0, ownershipCertain } : { removed: false, skipped: "codex-not-found" },
    nextSteps: present ? [] : ["npm install -g @openai/codex", `muster uninstall codex --scope ${scope}`] };
}
