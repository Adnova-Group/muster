// test/hook-pre-tool-use-e1.test.js
// E1 enforcement-layer tests for pre-tool-use.js:
//   Part A — meta-exempt roots (.muster/ + .claude/)
//   Part B — the wave-guard is gone: a live .muster/wave-active marker (with
//            or without .muster/run-active) has ZERO effect on this hook —
//            it never reads that file at all anymore. These are the field
//            repros named in the acceptance criteria.

import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import os from "node:os";
import { cleanDir, makeMarker, makeRunActive, editPayload, spawnHook, uniqueSid } from "./test-support/hook-helpers.js";

const HOOK = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "plugin",
  "hooks",
  "pre-tool-use.js",
);

function runRaw(stdinText, env = {}) {
  return spawnHook(HOOK, stdinText, env);
}

function clearCum(sessionId) {
  const safe = sessionId.replace(/[^a-zA-Z0-9_-]/g, "");
  try { rmSync(path.join(os.tmpdir(), `muster-cum-${safe}`), { force: true }); } catch { /* ignore */ }
}

function decision(stdout) {
  return JSON.parse(stdout).hookSpecificOutput.permissionDecision;
}

// ── Part A: meta-exempt roots ────────────────────────────────────────────────

test("A: Edit to .claude/settings.local.json in cwd is allowed", async () => {
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), "muster-e1-test-"));
  try {
    const { stdout, code } = await runRaw(editPayload(".claude/settings.local.json", tmpDir));
    assert.equal(code, 0, "exit 0");
    const out = JSON.parse(stdout).hookSpecificOutput;
    assert.equal(out.hookEventName, "PreToolUse");
    assert.equal(out.permissionDecision, undefined, ".claude/ path must be exempt (no permissionDecision)");
  } finally {
    cleanDir(tmpDir);
  }
});

test("A: Edit to absolute .claude/ path inside cwd is allowed", async () => {
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), "muster-e1-test-"));
  try {
    const claudeFile = path.join(tmpDir, ".claude", "AGENTS.md");
    const { stdout, code } = await runRaw(editPayload(claudeFile, tmpDir));
    assert.equal(code, 0);
    const out = JSON.parse(stdout).hookSpecificOutput;
    assert.equal(out.hookEventName, "PreToolUse");
    assert.equal(out.permissionDecision, undefined, "absolute .claude/ path must be exempt");
  } finally {
    cleanDir(tmpDir);
  }
});

test("A: Edit to .muster/ path is allowed", async () => {
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), "muster-e1-test-"));
  try {
    const { stdout, code } = await runRaw(editPayload(".muster/STATE.md", tmpDir));
    assert.equal(code, 0);
    const out = JSON.parse(stdout).hookSpecificOutput;
    assert.equal(out.hookEventName, "PreToolUse");
    assert.equal(out.permissionDecision, undefined, ".muster/ must be exempt");
  } finally {
    cleanDir(tmpDir);
  }
});

// ── Part B: wave-guard is gone — field repros ───────────────────────────────

// Field repro (a): 3 Writes in a fresh session, no .muster/ dir at all -> no deny.
test("field repro (a): 3 Writes, fresh session, no .muster/ dir -> never denied", async () => {
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), "muster-e1-test-"));
  const sid = uniqueSid("e1-repro-a");
  clearCum(sid);
  try {
    const a = await runRaw(editPayload(path.join(tmpDir, "a.js"), tmpDir, { session_id: sid }));
    const b = await runRaw(editPayload(path.join(tmpDir, "b.js"), tmpDir, { session_id: sid }));
    const c = await runRaw(editPayload(path.join(tmpDir, "c.js"), tmpDir, { session_id: sid }));
    assert.notEqual(decision(a.stdout), "deny", "1st Write allowed");
    assert.notEqual(decision(b.stdout), "deny", "2nd Write allowed");
    assert.notEqual(decision(c.stdout), "deny", "3rd Write allowed (may warn, but never denied)");
  } finally {
    clearCum(sid);
    cleanDir(tmpDir);
  }
});

// Field repro (b): 3 Writes with LIVE .muster/wave-active AND .muster/run-active
// markers present -> the (deleted) wave-guard would have denied the 1st Write;
// this hook no longer reads wave-active at all, so all three are allowed.
test("field repro (b): 3 Writes with live wave-active+run-active markers present -> never denied (wave guard gone)", async () => {
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), "muster-e1-test-"));
  makeMarker(tmpDir, "wave-repro-b");
  makeRunActive(tmpDir);
  const sid = uniqueSid("e1-repro-b");
  clearCum(sid);
  try {
    const a = await runRaw(editPayload(path.join(tmpDir, "a.js"), tmpDir, { session_id: sid }));
    const b = await runRaw(editPayload(path.join(tmpDir, "b.js"), tmpDir, { session_id: sid }));
    const c = await runRaw(editPayload(path.join(tmpDir, "c.js"), tmpDir, { session_id: sid }));
    assert.notEqual(decision(a.stdout), "deny", "1st Write allowed despite live wave-active marker");
    assert.notEqual(decision(b.stdout), "deny", "2nd Write allowed");
    assert.notEqual(decision(c.stdout), "deny", "3rd Write allowed");
    // A live run-active present also means the border-invitation counter
    // resets rather than warns (see pre-tool-use-scale tests) — no
    // additionalContext expected here either.
    assert.ok(
      !("additionalContext" in JSON.parse(c.stdout).hookSpecificOutput),
      "a live muster run resets the border counter instead of warning",
    );
  } finally {
    clearCum(sid);
    cleanDir(tmpDir);
  }
});

// A stale wave-active marker (the old STALE_MS orphan concept) is likewise inert.
test("stale wave-active marker (>60min) has no effect — still never denied", async () => {
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), "muster-e1-test-"));
  const stale = new Date(Date.now() - 61 * 60 * 1000);
  makeMarker(tmpDir, "wave-stale", { mtime: stale });
  const sid = uniqueSid("e1-repro-stale");
  clearCum(sid);
  try {
    const { stdout, code } = await runRaw(
      editPayload(path.join(tmpDir, "src", "app.js"), tmpDir, { session_id: sid }),
    );
    assert.equal(code, 0);
    assert.notEqual(decision(stdout), "deny");
  } finally {
    clearCum(sid);
    cleanDir(tmpDir);
  }
});

// B-6 (kept): agent_id always allowed regardless of any marker state.
test("B: agent_id allows even when wave-active present and run-active absent", async () => {
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), "muster-e1-test-"));
  makeMarker(tmpDir, "wave-b6");
  try {
    const { stdout, code } = await runRaw(
      editPayload(path.join(tmpDir, "src", "x.js"), tmpDir, { agent_id: "sub-b6" }),
    );
    assert.equal(code, 0);
    const out = JSON.parse(stdout).hookSpecificOutput;
    assert.equal(out.permissionDecision, undefined, "subagent always allowed");
  } finally {
    cleanDir(tmpDir);
  }
});

// GUARD-SCOPE still holds: a target outside the cwd tree is out of scope.
test("GUARD-SCOPE: Edit to path OUTSIDE cwd is allowed, even with wave-active present", async () => {
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), "muster-e1-test-"));
  makeMarker(tmpDir, "wave-scope-out");
  try {
    const { stdout, code } = await runRaw(editPayload("/home/other/x.md", tmpDir));
    assert.equal(code, 0);
    const out = JSON.parse(stdout).hookSpecificOutput;
    assert.equal(out.permissionDecision, undefined, "outside-cwd Edit is out of scope");
  } finally {
    cleanDir(tmpDir);
  }
});
