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

async function reclaimIfStale(path, options, onReclaimRaceWindow) {
  let current;
  try { current = await readLock(path); }
  catch (error) { if (error.code === "ENOENT") return true; throw error; }
  if (!await lockIsStale(current, options)) return false;
  const inspected = lockIdentity(current.record);
  try {
    const before = await lstat(path);
    if (before.dev !== current.stat.dev || before.ino !== current.stat.ino) return false;
    // The reclaim window: between deciding a lock is stale and removing it,
    // another process can unlink this exact instance and write its OWN fresh
    // lockfile, becoming the legitimate new owner. The dev/ino check above ran
    // BEFORE that could happen, and unlink() removes whatever is at `path` now
    // (it cannot tell a reused inode from the original) -- so re-read the lock as
    // the last gate and only unlink when it is still byte-for-byte the owner
    // identity we decided was dead. A replacement owner carries its own fresh
    // token, so it is left intact and this reclaimer loses the race cleanly (the
    // caller retries/backs off) instead of unlinking the new owner's lock and
    // letting two publish callbacks overlap. When the inspected lock was
    // corrupt/partial (no parseable identity), fall back to requiring an
    // unchanged inode so only that same unparseable instance is removed.
    if (onReclaimRaceWindow) await onReclaimRaceWindow(); // test-only seam; no-op in production
    const verify = await readLock(path);
    const verifyIdentity = lockIdentity(verify.record);
    const removable = inspected !== null
      ? verifyIdentity === inspected
      : verifyIdentity === null && verify.stat.dev === current.stat.dev && verify.stat.ino === current.stat.ino;
    if (!removable) return false;
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
  beforeOpen,
  // Test-only seam: fires inside reclaimIfStale's reclaim window (after the
  // stale decision + dev/ino check, before the identity-verified unlink) so a
  // test can inject a replacement owner at the exact race point. No-op in
  // production -- the sole real caller never passes it.
  __reclaimRaceHook
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
      if (await reclaimIfStale(path, { staleMs, maxStaleMs }, __reclaimRaceHook)) continue;
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
