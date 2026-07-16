import { constants as fsConstants } from "node:fs";
import { link, lstat, mkdir, open, readFile, realpath, rename, rmdir, unlink } from "node:fs/promises";
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
  if (registry?.format !== 1 || !Array.isArray(registry.entries)) throw new Error(`Codex managed-scope registry is invalid: ${path}`);
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
  if (previous) config = removeOwnedHookGroups(config, previous.hookGroups, configPath);

  const templatePath = join(hookSourceRoot, "hooks.json");
  const template = await readJson(templatePath);
  if (!template?.hooks || typeof template.hooks !== "object") throw new Error(`Codex hook template is missing or malformed: ${templatePath}`);
  const runtimeScript = join(runtimeDir, "hooks", "muster-hook.mjs");
  const command = shellCommand(runtimeScript);
  const hookGroups = clone(template.hooks);
  for (const groups of Object.values(hookGroups)) for (const group of groups) for (const hook of group.hooks || []) {
    hook.command = command.command;
    hook.commandWindows = command.commandWindows;
  }
  for (const [event, groups] of Object.entries(hookGroups)) config.hooks[event] = [...(config.hooks[event] || []), ...groups];
  const sourceFiles = new Map([
    ["hooks/muster-hook.mjs", join(hookSourceRoot, "muster-hook.mjs")],
    ["hooks/action-guard.mjs", join(hookSourceRoot, "action-guard.mjs")]
  ]);
  const hookHash = createHash("sha256");
  for (const [file, sourcePath] of sourceFiles) hookHash.update(file).update("\0").update(await readSafe(sourcePath));
  return {
    dir, runtimeDir, manifestPath, manifestExists, configPath, configExists, config,
    staleFiles: (previous?.files || []).filter(file => !HOOK_FILES.includes(file)),
    manifest: { format: 1, owner: "muster", files: HOOK_FILES, packageVersion, hookHash: hookHash.digest("hex"), hookConfigCreated: previous?.hookConfigCreated ?? !configExists, hookGroups },
    sourceFiles
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
    ...HOOK_FILES.map(file => ({ op: "write", path: join(hooks.runtimeDir, file) })),
    ...hooks.staleFiles.map(file => ({ op: "remove", path: join(hooks.runtimeDir, file) })),
    { op: "merge", path: hooks.configPath }
  ];
  let originals, changed;
  let actions = [];
  if (!dryRun) {
    originals = new Map(); changed = [];
    await withScopeRegistryTransaction(home, async registry => {
      await ordinaryDirectoryPath(dir, { create: true });
      try {
        const currentScope = await scopeEntry(scope, cwd, home);
        await snapshot(originals, changed, registry.path);
        await atomicWriteSafe(registry.path, registryText([...registry.entries.filter(entry => !sameScopeEntry(entry, currentScope)), currentScope]));
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
  let hookConfig = null, removeHookConfig = false;
  if (hookManifest) {
    hookConfig = hookConfigExists ? await readJson(hookConfigPath) : { hooks: {} };
    if (!hookConfig || typeof hookConfig !== "object" || Array.isArray(hookConfig)) throw new Error(`Codex hook configuration conflict: ${hookConfigPath} is not valid JSON.`);
    hookConfig = removeOwnedHookGroups(hookConfig, hookManifest.hookGroups, hookConfigPath);
    const otherKeys = Object.keys(hookConfig).filter(key => key !== "hooks");
    removeHookConfig = hookManifest.hookConfigCreated && otherKeys.length === 0 && Object.keys(hookConfig.hooks || {}).length === 0;
  }
  const hookFiles = hookManifest ? hookManifest.files.map(file => join(hookRuntimeDir, file)) : [];
  const present = await codexAvailable({ execFile });
  const ownsScope = manifestExists || hookManifestExists;
  const currentScope = await scopeEntry(scope, cwd, home);
  let liveScopes = [], ownershipCertain = false, removePlugin = false;
  const planned = [
    ...files.map(path => ({ op: "remove", path })),
    ...hookFiles.map(path => ({ op: "remove", path })),
    ...(hookManifest ? [{ op: removeHookConfig ? "remove" : "merge", path: hookConfigPath }] : [])
  ];
  const uninstallScope = async registry => {
    liveScopes = await remainingManagedScopes(registry, currentScope);
    ownershipCertain = registry.present;
    removePlugin = present && ownsScope && ownershipCertain && liveScopes.length === 0;
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
    } catch (error) {
      await restoreFilesystem(originals, changed);
      throw error;
    }
    for (const empty of [join(hookRuntimeDir, "hooks"), hookRuntimeDir]) try {
      await ordinaryDirectoryPath(empty);
      await rmdir(empty);
    } catch { /* preserve non-empty user content */ }
    if (removePlugin) try { await run(execFile, ["plugin", "remove", CODEX_PLUGIN]); } catch { /* already absent is idempotent */ }
  };
  if (dryRun) await uninstallScope(await readScopeRegistry(home));
  else await withScopeRegistryTransaction(home, uninstallScope);
  return { ok: true, target: "codex", scope, dryRun, files: planned,
    plugin: present ? { removed: !dryRun && removePlugin, retained: liveScopes.length > 0, ownershipCertain } : { removed: false, skipped: "codex-not-found" },
    nextSteps: present ? [] : ["npm install -g @openai/codex", `muster uninstall codex --scope ${scope}`] };
}
