import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withCodexFileLock } from "../src/codex-lock.js";

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
  await writeFile(lock, JSON.stringify({ format: 1, pid: 2_147_483_647, createdAt: 0, token: "dead" }) + "\n");
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

test("withCodexFileLock's simplified surface no longer invokes the removed quarantine/retirement hooks", async t => {
  const tmp = await mkdtemp(join(tmpdir(), "muster-codex-lock-no-hooks-"));
  t.after(() => rm(tmp, { recursive: true, force: true }));
  const lock = join(tmp, "hooks.lock");
  let retirementCalled = false, quarantineCalled = false, modeCapabilityCalled = false;
  await withCodexFileLock(lock, async () => {}, {
    afterRetirement: () => { retirementCalled = true; },
    afterQuarantine: () => { quarantineCalled = true; },
    afterValidation: () => { quarantineCalled = true; },
    beforeRelease: () => { retirementCalled = true; },
    modeCapability: () => { modeCapabilityCalled = true; return true; }
  });
  assert.equal(retirementCalled, false, "the retirement dance was removed; its hooks must be inert");
  assert.equal(quarantineCalled, false, "the quarantine dance was removed; its hooks must be inert");
  assert.equal(modeCapabilityCalled, false, "there is no retirement directory left to probe a mode capability for");
});
