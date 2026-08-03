import { randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { link, lstat, mkdir, open, readFile, readdir, rename, rmdir, unlink, utimes } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

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
// (token) + the lock's start time (createdAt) + the process start identity
// (explicitly null where the platform cannot provide one). Each acquire writes
// a fresh token, so this string uniquely names one lock instance.
// A replacement owner that reclaimed after a prior reclaimer's staleness decision
// always writes its own identity, so it can never byte-match the stale instance.
function lockIdentity(record) {
  if (!record || typeof record !== "object" || Array.isArray(record)) return null;
  const { pid, token, createdAt, processIdentity } = record;
  if (record.format !== 1
    || !Number.isInteger(pid) || pid < 1
    || typeof token !== "string" || !token
    || !Number.isFinite(createdAt) || createdAt < 0
    || !Object.hasOwn(record, "processIdentity")
    || (processIdentity !== null && (typeof processIdentity !== "string" || !processIdentity))) return null;
  return JSON.stringify({ pid, token, createdAt, processIdentity });
}

const sameInode = (left, right) => left.dev === right.dev && left.ino === right.ino;
const transitionPath = path => `${path}.muster-transition`;

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

async function restoreRetiredLock(path, retirement, expected, waitForVacancy = false) {
  await assertPrivateRetirementDirectory(retirement.dir);
  let current;
  try { current = await lstat(retirement.path); }
  catch (error) { if (error.code === "ENOENT") return false; throw error; }
  // Restoration is non-destructive: bind it to the stable quarantined inode,
  // not mutable record bytes. A legitimate replacement owner can still be
  // finishing its initial write while a stale reclaimer moves that inode.
  if (!sameInode(current, expected.stat)) return false;
  for (;;) {
    try { await link(retirement.path, path); break; }
    catch (error) {
      // An acquirer that passed its pre-open gate check just before this
      // transition began can briefly own the public pathname. Its post-open
      // check removes that uncommitted lock; keep the transition closed until
      // the quarantined inode is back in place.
      if (error.code === "EEXIST" && waitForVacancy) {
        // A pre-gate acquirer can die after publishing its complete record but
        // before observing the transition marker. Reclaim only when that exact
        // inode carries a complete owner identity whose process is proven gone
        // (or whose PID now names a different process instance).
        let blocker;
        try { blocker = await readLock(path); }
        catch (readError) {
          if (readError.code === "ENOENT") continue;
          throw readError;
        }
        if (await ownerInstanceIsGone(blocker)) {
          const result = await retireLockUnderTransition(path, blocker, {
            stale: ownerInstanceIsGone
          });
          if (result.removed || result.missing) continue;
        }
        await pause(1);
        continue;
      }
      if (error.code === "EEXIST") return false;
      throw error;
    }
  }
  const restored = await lstat(path);
  if (!sameInode(restored, expected.stat)) throw new Error(`Codex transaction lock restore changed identity: ${path}`);
  await removeRetirement(retirement);
  return true;
}

async function restoreOrRequireReplacement(path, retirement, expected, waitForVacancy = false) {
  if (await restoreRetiredLock(path, retirement, expected, waitForVacancy)) return;
  try { await lstat(path); }
  catch (error) {
    if (error.code === "ENOENT") {
      throw new Error(`Codex transaction lock could not be restored after ownership changed: ${path}`);
    }
    throw error;
  }
}

async function lockIsStale(current, { staleMs }) {
  const age = Date.now() - current.stat.mtimeMs;
  if (age < staleMs) return false;
  const pid = Number(current.record?.pid);
  const alive = processAlive(pid);
  if (!alive) return true;
  const recordedIdentity = typeof current.record?.processIdentity === "string"
    ? current.record.processIdentity
    : null;
  const actualIdentity = recordedIdentity ? await processStartIdentity(pid) : null;
  // Time alone never overrides positive liveness. Reclaim a live PID only when
  // both sides provide process-start identity and prove that the PID was reused.
  if (!recordedIdentity || !actualIdentity) return false;
  return recordedIdentity !== actualIdentity;
}

async function retireLockUnderTransition(path, expected, {
  restorePath = path,
  stale,
  afterValidation,
  beforeRestore,
  waitForRestoreVacancy = false
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
    await restoreOrRequireReplacement(restorePath, retirement, retired, waitForRestoreVacancy);
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
    await restoreOrRequireReplacement(restorePath, retirement, final, waitForRestoreVacancy);
    return { removed: false, missing: false };
  }
  await removeRetirement(retirement);
  return { removed: true, missing: false };
}

async function ownerInstanceIsGone(current) {
  if (!lockIdentity(current.record)) return false;
  const pid = current.record.pid;
  if (!processAlive(pid)) return true;
  if (current.record.processIdentity === null) return false;
  const actualIdentity = await processStartIdentity(pid);
  return Boolean(actualIdentity && current.record.processIdentity !== actualIdentity);
}

async function reconcileAcquisitionTemps(path) {
  const parent = dirname(path);
  const prefix = `${basename(path)}.acquire-`;
  let names;
  try { names = await readdir(parent); }
  catch (error) { if (error.code === "ENOENT") return; throw error; }
  for (const name of names.filter(candidate => candidate.startsWith(prefix)).sort()) {
    const temporary = join(parent, name);
    let current;
    try { current = await readLock(temporary); }
    catch (error) { if (error.code === "ENOENT") continue; throw error; }
    let ownerGone = await ownerInstanceIsGone(current);
    if (!lockIdentity(current.record)) {
      const encodedOwner = name.slice(prefix.length, name.lastIndexOf("."));
      try {
        const [pidText, namedIdentity] = Buffer.from(encodedOwner, "base64url").toString("utf8").split("\0");
        const pid = Number(pidText);
        if (Number.isInteger(pid) && pid > 0) {
          ownerGone = !processAlive(pid);
          if (!ownerGone && namedIdentity) {
            const actualIdentity = await processStartIdentity(pid);
            ownerGone = Boolean(actualIdentity && actualIdentity !== namedIdentity);
          }
        }
      } catch { /* malformed foreign artifacts remain fail-closed */ }
    }
    if (!ownerGone) continue;
    await retireLock(temporary, current, { stale: () => true });
  }
}

async function retirePrivateAcquisition(path, expected) {
  const retirement = await privateRetirement(path);
  try {
    await rename(path, retirement.path);
  } catch (error) {
    await removeRetirement(retirement).catch(() => {});
    if (error.code === "ENOENT") return { removed: false, missing: true };
    throw error;
  }
  const moved = await readLock(retirement.path);
  if (!sameLock(moved, expected)) {
    await restoreOrRequireReplacement(path, retirement, moved, false);
    return { removed: false, missing: false };
  }
  await removeRetirement(retirement);
  return { removed: true, missing: false };
}

async function transitionGateIsRecoverable(current) {
  // publishTransition exposes only a fully written staging inode. Invalid JSON
  // therefore cannot be an in-progress gate from this implementation. Still
  // quarantine and re-read that exact inode twice: an external paused writer
  // that completes after the rename is restored instead of deleted.
  if (current.record === null || typeof current.record !== "object" || Array.isArray(current.record)) return true;
  return ownerInstanceIsGone(current);
}

async function clearStaleTransition(path, current) {
  if (!await transitionGateIsRecoverable(current)) return false;
  const result = await retireLockUnderTransition(transitionPath(path), current, {
    stale: transitionGateIsRecoverable
  });
  return result.removed || result.missing;
}

async function transitionIsActive(path, beforeMutation) {
  let current;
  try { current = await readLock(transitionPath(path)); }
  catch (error) { if (error.code === "ENOENT") return false; throw error; }
  if (await transitionGateIsRecoverable(current) && beforeMutation) await beforeMutation();
  return !await clearStaleTransition(path, current);
}

async function publishTransition(path, record) {
  const gate = transitionPath(path);
  const staging = await privateRetirement(gate);
  let handle;
  try {
    handle = await open(staging.path, "wx", 0o600);
    await handle.writeFile(JSON.stringify(record) + "\n", "utf8");
    await handle.sync();
    await handle.close();
    handle = null;
    const expected = await readLock(staging.path);
    try { await link(staging.path, gate); }
    catch (error) {
      if (error.code !== "EEXIST") throw error;
      await removeRetirement(staging);
      return null;
    }
    const published = await readLock(gate);
    if (!sameLock(published, expected)) throw new Error(`Codex transaction transition changed identity: ${gate}`);
    await removeRetirement(staging);
    return published;
  } catch (error) {
    if (handle) await handle.close().catch(() => {});
    throw error;
  }
}

async function beginTransition(path) {
  const processIdentity = await processStartIdentity();
  const started = Date.now();
  for (;;) {
    const gate = await publishTransition(path, {
      format: 1,
      pid: process.pid,
      processIdentity,
      createdAt: Date.now(),
      token: randomUUID()
    });
    if (gate) return gate;
    if (!await transitionIsActive(path)) continue;
    if (Date.now() - started >= 30_000) {
      throw new Error(`timed out waiting for Codex transaction lock transition: ${path}`);
    }
    await pause(5);
  }
}

async function retireLock(path, expected, options = {}) {
  const gate = await beginTransition(path);
  try {
    return await retireLockUnderTransition(path, expected, {
      ...options,
      waitForRestoreVacancy: true
    });
  } finally {
    const result = await retireLockUnderTransition(transitionPath(path), gate);
    if (!result.removed && !result.missing) {
      throw new Error(`Codex transaction lock transition ownership changed: ${transitionPath(path)}`);
    }
  }
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

export async function withCodexFileLock(path, callback, options = {}) {
  const platform = options.__platform ?? process.platform;
  if (platform !== "linux" || !fsConstants.O_NOFOLLOW) {
    return withPinnedCodexFileLock(path, callback, options);
  }
  const parentPath = dirname(path);
  const parent = await open(parentPath, fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW);
  try {
    const parentInfo = await parent.stat();
    const namedParentInfo = await lstat(parentPath);
    if (!sameInode(parentInfo, namedParentInfo) || !parentInfo.isDirectory()) {
      throw new Error(`Codex transaction lock parent changed: ${parentPath}`);
    }
    const assertPinnedParent = async () => {
      const current = await lstat(parentPath);
      if (!sameInode(parentInfo, current) || !current.isDirectory()) {
        throw new Error(`Codex transaction lock parent changed: ${parentPath}`);
      }
    };
    const releaseGuard = async () => {
      await assertPinnedParent();
      if (options.releaseGuard) await options.releaseGuard();
    };
    const acquireGuard = async () => {
      if (options.beforeOpen) await options.beforeOpen();
      await assertPinnedParent();
    };
    return await withPinnedCodexFileLock(
      join("/proc/self/fd", String(parent.fd), basename(path)),
      callback,
      { ...options, beforeOpen: acquireGuard, releaseGuard, __parentIdentityGuard: assertPinnedParent }
    );
  } finally {
    await parent.close();
  }
}

async function withPinnedCodexFileLock(path, callback, {
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
  __beforeRestoreHook,
  __afterAcquireWriteHook,
  __afterAcquireOpenHook,
  __beforeAcquirePublishHook,
  __beforeAcquireCleanupHook,
  __parentIdentityGuard
} = {}) {
  const token = randomUUID();
  const processIdentity = await processStartIdentity();
  const acquisitionOwner = Buffer.from(`${process.pid}\0${processIdentity ?? ""}`).toString("base64url");
  const started = Date.now();
  let acquisitionsReconciled = false;
  for (;;) {
    if (await transitionIsActive(path, beforeOpen)) {
      if (Date.now() - started >= timeoutMs) throw new Error(`timed out waiting for Codex transaction lock: ${path}`);
      await pause(Math.min(25, 5 + Math.floor((Date.now() - started) / 100)));
      continue;
    }
    // Optional caller guard fired synchronously before EACH create attempt (a
    // contended lock retries, and the guarded condition — e.g. a symlinked
    // ancestor swapped under `path` — can change between attempts). A throw
    // here aborts acquisition before open(path,"wx") can create the lock file
    // through a swapped ancestor into an attacker's target (codex-release.js's
    // residual (i)). O_CREAT|O_EXCL ("wx") itself does not guard ancestors.
    if (beforeOpen) await beforeOpen();
    if (!acquisitionsReconciled) {
      await reconcileAcquisitionTemps(path);
      acquisitionsReconciled = true;
    }
    let handle;
    let acquisitionPath;
    let acquisitionExpected;
    let published = false;
    try {
      acquisitionPath = join(dirname(path), `${basename(path)}.acquire-${acquisitionOwner}.${token}`);
      handle = await open(acquisitionPath, "wx", 0o600);
      acquisitionExpected = { record: null, stat: await handle.stat() };
      if (__afterAcquireOpenHook) await __afterAcquireOpenHook({ path, acquisitionPath });
      await handle.writeFile(JSON.stringify({ format: 1, pid: process.pid, processIdentity, createdAt: Date.now(), token }) + "\n", "utf8");
      await handle.sync();
      await handle.close();
      handle = null;
      acquisitionExpected = await readLock(acquisitionPath);
      if (__beforeAcquirePublishHook) await __beforeAcquirePublishHook({ path, acquisitionPath });
      await link(acquisitionPath, path);
      published = true;
      if (__beforeAcquireCleanupHook) await __beforeAcquireCleanupHook({ path, acquisitionPath });
      const acquisitionCleanup = await retirePrivateAcquisition(acquisitionPath, acquisitionExpected);
      if (!acquisitionCleanup.removed && !acquisitionCleanup.missing) {
        throw new Error(`Codex transaction lock acquisition stage changed: ${acquisitionPath}`);
      }
      acquisitionPath = null;
      if (__afterAcquireWriteHook) await __afterAcquireWriteHook();
      if (__parentIdentityGuard) await __parentIdentityGuard();
      if (await transitionIsActive(path)) {
        // The transition marker appeared after our pre-open check. Withdraw
        // this not-yet-published owner through the same quarantine + identity
        // validation used by ordinary release; the transition holder keeps
        // its marker until the quarantined replacement is restored.
        const current = await readLock(path);
        if (current.record?.token !== token) throw new Error(`Codex transaction lock ownership changed: ${path}`);
        const result = await retireLockUnderTransition(path, current, { waitForRestoreVacancy: true });
        if (!result.removed && !result.missing) throw new Error(`Codex transaction lock ownership changed: ${path}`);
        published = false;
        continue;
      }
      break;
    } catch (error) {
      if (handle) await handle.close().catch(() => {});
      const cleanupErrors = [];
      if (published) {
        try {
          const current = await readLock(path);
          if (current.record?.token === token) {
            const result = await retireLock(path, current);
            if (!result.removed && !result.missing) cleanupErrors.push(new Error(`Codex transaction lock ownership changed: ${path}`));
          }
        } catch (cleanupError) {
          if (cleanupError.code !== "ENOENT") cleanupErrors.push(cleanupError);
        }
      }
      if (acquisitionPath && acquisitionExpected) {
        try {
          const result = await retirePrivateAcquisition(acquisitionPath, acquisitionExpected);
          if (!result.removed && !result.missing) cleanupErrors.push(new Error(`Codex transaction lock acquisition stage changed: ${acquisitionPath}`));
        } catch (cleanupError) {
          if (cleanupError.code !== "ENOENT") cleanupErrors.push(cleanupError);
        }
      }
      if (cleanupErrors.length) throw new AggregateError([error, ...cleanupErrors], `Codex transaction lock acquisition cleanup failed: ${path}`);
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
    let guardError = null;
    try { if (releaseGuard) await releaseGuard(); }
    catch (error) { guardError = error; }
    let releaseError = null;
    try {
      const current = await readLock(path);
      if (current.record?.token === token) {
        const result = await retireLock(path, current, {
          afterValidation: __afterReleaseValidationHook
        });
        if (!result.removed && !result.missing) {
          throw new Error(`Codex transaction lock ownership changed: ${path}`);
        }
      }
    } catch (error) { if (error.code !== "ENOENT") releaseError = error; }
    if (guardError && releaseError) {
      throw new AggregateError([guardError, releaseError], `Codex transaction lock release failed: ${path}`);
    }
    if (guardError) throw guardError;
    if (releaseError) throw releaseError;
  }
}
