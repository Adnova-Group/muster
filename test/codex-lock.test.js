import { test } from "node:test";
import assert from "node:assert/strict";
import { lstat, mkdir, mkdtemp, open, readFile, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { processStartIdentity, withCodexFileLock } from "../src/codex-lock.js";

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const deadOwner = token => ({
  format: 1,
  pid: 2_147_483_647,
  processIdentity: "linux-proc-start:dead",
  createdAt: 1,
  token
});

// codex-lock.js dropped its quarantine/retirement dance (rename a contested
// lock into a private per-attempt directory, re-validate identity, then
// delete) in favor of a single create-or-fail lockfile: reclaim a stale lock
// with a direct unlink-then-retry, and release an owned lock with a direct
// unlink after an ownership check. These tests assert the resulting surface.

test("withCodexFileLock serializes concurrent holders and removes the lock file once released", async t => {
  const tmp = await mkdtemp(join(tmpdir(), "muster-codex-lock-serialize-"));
  t.after(() => rm(tmp, { recursive: true, force: true }));
  const lock = join(tmp, "a.lock");
  let inside = 0, overlapped = false, runs = 0;
  const holder = async () => {
    inside++;
    runs++;
    if (inside > 1) overlapped = true;
    await new Promise(resolve => setTimeout(resolve, 30));
    inside--;
  };
  await Promise.all([withCodexFileLock(lock, holder), withCodexFileLock(lock, holder)]);
  assert.equal(runs, 2, "both holders must eventually run");
  assert.equal(overlapped, false, "two holders ran inside the lock at the same time");
  await assert.rejects(readFile(lock, "utf8"), "lock file must not remain after release");
});

test("withCodexFileLock reclaims a lock abandoned by a dead process", async t => {
  const tmp = await mkdtemp(join(tmpdir(), "muster-codex-lock-dead-"));
  t.after(() => rm(tmp, { recursive: true, force: true }));
  const lock = join(tmp, "dead.lock");
  await writeFile(lock, JSON.stringify(deadOwner("dead")) + "\n");
  const old = new Date(Date.now() - 20 * 60 * 1000);
  await utimes(lock, old, old);
  let ran = false;
  await withCodexFileLock(lock, async () => { ran = true; }, { staleMs: 1_000, maxStaleMs: 5_000 });
  assert.equal(ran, true, "the callback must run once the dead owner's lock is reclaimed");
  await assert.rejects(readFile(lock, "utf8"), "the reclaimed lock must be released after use");
});

test("withCodexFileLock times out on a live, fresh lock without ever touching it", async t => {
  const tmp = await mkdtemp(join(tmpdir(), "muster-codex-lock-live-"));
  t.after(() => rm(tmp, { recursive: true, force: true }));
  const lock = join(tmp, "live.lock");
  const owner = { format: 1, pid: process.pid, createdAt: Date.now(), token: "live-owner" };
  await writeFile(lock, JSON.stringify(owner) + "\n");
  await assert.rejects(
    withCodexFileLock(lock, async () => { throw new Error("callback must not run while the lock is live"); }, { timeoutMs: 50 }),
    /timed out waiting for Codex transaction lock/
  );
  assert.deepEqual(JSON.parse(await readFile(lock, "utf8")), owner, "a contended live lock must be left untouched");
});

test("withCodexFileLock never reclaims an exact live owner solely because maxStaleMs elapsed", async t => {
  const identity = await processStartIdentity();
  if (!identity) return t.skip("requires process-start identity support");
  const tmp = await mkdtemp(join(tmpdir(), "muster-codex-lock-live-expired-"));
  t.after(() => rm(tmp, { recursive: true, force: true }));
  const lock = join(tmp, "live-expired.lock");
  const owner = {
    format: 1,
    pid: process.pid,
    processIdentity: identity,
    createdAt: 1,
    token: "exact-live-expired-owner"
  };
  await writeFile(lock, JSON.stringify(owner) + "\n");
  const old = new Date(Date.now() - 60_000);
  await utimes(lock, old, old);

  await assert.rejects(
    withCodexFileLock(lock, async () => assert.fail("exact live owner must remain gated"), {
      staleMs: 1,
      maxStaleMs: 2,
      timeoutMs: 30
    }),
    /timed out waiting/
  );
  assert.deepEqual(JSON.parse(await readFile(lock, "utf8")), owner);
});

// codex-release.js's residual (i): the `.build.lock` is created by
// open(path,"wx") before any in-lock canonical re-check can fire, so an
// ancestor swapped in the realpath-capture -> lock-open window materializes the
// lock through the symlink. The `beforeOpen` hook fires synchronously ahead of
// each create attempt; a throwing guard aborts acquisition before the open.

test("withCodexFileLock runs beforeOpen before creating the lock, and a throwing beforeOpen prevents the lock file and the callback", async t => {
  const tmp = await mkdtemp(join(tmpdir(), "muster-codex-lock-guard-"));
  t.after(() => rm(tmp, { recursive: true, force: true }));
  const lock = join(tmp, "guard.lock");
  let guardCalls = 0, ranCallback = false;
  await assert.rejects(
    withCodexFileLock(lock, async () => { ranCallback = true; }, {
      beforeOpen: () => { guardCalls++; throw new Error("pre-open guard rejected acquisition"); }
    }),
    /pre-open guard rejected acquisition/
  );
  assert.equal(guardCalls, 1, "beforeOpen must fire before the lock is created");
  assert.equal(ranCallback, false, "a rejected beforeOpen must prevent the callback from running");
  await assert.rejects(readFile(lock, "utf8"), "a rejected beforeOpen must leave no lock file behind");
});

test("withCodexFileLock invokes beforeOpen ahead of a clean lock acquisition", async t => {
  const tmp = await mkdtemp(join(tmpdir(), "muster-codex-lock-guard-ok-"));
  t.after(() => rm(tmp, { recursive: true, force: true }));
  const lock = join(tmp, "guard-ok.lock");
  const order = [];
  await withCodexFileLock(lock, async () => { order.push("callback"); }, {
    beforeOpen: () => { order.push("beforeOpen"); }
  });
  assert.deepEqual(order, ["beforeOpen", "callback"], "beforeOpen must run before the callback on a clean acquisition");
});

test("withCodexFileLock retains the portable path implementation off Linux", async t => {
  const tmp = await mkdtemp(join(tmpdir(), "muster-codex-lock-portable-"));
  t.after(() => rm(tmp, { recursive: true, force: true }));
  const lock = join(tmp, "portable.lock");
  let entered = false;
  await withCodexFileLock(lock, () => { entered = true; }, { __platform: "darwin" });
  assert.equal(entered, true);
  await assert.rejects(lstat(lock), /ENOENT/);
});

test("withCodexFileLock runs the ancestry guard before acquisition-artifact reconciliation", async t => {
  const tmp = await mkdtemp(join(tmpdir(), "muster-codex-lock-guard-reconcile-"));
  t.after(() => rm(tmp, { recursive: true, force: true }));
  const trusted = join(tmp, "trusted"), outside = join(tmp, "outside");
  await mkdir(join(outside, "nested"), { recursive: true });
  await mkdir(trusted);
  await symlink(outside, join(trusted, "redirect"));
  const lock = join(trusted, "redirect", "nested", "guarded.lock");
  const artifact = join(outside, "nested", "guarded.lock.acquire-planted");
  await writeFile(artifact, JSON.stringify(deadOwner("planted")) + "\n");
  let guardCalled = false;
  await assert.rejects(withCodexFileLock(lock, () => assert.fail("guarded callback must not run"), {
    beforeOpen: () => { guardCalled = true; throw new Error("rejected untrusted ancestry"); }
  }), /rejected untrusted ancestry/);
  assert.equal(guardCalled, true);
  assert.deepEqual(JSON.parse(await readFile(artifact, "utf8")), deadOwner("planted"));
});

// The identity gap in stale reclamation: reclaimer A decides a lock is stale and
// passes its dev/ino check, but BEFORE A unlinks, another process B reclaims the
// same stale instance and becomes the legitimate new owner. unlink-by-path removes
// whatever is at `path` NOW -- so A would delete B's replacement lock, letting A's
// and B's publish callbacks run concurrently. The reclaim must re-read the lock as
// its last gate and unlink ONLY the exact owner identity it decided was dead. The
// `__reclaimRaceHook` seam fires at that exact window (after A's dev/ino check,
// before A's unlink), so the identity re-check -- NOT the earlier dev/ino guard --
// is the sole thing that can protect B here. Two replacement topologies are driven:
// a fresh inode (unlink + create) and a reused inode (in-place overwrite, which the
// dev/ino guard cannot distinguish from the original at all).
async function driveReplacementOwnerRace(t, label, replaceAsOwnerB) {
  const tmp = await mkdtemp(join(tmpdir(), `muster-codex-lock-race-${label}-`));
  t.after(() => rm(tmp, { recursive: true, force: true }));
  const lock = join(tmp, "race.lock");

  // A stale lock abandoned by a dead process: reclaimer A will decide it is stale.
  await writeFile(lock, JSON.stringify(deadOwner("stale-A")) + "\n");
  const old = new Date(Date.now() - 20 * 60 * 1000);
  await utimes(lock, old, old);

  // Mutual-exclusion witness shared by both "publish callbacks".
  let inside = 0, overlapped = false;
  const enter = () => { inside++; if (inside > 1) overlapped = true; };
  const exit = () => { inside--; };

  // Replacement owner B reclaims the stale instance A just inspected and writes its
  // own fresh, non-stale lock, then starts "running its publish callback" (holds
  // the lock) across A's reclaim attempt. Injected at the exact reclaim window.
  const bToken = "fresh-B";
  let replaced = false;
  const raceWindow = async () => {
    if (replaced) return;
    replaced = true;
    await replaceAsOwnerB(lock, JSON.stringify({ format: 1, pid: process.pid, processIdentity: null, createdAt: Date.now(), token: bToken }) + "\n");
    enter(); // B's publish callback is now running under its fresh lock.
  };

  // Reclaimer A. Its callback is A's publish callback; it must NOT run while B holds the lock.
  let aRan = false, aError = null;
  try {
    await withCodexFileLock(lock, async () => { aRan = true; enter(); await pause(10); exit(); }, {
      staleMs: 1_000, maxStaleMs: 5_000, timeoutMs: 150,
      __reclaimRaceHook: raceWindow
    });
  } catch (error) { aError = error; }

  assert.equal(replaced, true, "the reclaim-window seam must actually fire (B replaced the stale lock)");

  // (a) B's replacement lock must be intact -- A must not have unlinked it.
  let surviving = null;
  try { surviving = JSON.parse(await readFile(lock, "utf8")); } catch { surviving = null; }
  assert.equal(surviving?.token, bToken, "reclaimer A must not unlink the replacement owner's lock");

  // (b) the two publish callbacks must never overlap; A must lose the race cleanly.
  assert.equal(overlapped, false, "reclaimer A's callback overlapped the replacement owner's callback");
  assert.equal(aRan, false, "reclaimer A must lose the race cleanly rather than run its callback under B's lock");
  assert.ok(aError && /timed out waiting for Codex transaction lock/.test(aError.message), "reclaimer A should time out against B's fresh lock");
}

test("withCodexFileLock never unlinks a replacement owner's lock reclaimed with a FRESH inode in the race window (unlink + create)", async t => {
  await driveReplacementOwnerRace(t, "fresh-inode", async (lock, content) => {
    await rm(lock, { force: true });          // B removes the stale instance A inspected...
    await writeFile(lock, content);           // ...and creates its own lock (a new inode).
  });
});

test("withCodexFileLock never unlinks a replacement owner's lock reclaimed with a REUSED inode in the race window (in-place overwrite the dev/ino guard cannot detect)", async t => {
  await driveReplacementOwnerRace(t, "reused-inode", async (lock, content) => {
    await writeFile(lock, content);           // B's fresh identity lands on the SAME inode; only identity re-check catches it.
  });
});

test("withCodexFileLock restores a quarantined replacement whose paused writer completes its record", async t => {
  const tmp = await mkdtemp(join(tmpdir(), "muster-codex-lock-paused-writer-"));
  t.after(() => rm(tmp, { recursive: true, force: true }));
  const lock = join(tmp, "paused.lock");
  await writeFile(lock, JSON.stringify(deadOwner("dead")) + "\n");
  const old = new Date(Date.now() - 20 * 60 * 1000);
  await utimes(lock, old, old);

  const replacement = { format: 1, pid: process.pid, processIdentity: null, createdAt: Date.now(), token: "paused-owner" };
  let writer;
  let replacementInode;
  let replacementRunning = false;
  let reclaimerRan = false;
  let thirdRan = false;
  let thirdOutcome;
  try {
    await assert.rejects(withCodexFileLock(lock, async () => { reclaimerRan = true; }, {
      staleMs: 1_000,
      maxStaleMs: 5_000,
      timeoutMs: 50,
      __reclaimRaceHook: async () => {
        await rm(lock, { force: true });
        writer = await open(lock, "wx", 0o600);
        await writer.write('{"format":1', 0, "utf8");
        replacementRunning = true;
      },
      __beforeRestoreHook: async ({ retirementPath }) => {
        replacementInode = (await lstat(retirementPath)).ino;
        await writer.truncate(0);
        await writer.write(JSON.stringify(replacement) + "\n", 0, "utf8");
        await writer.sync();
        thirdOutcome = withCodexFileLock(lock, async () => { thirdRan = true; }, { timeoutMs: 25 })
          .then(() => null, error => error);
        await pause(35);
        assert.equal(thirdRan, false, "a third holder must remain gated while the live replacement is quarantined");
      }
    }), /timed out waiting for Codex transaction lock/);

    assert.deepEqual(JSON.parse(await readFile(lock, "utf8")), replacement, "the completed replacement must be restored at the public lock path");
    assert.equal((await lstat(lock)).ino, replacementInode, "restoration must preserve the quarantined writer's stable inode");
    assert.match((await thirdOutcome)?.message || "", /timed out waiting/, "the gated third holder must time out against the restored replacement");
  } finally {
    await writer?.close();
  }

  assert.equal(replacementRunning, true, "the replacement publisher must be active during restoration");
  assert.equal(reclaimerRan, false, "the reclaimer must not overlap the paused replacement publisher");
  assert.equal(thirdRan, false, "a third holder must not enter through a stranded public-path gap");
});

test("withCodexFileLock keeps the restore gate closed while an exact pre-gate acquirer remains paused", async t => {
  const tmp = await mkdtemp(join(tmpdir(), "muster-codex-lock-long-restore-"));
  t.after(() => rm(tmp, { recursive: true, force: true }));
  const lock = join(tmp, "long-restore.lock");
  await writeFile(lock, JSON.stringify(deadOwner("dead")) + "\n");
  const old = new Date(Date.now() - 20 * 60 * 1000);
  await utimes(lock, old, old);

  let releasePreOpen;
  const preOpenBlocked = new Promise(resolve => { releasePreOpen = resolve; });
  let preOpenReachedResolve;
  const preOpenReached = new Promise(resolve => { preOpenReachedResolve = resolve; });
  let releaseAfterWrite;
  const afterWriteBlocked = new Promise(resolve => { releaseAfterWrite = resolve; });
  let afterWriteReachedResolve;
  const afterWriteReached = new Promise(resolve => { afterWriteReachedResolve = resolve; });
  let thirdOutcome;
  let thirdRan = false;
  let overlapped = false;
  let replacementRunning = false;
  let writer;

  try {
    const reclaimer = withCodexFileLock(lock, async () => {
      if (replacementRunning) overlapped = true;
    }, {
      staleMs: 1_000,
      maxStaleMs: 5_000,
      timeoutMs: 350,
      __reclaimRaceHook: async () => {
        await rm(lock, { force: true });
        writer = await open(lock, "wx", 0o600);
        await writer.write('{"format":1', 0, "utf8");
        replacementRunning = true;
        thirdOutcome = withCodexFileLock(lock, async () => {
          thirdRan = true;
          if (replacementRunning) overlapped = true;
        }, {
          timeoutMs: 300,
          beforeOpen: async () => {
            preOpenReachedResolve();
            await preOpenBlocked;
          },
          __afterAcquireWriteHook: async () => {
            afterWriteReachedResolve();
            await afterWriteBlocked;
          }
        }).then(() => null, error => error);
        await preOpenReached;
      },
      __beforeRestoreHook: async () => {
        await writer.truncate(0);
        await writer.write(JSON.stringify({
          format: 1,
          pid: process.pid,
          processIdentity: null,
          createdAt: Date.now(),
          token: "long-paused-owner"
        }) + "\n", 0, "utf8");
        await writer.sync();
        releasePreOpen();
        await Promise.race([
          afterWriteReached,
          pause(250).then(() => { throw new Error("post-write acquisition seam did not fire"); })
        ]);
        setTimeout(releaseAfterWrite, 175);
      }
    }).then(() => null, error => error);

    const reclaimerError = await reclaimer;
    assert.match(reclaimerError?.message || "", /timed out waiting/);
    assert.match((await thirdOutcome)?.message || "", /timed out waiting/);
  } finally {
    releasePreOpen?.();
    releaseAfterWrite?.();
    await writer?.close();
  }

  assert.equal(thirdRan, false, "the exact pre-gate acquirer must withdraw instead of publishing");
  assert.equal(overlapped, false, "no callback may overlap the live quarantined replacement");
});

test("withCodexFileLock reclaims only a proven-dead transition gate", async t => {
  const tmp = await mkdtemp(join(tmpdir(), "muster-codex-lock-dead-transition-"));
  t.after(() => rm(tmp, { recursive: true, force: true }));
  const lock = join(tmp, "dead-transition.lock");
  const gate = `${lock}.muster-transition`;
  await writeFile(gate, JSON.stringify({
    format: 1,
    pid: 2_147_483_647,
    processIdentity: "linux-proc-start:dead",
    createdAt: 0,
    token: "dead-transition"
  }) + "\n", { mode: 0o600 });
  const gateInode = (await lstat(gate)).ino;

  let ran = false;
  await withCodexFileLock(lock, async () => { ran = true; }, { timeoutMs: 40 });

  assert.equal(ran, true);
  await assert.rejects(lstat(gate), /ENOENT/);
  assert.ok(gateInode > 0, "the stale gate fixture must have a stable inode identity");
});

test("withCodexFileLock reclaims a dead transition whose official process identity is unavailable", async t => {
  const tmp = await mkdtemp(join(tmpdir(), "muster-codex-lock-null-identity-dead-transition-"));
  t.after(() => rm(tmp, { recursive: true, force: true }));
  const lock = join(tmp, "null-identity-dead-transition.lock");
  const gate = `${lock}.muster-transition`;
  await writeFile(gate, JSON.stringify({
    format: 1,
    pid: 2_147_483_647,
    processIdentity: null,
    createdAt: 1,
    token: "null-identity-dead-transition"
  }) + "\n", { mode: 0o600 });

  let ran = false;
  await withCodexFileLock(lock, async () => { ran = true; }, { timeoutMs: 40 });

  assert.equal(ran, true);
  await assert.rejects(lstat(gate), /ENOENT/);
});

test("withCodexFileLock keeps a live transition fail-closed when process identity is unavailable", async t => {
  const tmp = await mkdtemp(join(tmpdir(), "muster-codex-lock-null-identity-live-transition-"));
  t.after(() => rm(tmp, { recursive: true, force: true }));
  const lock = join(tmp, "null-identity-live-transition.lock");
  const gate = `${lock}.muster-transition`;
  const owner = {
    format: 1,
    pid: process.pid,
    processIdentity: null,
    createdAt: 1,
    token: "null-identity-live-transition"
  };
  await writeFile(gate, JSON.stringify(owner) + "\n", { mode: 0o600 });

  await assert.rejects(
    withCodexFileLock(lock, async () => assert.fail("live null-identity gate must remain closed"), { timeoutMs: 30 }),
    /timed out waiting/
  );
  assert.deepEqual(JSON.parse(await readFile(gate, "utf8")), owner);
});

test("withCodexFileLock never treats a token-only transition record as dead", async t => {
  const tmp = await mkdtemp(join(tmpdir(), "muster-codex-lock-partial-transition-"));
  t.after(() => rm(tmp, { recursive: true, force: true }));
  const lock = join(tmp, "partial-transition.lock");
  const gate = `${lock}.muster-transition`;
  const partial = { format: 1, token: "token-only" };
  await writeFile(gate, JSON.stringify(partial) + "\n", { mode: 0o600 });

  await assert.rejects(
    withCodexFileLock(lock, async () => assert.fail("partial gate must remain closed"), { timeoutMs: 30 }),
    /timed out waiting/
  );
  assert.deepEqual(JSON.parse(await readFile(gate, "utf8")), partial);
});

test("withCodexFileLock never treats a transition missing process identity as dead", async t => {
  const tmp = await mkdtemp(join(tmpdir(), "muster-codex-lock-partial-owner-transition-"));
  t.after(() => rm(tmp, { recursive: true, force: true }));
  const lock = join(tmp, "partial-owner-transition.lock");
  const gate = `${lock}.muster-transition`;
  const partial = {
    format: 1,
    pid: 2_147_483_647,
    createdAt: 1,
    token: "missing-process-identity"
  };
  await writeFile(gate, JSON.stringify(partial) + "\n", { mode: 0o600 });

  await assert.rejects(
    withCodexFileLock(lock, async () => assert.fail("partial owner gate must remain closed"), { timeoutMs: 30 }),
    /timed out waiting/
  );
  assert.deepEqual(JSON.parse(await readFile(gate, "utf8")), partial);
});

test("withCodexFileLock recovers malformed transition JSON through exact-instance retirement", async t => {
  const tmp = await mkdtemp(join(tmpdir(), "muster-codex-lock-malformed-transition-"));
  t.after(() => rm(tmp, { recursive: true, force: true }));
  const lock = join(tmp, "malformed-transition.lock");
  const gate = `${lock}.muster-transition`;
  await writeFile(gate, '{"format":1,"pid":', { mode: 0o600 });
  const malformedInode = (await lstat(gate)).ino;

  let ran = false;
  await withCodexFileLock(lock, async () => { ran = true; }, { timeoutMs: 40 });

  assert.equal(ran, true);
  await assert.rejects(lstat(gate), /ENOENT/);
  assert.ok(malformedInode > 0);
});

test("withCodexFileLock keeps an exact live transition owner gated regardless of age", async t => {
  const identity = await processStartIdentity();
  if (!identity) return t.skip("requires process-start identity support");
  const tmp = await mkdtemp(join(tmpdir(), "muster-codex-lock-live-transition-"));
  t.after(() => rm(tmp, { recursive: true, force: true }));
  const lock = join(tmp, "live-transition.lock");
  const gate = `${lock}.muster-transition`;
  const owner = {
    format: 1,
    pid: process.pid,
    processIdentity: identity,
    createdAt: 1,
    token: "exact-live-transition"
  };
  await writeFile(gate, JSON.stringify(owner) + "\n", { mode: 0o600 });
  const old = new Date(Date.now() - 24 * 60 * 60 * 1000);
  await utimes(gate, old, old);

  await assert.rejects(
    withCodexFileLock(lock, async () => assert.fail("live transition must remain closed"), { timeoutMs: 30 }),
    /timed out waiting/
  );
  assert.deepEqual(JSON.parse(await readFile(gate, "utf8")), owner);
});

async function driveRestoreBlockerRecovery(t, label, blockerRecord) {
  const tmp = await mkdtemp(join(tmpdir(), `muster-codex-lock-restore-${label}-`));
  t.after(() => rm(tmp, { recursive: true, force: true }));
  const lock = join(tmp, "restore.lock");
  await writeFile(lock, JSON.stringify(deadOwner("original-dead")) + "\n");
  const old = new Date(Date.now() - 20 * 60 * 1000);
  await utimes(lock, old, old);

  let releaseBeforeOpen;
  const beforeOpenBlocked = new Promise(resolve => { releaseBeforeOpen = resolve; });
  let beforeOpenReachedResolve;
  const beforeOpenReached = new Promise(resolve => { beforeOpenReachedResolve = resolve; });
  let blockerOutcome;
  let blockerRan = false;
  let raceInjected = false;

  const reclaimer = withCodexFileLock(lock, async () => {}, {
    staleMs: 0,
    maxStaleMs: 5_000,
    timeoutMs: 500,
    __reclaimRaceHook: async () => {
      if (raceInjected) return;
      raceInjected = true;
      await rm(lock, { force: true });
      await writeFile(lock, '{"format":1');
      blockerOutcome = withCodexFileLock(lock, async () => { blockerRan = true; }, {
        timeoutMs: 200,
        beforeOpen: async () => {
          beforeOpenReachedResolve();
          await beforeOpenBlocked;
        },
        __afterAcquireWriteHook: async () => {
          await writeFile(lock, JSON.stringify(blockerRecord) + "\n");
          throw new Error("simulated owner death after lock write");
        }
      }).then(() => null, error => error);
      await beforeOpenReached;
    },
    __beforeRestoreHook: async ({ retirementPath }) => {
      await writeFile(retirementPath, JSON.stringify(deadOwner("completed-original")) + "\n");
      releaseBeforeOpen();
      await pause(20);
    }
  });

  await reclaimer;
  assert.match((await blockerOutcome)?.message || "", /simulated owner death/);
  assert.equal(blockerRan, false);
  await assert.rejects(lstat(lock), /ENOENT/);
}

test("withCodexFileLock restore reclaims a pre-gate acquirer proven dead after writing", async t => {
  await driveRestoreBlockerRecovery(t, "dead-after-write", deadOwner("dead-after-write"));
});

test("withCodexFileLock restore reclaims a pre-gate acquirer whose PID was reused", async t => {
  const identity = await processStartIdentity();
  if (!identity) return t.skip("requires process-start identity support");
  await driveRestoreBlockerRecovery(t, "pid-reuse", {
    format: 1,
    pid: process.pid,
    processIdentity: `${identity}-different-instance`,
    createdAt: Date.now(),
    token: "pid-reused-after-write"
  });
});

test("withCodexFileLock stale reclaim cannot unlink a replacement injected after final owner validation", async t => {
  const tmp = await mkdtemp(join(tmpdir(), "muster-codex-lock-final-reclaim-race-"));
  t.after(() => rm(tmp, { recursive: true, force: true }));
  const lock = join(tmp, "reclaim.lock");
  await writeFile(lock, JSON.stringify(deadOwner("dead")) + "\n");
  const old = new Date(Date.now() - 20 * 60 * 1000);
  await utimes(lock, old, old);

  const replacement = { format: 1, pid: process.pid, createdAt: Date.now(), token: "fresh-after-validation" };
  let injected = false;
  await assert.rejects(withCodexFileLock(lock, async () => {
    assert.fail("a reclaimer must not enter while the injected replacement owns the lock");
  }, {
    staleMs: 1_000,
    maxStaleMs: 5_000,
    timeoutMs: 50,
    __afterReclaimValidationHook: async ({ path }) => {
      if (injected) return;
      injected = true;
      await rm(path, { force: true });
      await writeFile(path, JSON.stringify(replacement) + "\n", { flag: "wx" });
    }
  }), /timed out waiting for Codex transaction lock/);

  assert.equal(injected, true, "the final-validation race seam must fire");
  assert.deepEqual(JSON.parse(await readFile(lock, "utf8")), replacement);
});

test("withCodexFileLock release cannot unlink a replacement injected after final owner validation", async t => {
  const tmp = await mkdtemp(join(tmpdir(), "muster-codex-lock-final-release-race-"));
  t.after(() => rm(tmp, { recursive: true, force: true }));
  const lock = join(tmp, "release.lock");
  const replacement = { format: 1, pid: process.pid, createdAt: Date.now(), token: "fresh-release-owner" };
  let injected = false;

  await withCodexFileLock(lock, async () => {}, {
    __afterReleaseValidationHook: async ({ path }) => {
      injected = true;
      await rm(path, { force: true });
      await writeFile(path, JSON.stringify(replacement) + "\n", { flag: "wx" });
    }
  });

  assert.equal(injected, true, "the final-release-validation race seam must fire");
  assert.deepEqual(JSON.parse(await readFile(lock, "utf8")), replacement);
});
