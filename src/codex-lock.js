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

async function assertPrivateRetirementDirectory(dir) {
  const stat = await lstat(dir);
  const uid = typeof process.getuid === "function" ? process.getuid() : null;
  const ownerMismatch = process.platform !== "win32" && typeof uid === "number" && stat.uid !== uid;
  const unsafeMode = process.platform !== "win32" && ((stat.mode & 0o700) !== 0o700 || (stat.mode & 0o077) !== 0);
  if (stat.isSymbolicLink() || !stat.isDirectory() || ownerMismatch || unsafeMode) {
    throw new Error(`unsafe Codex transaction retirement directory: ${dir}`);
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

async function restoreRetiredLock(path, retired, stat) {
  await assertPrivateRetirementDirectory(dirname(retired));
  const current = await lstat(retired);
  if (!sameInode(current, stat)) return false;
  try { await link(retired, path); }
  catch (error) {
    if (error.code === "EEXIST") return false;
    throw error;
  }
  const restored = await lstat(path);
  if (!sameInode(restored, stat)) throw new Error(`Codex transaction lock restore changed identity: ${path}`);
  // `retired` is inside a fresh 0700 directory created for this operation, so
  // deleting it cannot race a replacement at the public lock pathname.
  await unlink(retired);
  await rmdir(dirname(retired));
  return true;
}

async function restoreQuarantinedLock(path, quarantine, stat) {
  const retirement = await privateRetirement(quarantine);
  try { await rename(quarantine, retirement.path); }
  catch (error) {
    try { await rmdir(retirement.dir); } catch { /* preserve an ambiguous retirement directory */ }
    if (error.code === "ENOENT") return false;
    throw error;
  }
  return restoreRetiredLock(path, retirement.path, stat);
}

async function retireOwnedLock(path, expectedStat, expectedRecord, {
  stale = null,
  restorePath = path,
  afterRetirement = async () => {}
} = {}) {
  const retirement = await privateRetirement(path);
  try { await rename(path, retirement.path); }
  catch (error) {
    try { await rmdir(retirement.dir); } catch { /* leave an ambiguous retirement directory intact */ }
    if (error.code === "ENOENT") return false;
    throw error;
  }
  await afterRetirement({ dir: retirement.dir, path: retirement.path, sourcePath: path });
  await assertPrivateRetirementDirectory(retirement.dir);
  let retired;
  try { retired = await readLock(retirement.path); }
  catch { return false; }
  if (!sameInode(retired.stat, expectedStat) || !sameLockOwner(retired.record, expectedRecord)) {
    return false;
  }
  if (stale && !await stale(retired)) {
    await restoreRetiredLock(restorePath, retirement.path, expectedStat);
    return false;
  }
  // The final identity check happens after the atomic move into a private
  // retirement directory. Never validate a public pathname and then delete it.
  await assertPrivateRetirementDirectory(retirement.dir);
  await unlink(retirement.path);
  await rmdir(retirement.dir);
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
  afterRetirement = async () => {}
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
      await restoreQuarantinedLock(path, quarantine, quarantined.stat);
      return false;
    }
    await afterValidation({ path, quarantine });
    if (!await retireOwnedLock(quarantine, quarantined.stat, quarantined.record, {
      stale: state => lockIsStale(state, { staleMs, maxStaleMs }),
      restorePath: path,
      afterRetirement
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
  beforeRelease = async () => {}
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
      if (await reclaimStaleCodexFileLock(path, { staleMs, maxStaleMs, afterQuarantine, afterValidation, afterRetirement })) continue;
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
      if (!await retireOwnedLock(path, current.stat, current.record, { afterRetirement })) {
        throw new Error(`Codex transaction lock ownership changed: ${path}`);
      }
    } catch (error) { if (error.code !== "ENOENT") throw error; }
  }
}
