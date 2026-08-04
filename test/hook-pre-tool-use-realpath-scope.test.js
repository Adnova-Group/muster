// test/hook-pre-tool-use-realpath-scope.test.js
//
// Audit S10 (security): the guard-scope check in pre-tool-use.js compared
// path.resolve()d STRING prefixes with no realpath, so an edit target reached
// through an in-tree SYMLINK pointing outside the cwd tree was misclassified
// as in-scope (subject to the action fence and counted as inline drift). The
// hook now realpaths both cwd and target (best-effort, lexical fallback on
// ENOENT) before the prefix tests, so a symlink-escaped target classifies as
// out-of-scope -- allowed, and never counted toward the border invitation.

import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { mkdirSync, writeFileSync, symlinkSync } from "node:fs";
import os from "node:os";
import { cleanDir, editPayload, spawnHook, uniqueSid } from "./test-support/hook-helpers.js";
import { cumFile, readCum } from "../plugin/hooks/inline-budget.js";
import { trackedMkdtempSync as mkdtempSync } from "../test-support/helpers.js";

const HOOK = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "plugin",
  "hooks",
  "pre-tool-use.js",
);

// A working dir with .muster/ present but no run active (border-invitation
// eligibility), plus a symlinked escape hatch to an outside file.
function makeSymlinkFixture() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "muster-realpath-scope-test-"));
  mkdirSync(path.join(dir, ".muster"), { recursive: true });
  const outside = mkdtempSync(path.join(os.tmpdir(), "muster-realpath-outside-test-"));
  const outsideFile = path.join(outside, "secret.txt");
  writeFileSync(outsideFile, "outside the cwd tree\n");
  const link = path.join(dir, "link.txt");
  symlinkSync(outsideFile, link);
  return { dir, outside, outsideFile, link };
}

test("guard-scope: an Edit target reached via an in-tree symlink pointing OUTSIDE cwd is out of scope -- allowed, never counted as inline drift", async () => {
  const { dir, outside, link } = makeSymlinkFixture();
  const sid = uniqueSid("realpath-scope");
  try {
    // Three qualifying touches would cross MUSTER_INLINE_SCALE (default 3) and
    // warn -- IF the target were counted. It must not be: the symlink resolves
    // outside the cwd tree, so the hook is out of scope for it entirely.
    for (let i = 0; i < 3; i++) {
      const { stdout, code } = await spawnHook(HOOK, editPayload(link, dir, { session_id: sid }));
      assert.equal(code, 0);
      const out = JSON.parse(stdout);
      assert.ok(!out.hookSpecificOutput?.additionalContext && !out.additionalContext,
        `call ${i + 1}: no border invitation may fire for an out-of-scope target`);
    }
    const cFile = cumFile(sid);
    assert.equal(readCum(cFile).files.length, 0, "the symlink-escaped target is never recorded in the drift counter");
  } finally {
    cleanDir(dir);
    cleanDir(outside);
  }
});

test("guard-scope (control): a genuinely in-scope Edit target IS still counted -- the realpath change narrows scope only through symlinks", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "muster-realpath-control-test-"));
  mkdirSync(path.join(dir, ".muster"), { recursive: true });
  const inside = path.join(dir, "real.txt");
  writeFileSync(inside, "inside the cwd tree\n");
  const sid = uniqueSid("realpath-control");
  try {
    for (let i = 0; i < 3; i++) {
      // distinct files each call -- the counter keys on distinct paths
      const f = path.join(dir, `real-${i}.txt`);
      writeFileSync(f, "x\n");
      await spawnHook(HOOK, editPayload(f, dir, { session_id: sid }));
    }
    const cFile = cumFile(sid);
    assert.equal(readCum(cFile).files.length, 3, "three distinct in-scope edits are recorded");
  } finally {
    cleanDir(dir);
  }
});
