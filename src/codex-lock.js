import { randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { link, lstat, mkdir, open, readFile, rename, rmdir, unlink, utimes } from "node:fs/promises";
import { dirname, join } from "node:path";

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

export function processAlive(pid) {
  if (!Number.isInteger(pid) || pid < 1) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code === "EPERM"; }
}

// Linux exposes a kernel-assigned process start tick. It prevents PID reuse or
// a forged live PID from extending a lock. Native Windows has no matching
// dependency-free API, so callers also enforce a hard heartbeat expiry.
export async function processStartIdentity(pid = process.pid) {
  if (process.platform !== "linux" || !Number.isInteger(pid) || pid < 1) return null;
  try {
    const stat = await readFile(`/proc/${pid}/stat`, "utf8");
    const close = stat.lastIndexOf(")");
    const fields = stat.slice(close + 2).trim().split(/\s+/);
    const startTicks = fields[19];
    return /^\d+$/.test(startTicks || "") ? `linux-proc-start:${startTicks}` : null;
  } catch { return null; }
}

async function readLock(path, maxBytes = 16 * 1024) {
  let handle;
  try {
    const before = await lstat(path);
    if (before.isSymbolicLink() || !before.isFile() || before.size > maxBytes) throw new Error(`unsafe Codex transaction lock: ${path}`);
    handle = await open(path, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW || 0));
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > maxBytes) throw new Error(`unsafe Codex transaction lock: ${path}`);
    let record = null;
    try { record = JSON.parse(await handle.readFile("utf8")); } catch { /* a partial crashed writer becomes reclaimable after expiry */ }
    return { record, stat };
  } finally { if (handle) await handle.close().catch(() => {}); }
}

// The per-acquire owner identity carried in the lockfile: pid + a random nonce
// (token) + the lock's start time (createdAt) + the process start identity. Each
// acquire writes a fresh token, so this string uniquely names one lock instance.
// A replacement owner that reclaimed after a prior reclaimer's staleness decision
// always writes its own identity, so it can never byte-match the stale instance.
function lockIdentity(record) {
  if (!record || typeof record !== "object") return null;
  const { pid, token, createdAt, processIdentity } = record;
  if (typeof token !== "string" || !token) return null;
  return JSON.stringify({ pid, token, createdAt, processIdentity });
}

const sameInode = (left, right) => left.dev === right.dev && left.ino === right.ino;

function sameLock(current, expected) {
  if (!sameInode(current.stat, expected.stat)) return false;
  const currentIdentity = lockIdentity(current.record);
  const expectedIdentity = lockIdentity(expected.record);
  return expectedIdentity === null ? currentIdentity === null : currentIdentity === expectedIdentity;
}

async function assertPrivateRetirementDirectory(path) {
  const stat = await lstat(path);
  const uid = typeof process.getuid === "function" ? process.getuid() : null;
  const ownerMismatch = process.platform !== "win32" && typeof uid === "number" && stat.uid !== uid;
  const unsafeMode = process.platform !== "win32" && ((stat.mode & 0o700) !== 0o700 || (stat.mode & 0o077) !== 0);
  if (stat.isSymbolicLink() || !stat.isDirectory() || ownerMismatch || unsafeMode) {
    throw new Error(`unsafe Codex transaction retirement directory: ${path}`);
  }
}

async function privateRetirement(path) {
  for (let attempt = 0; attempt < 8; attempt++) {
    const dir = join(dirname(path), `.muster-retired-${process.pid}-${randomUUID()}`);
    try { await mkdir(dir, { mode: 0o700 }); }
    catch (error) { if (error.code === "EEXIST" && attempt < 7) continue; throw error; }
    await assertPrivateRetirementDirectory(dir);
    return { dir, path: join(dir, "lock") };
  }
  throw new Error(`could not create Codex transaction retirement directory for ${path}`);
}

async function removeRetirement(retirement) {
  await assertPrivateRetirementDirectory(retirement.dir);
  await unlink(retirement.path);
  await rmdir(retirement.dir);
}

async function restoreRetiredLock(path, retirement, expected) {
  await assertPrivateRetirementDirectory(retirement.dir);
  let current;
  try { current = await lstat(retirement.path); }
  catch (error) { if (error.code === "ENOENT") return false; throw error; }
  // Restoration is non-destructive: bind it to the stable quarantined inode,
  // not mutable record bytes. A legitimate replacement owner can still be
  // finishing its initial write while a stale reclaimer moves that inode.
  if (!sameInode(current, expected.stat)) return false;
  try { await link(retirement.path, path); }
  catch (error) {
    if (error.code === "EEXIST") return false;
    throw error;
  }
  const restored = await lstat(path);
  if (!sameInode(restored, expected.stat)) throw new Error(`Codex transaction lock restore changed identity: ${path}`);
  await removeRetirement(retirement);
  return true;
}

async function restoreOrRequireReplacement(path, retirement, expected) {
  if (await restoreRetiredLock(path, retirement, expected)) return;
  try { await lstat(path); }
  catch (error) {
    if (error.code === "ENOENT") {
      throw new Error(`Codex transaction lock could not be restored after ownership changed: ${path}`);
    }
    throw error;
  }
}

async function lockIsStale(current, { staleMs, maxStaleMs }) {
  const age = Date.now() - current.stat.mtimeMs;
  if (age < staleMs) return false;
  const pid = Number(current.record?.pid);
  const alive = processAlive(pid);
  const actualIdentity = alive ? await processStartIdentity(pid) : null;
  const recordedIdentity = typeof current.record?.processIdentity === "string" ? current.record.processIdentity : null;
  const sameProcess = alive && recordedIdentity && actualIdentity && recordedIdentity === actualIdentity;
  if (sameProcess && age < maxStaleMs) return false;
  if (alive && (!recordedIdentity || !actualIdentity) && age < maxStaleMs) return false;
  return true;
}

async function retireLock(path, expected, {
  restorePath = path,
  stale,
  afterValidation,
  beforeRestore
} = {}) {
  const retirement = await privateRetirement(path);
  try { await rename(path, retirement.path); }
  catch (error) {
    try { await rmdir(retirement.dir); } catch { /* preserve an ambiguous retirement directory */ }
    if (error.code === "ENOENT") return { removed: false, missing: true };
    throw error;
  }

  await assertPrivateRetirementDirectory(retirement.dir);
  const retired = await readLock(retirement.path);
  if (!sameLock(retired, expected) || (stale && !await stale(retired))) {
    if (beforeRestore) await beforeRestore({ path: restorePath, retirementPath: retirement.path });
    await restoreOrRequireReplacement(restorePath, retirement, retired);
    return { removed: false, missing: false };
  }

  if (afterValidation) await afterValidation({ path: restorePath, retirementPath: retirement.path });

  // Validate once more after the injected test seam. The only pathname ever
  // deleted is now inside a fresh private directory, never the public lock
  // pathname where a replacement owner can appear.
  await assertPrivateRetirementDirectory(retirement.dir);
  const final = await readLock(retirement.path);
  if (!sameLock(final, retired) || (stale && !await stale(final))) {
    if (beforeRestore) await beforeRestore({ path: restorePath, retirementPath: retirement.path });
    await restoreOrRequireReplacement(restorePath, retirement, final);
    return { removed: false, missing: false };
  }
  await removeRetirement(retirement);
  return { removed: true, missing: false };
}

async function reclaimIfStale(path, options, onReclaimRaceWindow, afterValidation, beforeRestore) {
  let current;
  try { current = await readLock(path); }
  catch (error) { if (error.code === "ENOENT") return true; throw error; }
  if (!await lockIsStale(current, options)) return false;
  if (onReclaimRaceWindow) await onReclaimRaceWindow();
  const result = await retireLock(path, current, {
    stale: state => lockIsStale(state, options),
    restorePath: path,
    afterValidation,
    beforeRestore
  });
  return result.removed || result.missing;
}

export async function withCodexFileLock(path, callback, {
  staleMs = 60_000,
  maxStaleMs = 15 * 60_000,
  timeoutMs = 30_000,
  beforeOpen,
  releaseGuard,
  // Test-only seams for deterministic replacement-owner races. Production
  // callers never pass them.
  __reclaimRaceHook,
  __afterReclaimValidationHook,
  __afterReleaseValidationHook,
  __beforeRestoreHook
} = {}) {
  const token = randomUUID();
  const processIdentity = await processStartIdentity();
  const started = Date.now();
  for (;;) {
    // Optional caller guard fired synchronously before EACH create attempt (a
    // contended lock retries, and the guarded condition — e.g. a symlinked
    // ancestor swapped under `path` — can change between attempts). A throw
    // here aborts acquisition before open(path,"wx") can create the lock file
    // through a swapped ancestor into an attacker's target (codex-release.js's
    // residual (i)). O_CREAT|O_EXCL ("wx") itself does not guard ancestors.
    if (beforeOpen) await beforeOpen();
    let handle;
    try {
      handle = await open(path, "wx", 0o600);
      await handle.writeFile(JSON.stringify({ format: 1, pid: process.pid, processIdentity, createdAt: Date.now(), token }) + "\n", "utf8");
      await handle.sync();
      await handle.close();
      break;
    } catch (error) {
      if (handle) await handle.close().catch(() => {});
      if (error.code !== "EEXIST") throw error;
      if (await reclaimIfStale(path, { staleMs, maxStaleMs }, __reclaimRaceHook, __afterReclaimValidationHook, __beforeRestoreHook)) continue;
      if (Date.now() - started >= timeoutMs) throw new Error(`timed out waiting for Codex transaction lock: ${path}`);
      await pause(Math.min(25, 5 + Math.floor((Date.now() - started) / 100)));
    }
  }

  const heartbeat = setInterval(async () => {
    try {
      const current = await readLock(path);
      if (current.record?.token === token) await utimes(path, new Date(), new Date());
    } catch { /* lock release/recovery owns the diagnostic */ }
  }, Math.max(1_000, Math.floor(staleMs / 3)));
  heartbeat.unref();
  try { return await callback(); }
  finally {
    clearInterval(heartbeat);
    if (releaseGuard) await releaseGuard();
    try {
      const current = await readLock(path);
      if (current.record?.token !== token) return;
      const result = await retireLock(path, current, {
        afterValidation: __afterReleaseValidationHook
      });
      if (!result.removed && !result.missing) {
        throw new Error(`Codex transaction lock ownership changed: ${path}`);
      }
    } catch (error) { if (error.code !== "ENOENT") throw error; }
  }
}
