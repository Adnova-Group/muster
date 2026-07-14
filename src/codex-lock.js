import { randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { link, lstat, open, readFile, rename, unlink, utimes } from "node:fs/promises";

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

async function restoreQuarantinedLock(path, quarantine, stat) {
  try { await link(quarantine, path); }
  catch (error) {
    if (error.code === "EEXIST") return false;
    throw error;
  }
  const restored = await lstat(path);
  if (!sameInode(restored, stat)) throw new Error(`Codex transaction lock restore changed identity: ${path}`);
  await unlink(quarantine);
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

export async function reclaimStaleCodexFileLock(path, { staleMs, maxStaleMs, afterQuarantine = async () => {} }) {
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
    const final = await readLock(quarantine);
    if (!sameInode(final.stat, quarantined.stat) || !sameLockOwner(final.record, quarantined.record)) {
      await restoreQuarantinedLock(path, quarantine, final.stat);
      return false;
    }
    await unlink(quarantine);
  } catch (error) {
    try {
      const stranded = await readLock(quarantine);
      await restoreQuarantinedLock(path, quarantine, stranded.stat);
    } catch { /* fail closed: never unlink an ambiguous quarantined owner */ }
    throw error;
  }
  return true;
}

export async function withCodexFileLock(path, callback, {
  staleMs = 60_000,
  maxStaleMs = 15 * 60_000,
  timeoutMs = 30_000,
  afterQuarantine = async () => {}
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
      if (await reclaimStaleCodexFileLock(path, { staleMs, maxStaleMs, afterQuarantine })) continue;
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
      if (current.record?.token === token) await unlink(path);
    } catch (error) { if (error.code !== "ENOENT") throw error; }
  }
}
