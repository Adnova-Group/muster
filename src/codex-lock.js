import { randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { lstat, open, readFile, unlink, utimes } from "node:fs/promises";

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

// Dropped: a quarantine/retirement dance (rename a contested lock into a
// private per-attempt directory, re-validate identity, then delete) that
// guarded every stale-lock reclaim and lock release. A per-user Codex install
// does not need multi-stage crash-safe lock handoff; a single lockfile with a
// direct unlink-then-retry (reclaim) or unlink-after-ownership-check
// (release) is enough, and it is ~150 fewer lines to reason about.

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

async function reclaimIfStale(path, options) {
  let current;
  try { current = await readLock(path); }
  catch (error) { if (error.code === "ENOENT") return true; throw error; }
  if (!await lockIsStale(current, options)) return false;
  try {
    const before = await lstat(path);
    if (before.dev !== current.stat.dev || before.ino !== current.stat.ino) return false;
    await unlink(path);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return true;
    throw error;
  }
}

export async function withCodexFileLock(path, callback, {
  staleMs = 60_000,
  maxStaleMs = 15 * 60_000,
  timeoutMs = 30_000,
  beforeOpen
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
      if (await reclaimIfStale(path, { staleMs, maxStaleMs })) continue;
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
      await unlink(path);
    } catch (error) { if (error.code !== "ENOENT") throw error; }
  }
}
