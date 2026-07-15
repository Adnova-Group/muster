import { randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { link, lstat, mkdir, open, readFile, rename, rmdir, unlink, utimes } from "node:fs/promises";
import { dirname, join } from "node:path";

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const sameInode = (left, right) => left.dev === right.dev && left.ino === right.ino;

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

const defaultRecordPolicy = {
  async create({ token, pid, processIdentity, createdAt }) {
    return { format: 1, pid, processIdentity, createdAt, token };
  },
  parse(text) {
    // Malformed transaction records remain fail-closed: they are never eligible
    // for stale reclaim because their owner cannot be bound safely.
    try { return JSON.parse(text); } catch { return null; }
  },
  sameOwner(left, right) {
    return typeof left?.token === "string" && left.token.length > 0
      && left.token === right?.token && left.pid === right?.pid
      && left.processIdentity === right?.processIdentity && left.createdAt === right?.createdAt;
  }
};

const defaultStalePolicy = {
  age({ stat, now }) { return now - stat.mtimeMs; },
  softExpiryMs: 60_000,
  hardExpiryMs: 15 * 60_000
};

const defaultRetryPolicy = {
  timeoutMs: 30_000,
  delay({ elapsedMs }) { return Math.min(25, 5 + Math.floor(elapsedMs / 100)); }
};

const defaultReleasePolicy = { missing: "ignore", changed: "ignore" };

function defaultModeCapability({ stat }) {
  // A newly created 0700 directory reported as 0777 means the containing
  // filesystem normalized requested POSIX mode bits (for example DrvFS).
  return (stat.mode & 0o777) !== 0o777;
}

function normalizedOptions(options) {
  const stalePolicy = options.stalePolicy || {
    ...defaultStalePolicy,
    softExpiryMs: options.staleMs ?? defaultStalePolicy.softExpiryMs,
    hardExpiryMs: options.maxStaleMs ?? defaultStalePolicy.hardExpiryMs
  };
  const retryPolicy = options.retryPolicy || {
    ...defaultRetryPolicy,
    timeoutMs: options.timeoutMs ?? defaultRetryPolicy.timeoutMs
  };
  return {
    recordPolicy: options.recordPolicy || defaultRecordPolicy,
    pathPolicy: options.pathPolicy || null,
    stalePolicy,
    recoveryPolicy: options.recoveryPolicy || null,
    retryPolicy,
    releasePolicy: options.releasePolicy || defaultReleasePolicy,
    heartbeat: Object.hasOwn(options, "heartbeat") ? options.heartbeat : {
      intervalMs: Math.max(1_000, Math.floor(stalePolicy.softExpiryMs / 3))
    },
    maxBytes: options.maxBytes ?? 16 * 1024,
    diagnostics: {
      unsafe: path => `unsafe Codex transaction lock: ${path}`,
      retirement: path => `unsafe Codex transaction retirement directory: ${path}`,
      retirementCreate: path => `could not create Codex transaction retirement directory for ${path}`,
      modeCapability: dir => `invalid Codex retirement mode capability for ${dir}`,
      restore: path => `Codex transaction lock restore changed identity: ${path}`,
      ownership: path => `Codex transaction lock ownership changed: ${path}`,
      unavailable: path => `timed out waiting for Codex transaction lock: ${path}`,
      ...options.diagnostics
    },
    raceHooks: {
      afterRecordWrite: options.afterRecordWrite || (async () => {}),
      afterWrite: options.afterWrite || (async () => {}),
      afterQuarantine: options.afterQuarantine || (async () => {}),
      afterValidation: options.afterValidation || (async () => {}),
      afterRetirement: options.afterRetirement || (async () => {}),
      beforeRelease: options.beforeRelease || (async () => {}),
      ...options.raceHooks
    },
    modeCapability: options.modeCapability || defaultModeCapability
  };
}

async function prepare(policy, path, context) {
  if (policy?.prepare) await policy.prepare(path, context);
}

async function readLock(path, policy, kind = "lock") {
  await prepare(policy.pathPolicy, path, { operation: "read", kind });
  for (let attempt = 0; attempt < 8; attempt++) {
    let handle;
    try {
      const before = await lstat(path);
      if (before.isSymbolicLink() || !before.isFile() || before.size > policy.maxBytes) throw new Error(policy.diagnostics.unsafe(path));
      handle = await open(path, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW || 0));
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > policy.maxBytes) throw new Error(policy.diagnostics.unsafe(path));
      if (!sameInode(before, stat)) {
        if (attempt < 7) continue;
        const error = new Error(`Codex lock changed while reading: ${path}`);
        error.code = "EAGAIN";
        throw error;
      }
      return { record: policy.recordPolicy.parse(await handle.readFile("utf8"), { path }), stat };
    } finally { if (handle) await handle.close().catch(() => {}); }
  }
}

async function writeExclusive(path, token, policy, kind = "lock") {
  await prepare(policy.pathPolicy, path, { operation: "create", kind });
  const record = await policy.recordPolicy.create({ token, pid: process.pid, processIdentity: await processStartIdentity(), createdAt: Date.now(), path });
  const text = JSON.stringify(record) + "\n";
  let handle, createdStat, writeComplete = false;
  try {
    handle = await open(path, "wx", 0o600);
    createdStat = await handle.stat();
    await handle.writeFile(text, "utf8");
    await policy.raceHooks.afterRecordWrite({ path, handle });
    await handle.sync();
    writeComplete = true;
    await handle.close();
    handle = null;
    await policy.raceHooks.afterWrite({ path });
    const published = await readLock(path, policy, "published-lock");
    if (!sameInode(published.stat, createdStat) || !policy.recordPolicy.sameOwner(published.record, record)) {
      const error = new Error(policy.diagnostics.ownership(path));
      error.code = "EAGAIN";
      throw error;
    }
    return record;
  } catch (error) {
    if (handle) await handle.close().catch(() => {});
    if (createdStat) await retireCreated(path, createdStat, text, policy, { requireExpectedText: writeComplete });
    throw error;
  }
}

async function stale(state, policy) {
  const age = policy.stalePolicy.age({ ...state, now: Date.now() });
  if (age < policy.stalePolicy.softExpiryMs) return false;
  const pid = Number(state.record?.pid), alive = processAlive(pid);
  if (!alive) return true;
  const recorded = typeof state.record?.processIdentity === "string" ? state.record.processIdentity : null;
  const actual = await processStartIdentity(pid);
  if (recorded && actual && recorded !== actual) return true;
  return age >= policy.stalePolicy.hardExpiryMs;
}

async function assertPrivateRetirementDirectory(dir, retirement, policy) {
  await prepare(policy.pathPolicy, dir, { operation: "verify", kind: "retirement-directory" });
  const stat = await lstat(dir), uid = typeof process.getuid === "function" ? process.getuid() : null;
  const ownerMismatch = process.platform !== "win32" && typeof uid === "number" && stat.uid !== uid;
  const unsafeMode = retirement.requirePrivateMode && process.platform !== "win32"
    && ((stat.mode & 0o700) !== 0o700 || (stat.mode & 0o077) !== 0);
  if (stat.isSymbolicLink() || !stat.isDirectory() || ownerMismatch
    || stat.uid !== retirement.expectedStat.uid || !sameInode(stat, retirement.expectedStat) || unsafeMode) {
    throw new Error(policy.diagnostics.retirement(dir));
  }
  return stat;
}

async function privateRetirement(path, policy) {
  for (let attempt = 0; attempt < 8; attempt++) {
    const dir = join(dirname(path), `.muster-retired-${process.pid}-${randomUUID()}`);
    await prepare(policy.pathPolicy, dir, { operation: "create", kind: "retirement-directory" });
    try { await mkdir(dir, { mode: 0o700 }); }
    catch (error) { if (error.code === "EEXIST" && attempt < 7) continue; throw error; }
    const stat = await lstat(dir), requirePrivateMode = await policy.modeCapability({ dir, stat });
    if (typeof requirePrivateMode !== "boolean") throw new Error(policy.diagnostics.modeCapability(dir));
    const retirement = { dir, path: join(dir, "lock"), expectedStat: stat, requirePrivateMode };
    await assertPrivateRetirementDirectory(dir, retirement, policy);
    return retirement;
  }
  throw new Error(policy.diagnostics.retirementCreate(path));
}

async function removeRetirement(retirement, policy) {
  await assertPrivateRetirementDirectory(retirement.dir, retirement, policy);
  await rmdir(retirement.dir);
}

async function retireCreated(path, expectedStat, expectedText, policy, { requireExpectedText }) {
  let current;
  try { current = await lstat(path); } catch (error) { if (error.code === "ENOENT") return false; throw error; }
  if (!sameInode(current, expectedStat)) return false;
  const retirement = await privateRetirement(path, policy);
  try { await rename(path, retirement.path); }
  catch (error) {
    try { await removeRetirement(retirement, policy); } catch { /* preserve ambiguous state */ }
    if (error.code === "ENOENT") return false;
    throw error;
  }
  await assertPrivateRetirementDirectory(retirement.dir, retirement, policy);
  const movedStat = await lstat(retirement.path);
  if (!sameInode(movedStat, expectedStat)
    || (requireExpectedText && await readFile(retirement.path, "utf8") !== expectedText)) {
    await restoreRetired(path, retirement, movedStat, policy);
    return false;
  }
  await unlink(retirement.path);
  await removeRetirement(retirement, policy);
  return true;
}

async function restoreRetired(path, retirement, stat, policy) {
  await assertPrivateRetirementDirectory(retirement.dir, retirement, policy);
  const current = await lstat(retirement.path);
  if (!sameInode(current, stat)) return false;
  await prepare(policy.pathPolicy, path, { operation: "restore", kind: "lock" });
  try { await link(retirement.path, path); }
  catch (error) { if (error.code === "EEXIST") return false; throw error; }
  if (!sameInode(await lstat(path), stat)) throw new Error(policy.diagnostics.restore(path));
  await assertPrivateRetirementDirectory(retirement.dir, retirement, policy);
  await unlink(retirement.path);
  await removeRetirement(retirement, policy);
  return true;
}

async function restoreQuarantined(path, quarantine, stat, policy) {
  const retirement = await privateRetirement(quarantine, policy);
  try { await rename(quarantine, retirement.path); }
  catch (error) {
    try { await removeRetirement(retirement, policy); } catch { /* preserve ambiguous state */ }
    if (error.code === "ENOENT") return false;
    throw error;
  }
  return restoreRetired(path, retirement, stat, policy);
}

async function retireOwned(path, expectedStat, expectedRecord, policy, { restorePath = path, requireStale = false } = {}) {
  let current;
  try { current = await readLock(path, policy, "retirement-source"); } catch (error) { if (error.code === "ENOENT") return false; throw error; }
  if (!sameInode(current.stat, expectedStat) || !policy.recordPolicy.sameOwner(current.record, expectedRecord)) return false;
  const retirement = await privateRetirement(path, policy);
  try { await rename(path, retirement.path); }
  catch (error) {
    try { await removeRetirement(retirement, policy); } catch { /* preserve ambiguous state */ }
    if (error.code === "ENOENT") return false;
    throw error;
  }
  await policy.raceHooks.afterRetirement({ dir: retirement.dir, path: retirement.path, sourcePath: path });
  await assertPrivateRetirementDirectory(retirement.dir, retirement, policy);
  let retired;
  try { retired = await readLock(retirement.path, policy, "retired-lock"); } catch { return false; }
  if (!sameInode(retired.stat, expectedStat) || !policy.recordPolicy.sameOwner(retired.record, expectedRecord)) return false;
  if (requireStale && !await stale(retired, policy)) {
    await restoreRetired(restorePath, retirement, expectedStat, policy);
    return false;
  }
  await assertPrivateRetirementDirectory(retirement.dir, retirement, policy);
  const final = await readLock(retirement.path, policy, "retired-lock");
  if (!sameInode(final.stat, expectedStat) || !policy.recordPolicy.sameOwner(final.record, expectedRecord)) return false;
  await unlink(retirement.path);
  await removeRetirement(retirement, policy);
  return true;
}

async function reclaimWithoutSentinel(path, policy) {
  let current;
  try { current = await readLock(path, policy); }
  catch (error) { if (error.code === "ENOENT") return true; throw error; }
  if (!policy.recordPolicy.sameOwner(current.record, current.record) || !await stale(current, policy)) return false;
  const quarantine = `${path}.muster-reclaim-${process.pid}-${randomUUID()}`;
  await prepare(policy.pathPolicy, quarantine, { operation: "quarantine", kind: "quarantine" });
  try { await rename(path, quarantine); } catch (error) { if (error.code === "ENOENT") return true; throw error; }
  await policy.raceHooks.afterQuarantine({ path, quarantine });
  const quarantined = await readLock(quarantine, policy, "quarantine");
  if (!sameInode(quarantined.stat, current.stat) || !policy.recordPolicy.sameOwner(quarantined.record, current.record) || !await stale(quarantined, policy)) {
    await restoreQuarantined(path, quarantine, quarantined.stat, policy);
    return false;
  }
  await policy.raceHooks.afterValidation({ path, quarantine });
  let finalCandidate;
  try { finalCandidate = await readLock(quarantine, policy, "quarantine"); } catch { return false; }
  if (!sameInode(finalCandidate.stat, quarantined.stat)
    || !policy.recordPolicy.sameOwner(finalCandidate.record, quarantined.record) || !await stale(finalCandidate, policy)) {
    await restoreQuarantined(path, quarantine, finalCandidate.stat, policy);
    return false;
  }
  return retireOwned(quarantine, finalCandidate.stat, finalCandidate.record, policy, { restorePath: path, requireStale: true });
}

async function reclaim(path, policy) {
  if (!policy.recoveryPolicy) return reclaimWithoutSentinel(path, policy);
  const recoveryPath = policy.recoveryPolicy.path(path);
  const sentinelPolicy = {
    ...policy,
    recoveryPolicy: null,
    retryPolicy: { maxAttempts: 2, delayMs: 0 },
    raceHooks: {
      afterRecordWrite: async () => {},
      afterWrite: async () => {},
      afterQuarantine: async () => {},
      afterValidation: async () => {},
      afterRetirement: policy.raceHooks.afterRetirement,
      beforeRelease: async () => {}
    }
  };
  try {
    return await runLocked(recoveryPath, async () => reclaimWithoutSentinel(path, policy), sentinelPolicy);
  } catch (error) {
    if (error.code === "CODEX_LOCK_UNAVAILABLE") return false;
    throw error;
  }
}

function retryExhausted(retryPolicy, attempt, elapsedMs) {
  if (Number.isInteger(retryPolicy.maxAttempts)) return attempt >= retryPolicy.maxAttempts;
  return elapsedMs >= retryPolicy.timeoutMs;
}

async function runLocked(path, callback, policy) {
  const token = randomUUID(), started = Date.now();
  let ownedRecord, attempt = 0;
  for (;;) {
    attempt++;
    try { ownedRecord = await writeExclusive(path, token, policy); break; }
    catch (error) {
      if (error.code !== "EEXIST" && error.code !== "EAGAIN") throw error;
      if (error.code === "EEXIST") {
        try { await reclaim(path, policy); }
        catch (reclaimError) { if (reclaimError.code !== "EAGAIN") throw reclaimError; }
      }
      const elapsedMs = Date.now() - started;
      if (retryExhausted(policy.retryPolicy, attempt, elapsedMs)) {
        const unavailable = new Error(policy.diagnostics.unavailable(path));
        unavailable.code = "CODEX_LOCK_UNAVAILABLE";
        throw unavailable;
      }
      const delay = typeof policy.retryPolicy.delay === "function"
        ? policy.retryPolicy.delay({ attempt, elapsedMs }) : policy.retryPolicy.delayMs;
      await pause(delay ?? 0);
    }
  }

  const heartbeat = policy.heartbeat && setInterval(async () => {
    try {
      const current = await readLock(path, policy);
      if (policy.recordPolicy.sameOwner(current.record, ownedRecord)) await utimes(path, new Date(), new Date());
    } catch { /* release/recovery owns diagnostics */ }
  }, policy.heartbeat?.intervalMs);
  if (heartbeat) heartbeat.unref();
  try { return await callback(); }
  finally {
    if (heartbeat) clearInterval(heartbeat);
    let current;
    try { current = await readLock(path, policy); }
    catch (error) {
      if (error.code !== "ENOENT" || policy.releasePolicy.missing !== "ignore") throw error;
    }
    if (current && !policy.recordPolicy.sameOwner(current.record, ownedRecord)) {
      if (policy.releasePolicy.changed !== "ignore") throw new Error(policy.diagnostics.ownership(path));
      current = null;
    }
    if (current) {
      await policy.raceHooks.beforeRelease({ path });
      if (!await retireOwned(path, current.stat, current.record, policy)) throw new Error(policy.diagnostics.ownership(path));
    }
  }
}

export async function withCodexFileLock(path, callback, options = {}) {
  return runLocked(path, callback, normalizedOptions(options));
}
