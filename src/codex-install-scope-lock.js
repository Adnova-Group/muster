// codex-install-scope-lock.js -- the managed-scope registry lock protocol,
// moved wholesale out of codex-install.js (split-codex-install). This
// protocol is DELIBERATELY divergent from codex-lock.js's withCodexFileLock;
// see docs/decisions/codex-install-lock-divergence.md. Only a wholesale move
// -- no semantics changed. Depends only on node builtins, codex-lock.js (for
// the two byte-identical/functionally-identical dedup exports), and
// codex-install-shared.js.
import { constants as fsConstants } from "node:fs";
import { lstat, mkdir, open, readFile, rename, rmdir, unlink, link } from "node:fs/promises";
import { dirname, join, parse, win32 } from "node:path";
import { randomUUID } from "node:crypto";
import { pause, processAlive, processStartIdentity, sameInode as sameScopeLockInode } from "./codex-lock.js";
import { scopeRegistryLockPath, ordinaryDirectoryPath, regularFileState, readScopeRegistry } from "./codex-install-shared.js";

const SCOPE_LOCK_STALE_MS = 5 * 60_000;

const SCOPE_LOCK_MAX_STALE_MS = 15 * 60_000;

export async function scopeLockText(token) {
  return JSON.stringify({
    format: 1,
    owner: "muster",
    pid: process.pid,
    processIdentity: await processStartIdentity(),
    token,
    createdAt: Date.now()
  }) + "\n";
}


export async function writeExclusiveSafe(path, content) {
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


export function parseScopeLock(text, path) {
  let lock;
  try { lock = JSON.parse(text); } catch { throw new Error(`Codex managed-scope lock is invalid: ${path}`); }
  if (lock?.format !== 1 || lock.owner !== "muster" || !Number.isSafeInteger(lock.pid) || lock.pid < 1
    || typeof lock.token !== "string" || !lock.token || !Number.isFinite(lock.createdAt) || lock.createdAt < 0
    || (Object.hasOwn(lock, "processIdentity") && lock.processIdentity !== null && typeof lock.processIdentity !== "string")) {
    throw new Error(`Codex managed-scope lock is invalid: ${path}`);
  }
  return lock;
}


export async function readScopeLock(path) {
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


export async function staleScopeLock(state) {
  const age = Date.now() - Math.max(state.lock.createdAt, state.stat.mtimeMs);
  if (age < SCOPE_LOCK_STALE_MS) return false;
  const alive = processAlive(state.lock.pid);
  if (!alive) return true;
  const recordedIdentity = typeof state.lock.processIdentity === "string" ? state.lock.processIdentity : null;
  const actualIdentity = await processStartIdentity(state.lock.pid);
  if (recordedIdentity && actualIdentity && recordedIdentity !== actualIdentity) return true;
  return age >= SCOPE_LOCK_MAX_STALE_MS;
}


export const sameScopeLockOwner = (left, right) => left.token === right.token && left.pid === right.pid
  && left.processIdentity === right.processIdentity && left.createdAt === right.createdAt
  && left.owner === right.owner && left.format === right.format;


export function defaultScopeRetirementModeCapability({ stat }) {
  return (stat.mode & 0o777) !== 0o777;
}


export async function assertPrivateScopeRetirementDirectory(dir, { expectedStat = null, requirePrivateMode = true } = {}) {
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


export async function privateScopeRetirement(path, { modeCapability = defaultScopeRetirementModeCapability } = {}) {
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


export async function removeEmptyScopeRetirementDirectory(retirement) {
  await assertPrivateScopeRetirementDirectory(retirement.dir, retirement);
  await rmdir(retirement.dir);
}


export async function restoreRetiredScopeLock(path, retirement, stat) {
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


export async function restoreQuarantinedScopeLock(path, quarantine, stat, { modeCapability } = {}) {
  const retirement = await privateScopeRetirement(quarantine, { modeCapability });
  try { await rename(quarantine, retirement.path); }
  catch (error) {
    try { await removeEmptyScopeRetirementDirectory(retirement); } catch { /* preserve an ambiguous retirement directory */ }
    if (error.code === "ENOENT") return false;
    throw error;
  }
  return restoreRetiredScopeLock(path, retirement, stat);
}


export async function retireOwnedScopeLock(path, expectedStat, expectedLock, {
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


export async function releaseScopeLock(path, token, {
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


export async function acquireRecoveryScopeLock(path, token, lockOptions) {
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


export async function recoverStaleScopeLock(path, {
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


export async function acquireScopeLock(home, {
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


export async function withScopeRegistryTransaction(home, action, lockOptions) {
  const held = await acquireScopeLock(home, lockOptions);
  try { return await action(await readScopeRegistry(home)); }
  finally { await releaseScopeLock(held.path, held.token, lockOptions); }
}

// Temp-write-then-rename via fs-safe.js's shared atomicWrite (audit S4); the
// ordinary-directory/regular-file re-assertions stay as the beforeRename hook
// so a swap landing between staging and publish still aborts before the
// rename. Temp naming is preserved verbatim.