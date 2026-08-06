// Failure-injection coverage for codex-install-marketplace.js's plugin-cache
// publish/rollback/verify lifecycle (2026-08-04 coverage audit): every
// runCodexInstall test passes a mocked execFile, and codex-install.js gates
// the plugin-cache path behind `ctx.identity && !ctx.execFile`, so these five
// "concurrent state was preserved" defensive branches (publishStagedPluginCache,
// rollbackPublishedPluginCache, verifyPublishedPluginCache,
// copyPluginCacheExclusively) had zero reachable coverage. This file drives
// them directly with the new pluginCacheOptions test seam -- named hooks
// (afterExclusiveCopy/beforeRetire/beforeRollbackVerify/beforeRollbackRetire/
// beforeVerify) fired at the exact window between a snapshot and its
// re-verification, mirroring codex-install-scope-lock.js's proven
// afterAcquire/afterQuarantine/afterValidation/afterRetirement/beforeRelease
// pattern (see test/codex-install-scopes.test.js:238-424). Hooks are
// production-inert when omitted: every call site defaults pluginCacheOptions
// to `{}` and invokes each hook with `?.()`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { cp, mkdir, readdir, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assertPrivatePluginCache, copyPluginCacheExclusively, publishStagedPluginCache,
  rollbackPublishedPluginCache, verifyPublishedPluginCache
} from "../src/codex-install-marketplace.js";
import { trackedMkdtemp as mkdtemp } from "../test-support/helpers.js";

// A minimal private plugin cache fixture: just enough for assertPrivatePluginCache's
// identity check (manifest version + inputDigest shape, plugin.json name/version).
// sourceRoot/sourceTree stay null in every direct call below, so the heavier
// trusted-projection check (assertTrustedPluginCacheProjection) never engages --
// this file is about the concurrency-preserved branches, not that projection.
async function writePluginCache(root, version, files = {}) {
  await mkdir(join(root, ".codex-plugin"), { recursive: true });
  await writeFile(join(root, "package.json"), JSON.stringify({ version, inputDigest: "a".repeat(64) }));
  await writeFile(join(root, ".codex-plugin", "plugin.json"), JSON.stringify({ name: "muster", version }));
  for (const [name, content] of Object.entries(files)) await writeFile(join(root, name), content);
}

// Simulates a concurrent writer that replaces a directory with a byte-identical
// clone: same tree/content, but a fresh dev/ino identity -- the inode-substitution
// race that samePluginCacheSnapshot's dev/ino comparison (as opposed to a bare
// content/tree comparison) exists to catch. A plain "add an extra file" mutation
// cannot exercise the two branches (copyPluginCacheExclusively, verifyPublishedPluginCache)
// that pass exactTree: a content-only mutation trips assertPrivatePluginCache's own
// "differs from its exact staged receipt" check first, before the dev/ino compare
// under test ever runs.
async function swapDirectoryIdentity(path) {
  const staging = `${path}.identity-swap-${process.pid}-${Math.random().toString(36).slice(2)}`;
  await cp(path, staging, { recursive: true });
  await rm(path, { recursive: true, force: true });
  await rename(staging, path);
}

test("copyPluginCacheExclusively detects a concurrent writer that swaps the target's identity before the final verification (branch A)", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "muster-plugin-cache-copy-race-"));
  const source = join(tmp, "source"), target = join(tmp, "target");
  await mkdir(source, { recursive: true });
  await writePluginCache(source, "1.0.0");
  const expectedTree = await assertPrivatePluginCache(source, "1.0.0");

  await assert.rejects(
    copyPluginCacheExclusively(source, target, expectedTree, "1.0.0", {
      afterExclusiveCopy: async ({ target: copiedTarget }) => { await swapDirectoryIdentity(copiedTarget); }
    }),
    /Codex plugin cache changed during exclusive publication/
  );
});

test("publishStagedPluginCache detects a concurrent writer that mutates the live target before retirement (branch B)", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "muster-plugin-cache-publish-race-"));
  const staged = join(tmp, "staged"), liveCodexHome = join(tmp, "home");
  await mkdir(staged, { recursive: true });
  // note.txt makes the staged tree diverge from the existing target's tree, so
  // publishStagedPluginCache takes the retire-then-copy path instead of its
  // "reused: true" early return (which would never reach the retirement window).
  await writePluginCache(staged, "2.0.0", { "note.txt": "staged-generation" });
  const target = join(liveCodexHome, "plugins", "cache", "muster", "muster", "2.0.0");
  await mkdir(target, { recursive: true });
  await writePluginCache(target, "2.0.0");

  await assert.rejects(
    publishStagedPluginCache(staged, liveCodexHome, "2.0.0", null, null, {
      beforeRetire: async ({ target: liveTarget }) => { await writeFile(join(liveTarget, "intruder.txt"), "race"); }
    }),
    /Codex plugin cache changed before retirement.*concurrent state was preserved/
  );
});

test("rollbackPublishedPluginCache detects a concurrent writer that mutates the published target before rollback (branch C)", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "muster-plugin-cache-rollback-verify-race-"));
  const staged = join(tmp, "staged"), liveCodexHome = join(tmp, "home");
  await mkdir(staged, { recursive: true });
  await writePluginCache(staged, "3.0.0");
  const receipt = await publishStagedPluginCache(staged, liveCodexHome, "3.0.0", null, null);

  await assert.rejects(
    rollbackPublishedPluginCache(receipt, {
      beforeRollbackVerify: async ({ receipt: current }) => { await writeFile(join(current.target, "intruder.txt"), "race"); }
    }),
    /Codex plugin cache changed before rollback.*concurrent state was preserved/
  );
});

test("rollbackPublishedPluginCache detects a concurrent writer that mutates the target during its own retirement rename (branch D)", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "muster-plugin-cache-rollback-retire-race-"));
  const staged = join(tmp, "staged"), liveCodexHome = join(tmp, "home");
  await mkdir(staged, { recursive: true });
  await writePluginCache(staged, "4.0.0");
  const receipt = await publishStagedPluginCache(staged, liveCodexHome, "4.0.0", null, null);

  await assert.rejects(
    rollbackPublishedPluginCache(receipt, {
      beforeRollbackRetire: async ({ receipt: current }) => { await writeFile(join(current.target, "intruder.txt"), "race"); }
    }),
    /Codex plugin cache changed during rollback.*concurrent state was preserved/
  );
});

test("verifyPublishedPluginCache detects a concurrent writer that swaps the published target's identity before the install commit point (branch E)", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "muster-plugin-cache-verify-race-"));
  const staged = join(tmp, "staged"), liveCodexHome = join(tmp, "home");
  await mkdir(staged, { recursive: true });
  await writePluginCache(staged, "5.0.0");
  const receipt = await publishStagedPluginCache(staged, liveCodexHome, "5.0.0", null, null);

  await assert.rejects(
    verifyPublishedPluginCache(receipt, {
      beforeVerify: async ({ receipt: current }) => { await swapDirectoryIdentity(current.target); }
    }),
    /Codex plugin cache changed before the install commit point.*concurrent state was preserved/
  );
});

test("plugin-cache lifecycle hooks are production-inert when pluginCacheOptions is omitted", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "muster-plugin-cache-hooks-inert-"));
  const staged = join(tmp, "staged"), liveCodexHome = join(tmp, "home");
  await mkdir(staged, { recursive: true });
  await writePluginCache(staged, "6.0.0");

  const receipt = await publishStagedPluginCache(staged, liveCodexHome, "6.0.0", null, null);
  assert.equal(receipt.reused, false);
  await verifyPublishedPluginCache(receipt);
  await rollbackPublishedPluginCache(receipt);
  const survivors = await readdir(join(liveCodexHome, "plugins", "cache", "muster", "muster"));
  assert.ok(survivors.length >= 1, "rollback retains the failed generation path-addressable instead of deleting it");
});
