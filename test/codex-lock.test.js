import { test } from "node:test";
import assert from "node:assert/strict";
import { lstat, mkdtemp, mkdir, readFile, rename, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withCodexFileLock } from "../src/codex-lock.js";

test("Codex retirement accepts mode-unavailable filesystems only with stable directory identity", async t => {
  const tmp = await mkdtemp(join(tmpdir(), "muster-codex-mode-unavailable-"));
  t.after(() => rm(tmp, { recursive: true, force: true }));
  let probes = 0;
  const modeCapability = async ({ dir, stat }) => {
    probes++;
    assert.equal(stat.isDirectory(), true);
    assert.match(dir, /\.muster-retired-/);
    return false;
  };
  await withCodexFileLock(join(tmp, "stable.lock"), async () => {}, { modeCapability });
  assert.equal(probes, 1);

  const replacementLock = join(tmp, "replaced.lock");
  await assert.rejects(withCodexFileLock(replacementLock, async () => {}, {
    modeCapability,
    afterRetirement: async state => {
      await rename(state.dir, `${state.dir}.replacement`);
      await mkdir(state.dir, { mode: 0o777 });
    }
  }), /retirement directory/i);
});

test("shared Codex lock acquisition rolls back a failed record write", async t => {
  const tmp = await mkdtemp(join(tmpdir(), "muster-codex-lock-write-failure-"));
  t.after(() => rm(tmp, { recursive: true, force: true }));
  const path = join(tmp, "partial.lock");
  await assert.rejects(withCodexFileLock(path, async () => {}, {
    recordPolicy: {
      create: () => ({ value: 1n }),
      parse: JSON.parse,
      sameOwner: () => false
    }
  }), /BigInt|serializ/i);
  await assert.rejects(lstat(path), error => error.code === "ENOENT");
});

test("shared Codex lock acquisition retires a genuinely partial record write", async t => {
  const tmp = await mkdtemp(join(tmpdir(), "muster-codex-lock-partial-write-"));
  t.after(() => rm(tmp, { recursive: true, force: true }));
  const path = join(tmp, "partial.lock");
  await assert.rejects(withCodexFileLock(path, async () => {}, {
    afterRecordWrite: async ({ handle }) => {
      await handle.truncate(7);
      throw new Error("injected partial write failure");
    }
  }), /injected partial write failure/);
  await assert.rejects(lstat(path), error => error.code === "ENOENT");
});

test("shared Codex lock ignored missing release preserves callback completion", async t => {
  const tmp = await mkdtemp(join(tmpdir(), "muster-codex-lock-missing-release-"));
  t.after(() => rm(tmp, { recursive: true, force: true }));
  const valuePath = join(tmp, "value.lock");
  assert.equal(await withCodexFileLock(valuePath, async () => {
    await unlink(valuePath);
    return "callback-value";
  }), "callback-value");

  const errorPath = join(tmp, "error.lock");
  await assert.rejects(withCodexFileLock(errorPath, async () => {
    await unlink(errorPath);
    throw new Error("callback failure");
  }), /callback failure/);
});

test("shared Codex lock acquisition never enters after pathname replacement", async t => {
  const tmp = await mkdtemp(join(tmpdir(), "muster-codex-lock-publish-race-"));
  t.after(() => rm(tmp, { recursive: true, force: true }));
  const path = join(tmp, "publish.lock"), displaced = join(tmp, "displaced.lock");
  const replacement = '{"token":"replacement"}\n';
  let entered = false;
  await assert.rejects(withCodexFileLock(path, async () => { entered = true; }, {
    afterWrite: async () => {
      await rename(path, displaced);
      await writeFile(path, replacement);
    },
    retryPolicy: { maxAttempts: 1, delayMs: 0 }
  }), /timed out/i);
  assert.equal(entered, false);
  assert.equal(await readFile(path, "utf8"), replacement);
  assert.match(await readFile(displaced, "utf8"), /"token"/);
});

test("shared Codex lock write rollback preserves a replacement pathname", async t => {
  const tmp = await mkdtemp(join(tmpdir(), "muster-codex-lock-rollback-race-"));
  t.after(() => rm(tmp, { recursive: true, force: true }));
  const path = join(tmp, "rollback.lock"), displaced = join(tmp, "displaced.lock");
  const replacement = '{"token":"replacement"}\n';
  await assert.rejects(withCodexFileLock(path, async () => {}, {
    afterWrite: async () => {
      await rename(path, displaced);
      await writeFile(path, replacement);
      throw new Error("injected write completion failure");
    }
  }), /injected write completion failure/);
  assert.equal(await readFile(path, "utf8"), replacement);
  assert.match(await readFile(displaced, "utf8"), /"token"/);
});

test("codex-install delegates lock mechanics to the shared lifecycle", async () => {
  const source = await readFile(new URL("../src/codex-install.js", import.meta.url), "utf8");
  assert.doesNotMatch(source, /\b(?:privateScopeRetirement|retireOwnedScopeLock|restoreQuarantinedScopeLock|readScopeLock|writeExclusiveSafe|sameScopeLockInode)\b/);
  assert.doesNotMatch(source, /\.muster-reclaim-|from "node:crypto";.*randomUUID/s);
  assert.match(source, /withCodexFileLock\(scopeRegistryLockPath/);
});
