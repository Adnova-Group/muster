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
// a forged live PID from extending a lock/lease. Native Windows has no matching
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

const sameInode = (left, right) => left.dev === right.dev && left.ino === right.ino;
const sameLockOwner = (left, right) => typeof left?.token === "string" && left.token.length > 0
  && left.token === right?.token && left.pid === right?.pid
  && left.processIdentity === right?.processIdentity && left.createdAt === right?.createdAt;

function defaultRetirementModeCapability({ stat }) {
  // A newly created 0700 directory reported as 0777 means the containing
  // filesystem normalized the requested POSIX mode bits (for example DrvFS).
  // Any other mode stays on the strict path and must pass the 0700 check.
  return (stat.mode & 0o777) !== 0o777;
}

async function assertPrivateRetirementDirectory(dir, { expectedStat = null, requirePrivateMode = true } = {}) {
  const stat = await lstat(dir);
  const uid = typeof process.getuid === "function" ? process.getuid() : null;
  const ownerMismatch = process.platform !== "win32" && typeof uid === "number" && stat.uid !== uid;
  const ownerChanged = expectedStat && stat.uid !== expectedStat.uid;
  const directoryChanged = expectedStat && !sameInode(stat, expectedStat);
  const unsafeMode = requirePrivateMode && process.platform !== "win32"
    && ((stat.mode & 0o700) !== 0o700 || (stat.mode & 0o077) !== 0);
  if (stat.isSymbolicLink() || !stat.isDirectory() || ownerMismatch || ownerChanged || directoryChanged || unsafeMode) {
    throw new Error(`unsafe Codex transaction retirement directory: ${dir}`);
  }
  return stat;
}

async function privateRetirement(path, { modeCapability = defaultRetirementModeCapability } = {}) {
  for (let attempt = 0; attempt < 8; attempt++) {
    const dir = join(dirname(path), `.muster-retired-${process.pid}-${randomUUID()}`);
    try { await mkdir(dir, { mode: 0o700 }); }
    catch (error) { if (error.code === "EEXIST" && attempt < 7) continue; throw error; }
    const stat = await lstat(dir);
    const requirePrivateMode = await modeCapability({ dir, stat });
    if (typeof requirePrivateMode !== "boolean") throw new Error(`invalid Codex retirement mode capability for ${dir}`);
    await assertPrivateRetirementDirectory(dir, { expectedStat: stat, requirePrivateMode });
    return { dir, path: join(dir, "lock"), stat, expectedStat: stat, requirePrivateMode };
  }
  throw new Error(`could not create Codex transaction retirement directory for ${path}`);
}

async function removeEmptyRetirementDirectory(retirement) {
  await assertPrivateRetirementDirectory(retirement.dir, retirement);
  await rmdir(retirement.dir);
}

async function restoreRetiredLock(path, retirement, stat) {
  await assertPrivateRetirementDirectory(retirement.dir, retirement);
  const current = await lstat(retirement.path);
  if (!sameInode(current, stat)) return false;
  try { await link(retirement.path, path); }
  catch (error) {
    if (error.code === "EEXIST") return false;
    throw error;
  }
  const restored = await lstat(path);
  if (!sameInode(restored, stat)) throw new Error(`Codex transaction lock restore changed identity: ${path}`);
  await assertPrivateRetirementDirectory(retirement.dir, retirement);
  await unlink(retirement.path);
  await removeEmptyRetirementDirectory(retirement);
  return true;
}

async function restoreQuarantinedLock(path, quarantine, stat, { modeCapability } = {}) {
  const retirement = await privateRetirement(quarantine, { modeCapability });
  try { await rename(quarantine, retirement.path); }
  catch (error) {
    try { await removeEmptyRetirementDirectory(retirement); } catch { /* preserve an ambiguous retirement directory */ }
    if (error.code === "ENOENT") return false;
    throw error;
  }
  return restoreRetiredLock(path, retirement, stat);
}

async function retireOwnedLock(path, expectedStat, expectedRecord, {
  stale = null,
  restorePath = path,
  afterRetirement = async () => {},
  modeCapability
} = {}) {
  let current;
  try { current = await readLock(path); }
  catch { return false; }
  if (!sameInode(current.stat, expectedStat) || !sameLockOwner(current.record, expectedRecord)) return false;
  const retirement = await privateRetirement(path, { modeCapability });
  try { await rename(path, retirement.path); }
  catch (error) {
    try { await removeEmptyRetirementDirectory(retirement); } catch { /* leave an ambiguous retirement directory intact */ }
    if (error.code === "ENOENT") return false;
    throw error;
  }
  await afterRetirement({ dir: retirement.dir, path: retirement.path, sourcePath: path });
  await assertPrivateRetirementDirectory(retirement.dir, retirement);
  let retired;
  try { retired = await readLock(retirement.path); }
  catch { return false; }
  if (!sameInode(retired.stat, expectedStat) || !sameLockOwner(retired.record, expectedRecord)) {
    return false;
  }
  if (stale && !await stale(retired)) {
    await restoreRetiredLock(restorePath, retirement, expectedStat);
    return false;
  }
  // The final identity checks happen after the atomic move into a private (or
  // mode-unavailable but inode-bound) retirement directory. Never validate a
  // public pathname and then delete it.
  await assertPrivateRetirementDirectory(retirement.dir, retirement);
  const final = await readLock(retirement.path);
  if (!sameInode(final.stat, expectedStat) || !sameLockOwner(final.record, expectedRecord)) return false;
  await unlink(retirement.path);
  await removeEmptyRetirementDirectory(retirement);
  return true;
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

export async function reclaimStaleCodexFileLock(path, {
  staleMs,
  maxStaleMs,
  afterQuarantine = async () => {},
  afterValidation = async () => {},
  afterRetirement = async () => {},
  modeCapability
}) {
  let current;
  try { current = await readLock(path); }
  catch (error) {
    if (error.code === "ENOENT") return true;
    throw error;
  }
  if (!sameLockOwner(current.record, current.record) || !await lockIsStale(current, { staleMs, maxStaleMs })) return false;

  const quarantine = `${path}.muster-reclaim-${process.pid}-${randomUUID()}`;
  try { await rename(path, quarantine); }
  catch (error) { if (error.code === "ENOENT") return true; throw error; }
  try {
    await afterQuarantine({ path, quarantine });
    const quarantined = await readLock(quarantine);
    if (!sameInode(quarantined.stat, current.stat) || !sameLockOwner(quarantined.record, current.record)
      || !await lockIsStale(quarantined, { staleMs, maxStaleMs })) {
      await restoreQuarantinedLock(path, quarantine, quarantined.stat, { modeCapability });
      return false;
    }
    await afterValidation({ path, quarantine });
    let finalCandidate;
    try { finalCandidate = await readLock(quarantine); }
    catch { return false; }
    if (!sameInode(finalCandidate.stat, quarantined.stat) || !sameLockOwner(finalCandidate.record, quarantined.record)
      || !await lockIsStale(finalCandidate, { staleMs, maxStaleMs })) {
      await restoreQuarantinedLock(path, quarantine, finalCandidate.stat, { modeCapability });
      return false;
    }
    if (!await retireOwnedLock(quarantine, finalCandidate.stat, finalCandidate.record, {
      stale: state => lockIsStale(state, { staleMs, maxStaleMs }),
      restorePath: path,
      afterRetirement,
      modeCapability
    })) return false;
  } catch (error) {
    // The stale candidate has already left the public pathname. Preserve any
    // ambiguous retirement entry rather than deleting an owner we cannot bind.
    throw error;
  }
  return true;
}

export async function withCodexFileLock(path, callback, {
  staleMs = 60_000,
  maxStaleMs = 15 * 60_000,
  timeoutMs = 30_000,
  afterQuarantine = async () => {},
  afterValidation = async () => {},
  afterRetirement = async () => {},
  beforeRelease = async () => {},
  modeCapability = defaultRetirementModeCapability
} = {}) {
  const token = randomUUID();
  const processIdentity = await processStartIdentity();
  const started = Date.now();
  let handle;
  for (;;) {
    try {
      handle = await open(path, "wx", 0o600);
      await handle.writeFile(JSON.stringify({ format: 1, pid: process.pid, processIdentity, createdAt: Date.now(), token }) + "\n", "utf8");
      await handle.sync();
      await handle.close();
      handle = null;
      break;
    } catch (error) {
      if (handle) { await handle.close().catch(() => {}); handle = null; }
      if (error.code !== "EEXIST") throw error;
      if (await reclaimStaleCodexFileLock(path, { staleMs, maxStaleMs, afterQuarantine, afterValidation, afterRetirement, modeCapability })) continue;
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
    try {
      const current = await readLock(path);
      if (current.record?.token !== token) return;
      await beforeRelease({ path });
      if (!await retireOwnedLock(path, current.stat, current.record, { afterRetirement, modeCapability })) {
        throw new Error(`Codex transaction lock ownership changed: ${path}`);
      }
    } catch (error) { if (error.code !== "ENOENT") throw error; }
  }
}
