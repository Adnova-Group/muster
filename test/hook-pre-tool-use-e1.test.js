// test/hook-pre-tool-use-e1.test.js
// E1 enforcement-layer tests for pre-tool-use.js:
//   Part A — meta-exempt roots (.muster/ + .claude/)
//   Part B — run-active scoping signal for stale-wave detection

import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import os from "node:os";
import { cleanDir, makeMarker, makeRunActive, editPayload, spawnHook } from "./test-support/hook-helpers.js";

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

// Create a fresh wave-active dir (no stale mtime).
function makeFreshWaveDir(waveId = "wave-e1") {
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), "muster-e1-test-"));
  makeMarker(tmpDir, waveId);
  return tmpDir;
}

// Clear the per-session budget file (mirrors scale test helper).
function clearBudget(sessionId) {
  const safe = sessionId.replace(/[^a-zA-Z0-9_-]/g, "");
  try { rmSync(path.join(os.tmpdir(), `muster-inline-${safe}`), { force: true }); } catch { /* ignore */ }
}

function decision(stdout) {
  return JSON.parse(stdout).hookSpecificOutput.permissionDecision;
}

// ── Part A: meta-exempt roots ────────────────────────────────────────────────

// A-1: .claude/settings.local.json inside cwd is ALLOWED during active wave.
test("A: Edit to .claude/settings.local.json in cwd is allowed during active wave", async () => {
  const tmpDir = makeFreshWaveDir("wave-a1");
  makeRunActive(tmpDir); // wave is legitimately active
  try {
    const { stdout, code } = await runRaw(
      editPayload(".claude/settings.local.json", tmpDir),
    );
    assert.equal(code, 0, "exit 0");
    const out = JSON.parse(stdout).hookSpecificOutput;
    assert.equal(out.hookEventName, "PreToolUse");
    assert.equal(out.permissionDecision, undefined, ".claude/ path must be exempt (no permissionDecision)");
  } finally {
    cleanDir(tmpDir);
  }
});

// A-2: absolute .claude/ path inside cwd is ALLOWED during active wave.
test("A: Edit to absolute .claude/ path inside cwd is allowed during active wave", async () => {
  const tmpDir = makeFreshWaveDir("wave-a2");
  makeRunActive(tmpDir);
  try {
    const claudeFile = path.join(tmpDir, ".claude", "AGENTS.md");
    const { stdout, code } = await runRaw(
      editPayload(claudeFile, tmpDir),
    );
    assert.equal(code, 0);
    const out = JSON.parse(stdout).hookSpecificOutput;
    assert.equal(out.hookEventName, "PreToolUse");
    assert.equal(out.permissionDecision, undefined, "absolute .claude/ path must be exempt");
  } finally {
    cleanDir(tmpDir);
  }
});

// A-3: .muster/ path still exempt (wave-2 regression guard).
test("A: Edit to .muster/ path still allowed during active wave (regression)", async () => {
  const tmpDir = makeFreshWaveDir("wave-a3");
  makeRunActive(tmpDir);
  try {
    const { stdout, code } = await runRaw(
      editPayload(".muster/STATE.md", tmpDir),
    );
    assert.equal(code, 0);
    const out = JSON.parse(stdout).hookSpecificOutput;
    assert.equal(out.hookEventName, "PreToolUse");
    assert.equal(out.permissionDecision, undefined, ".muster/ must still be exempt");
  } finally {
    cleanDir(tmpDir);
  }
});

// A-4: a normal in-cwd source file is still DENIED during active wave (regression).
test("A: Edit to in-cwd source file is denied during active wave (regression)", async () => {
  const tmpDir = makeFreshWaveDir("wave-a4");
  makeRunActive(tmpDir);
  try {
    const { stdout, code } = await runRaw(
      editPayload(path.join(tmpDir, "src", "app.js"), tmpDir),
    );
    assert.equal(code, 0);
    const out = JSON.parse(stdout).hookSpecificOutput;
    assert.equal(out.hookEventName, "PreToolUse");
    assert.equal(out.permissionDecision, "deny", "in-cwd source file must still be denied");
    assert.match(out.permissionDecisionReason, /wave-a4/, "reason includes wave id");
  } finally {
    cleanDir(tmpDir);
  }
});

// ── Part B: run-active scoping signal ────────────────────────────────────────

// B-1: run-active PRESENT + fresh wave-active → wave-guard fires (deny on 1st in-cwd edit).
test("B: run-active present + fresh wave-active → wave-guard denies in-cwd edit", async () => {
  const tmpDir = makeFreshWaveDir("wave-b1");
  makeRunActive(tmpDir);
  const sid = "e1-b1";
  clearBudget(sid);
  try {
    const { stdout, code } = await runRaw(
      editPayload(path.join(tmpDir, "src", "x.js"), tmpDir, { session_id: sid }),
    );
    assert.equal(code, 0);
    const out = JSON.parse(stdout).hookSpecificOutput;
    assert.equal(out.permissionDecision, "deny", "wave-guard must deny first in-cwd edit");
    // Reason should be wave-guard message (mentions wave id), NOT scale-gate message.
    assert.match(out.permissionDecisionReason, /wave-b1/, "reason mentions wave id (wave-guard)");
    assert.doesNotMatch(out.permissionDecisionReason, /autopilot.*distinct|distinct.*autopilot/i,
      "reason must be wave-guard, not scale-gate");
  } finally {
    clearBudget(sid);
    cleanDir(tmpDir);
  }
});

// B-2: wave-active PRESENT + run-active ABSENT → treated as stale → scale-gate
//      (1st in-cwd edit is ALLOWED, not denied by wave-guard).
test("B: fresh wave-active + run-active ABSENT → scale-gate path (1st edit allowed)", async () => {
  const tmpDir = makeFreshWaveDir("wave-b2");
  // Deliberately do NOT create run-active.
  const sid = "e1-b2";
  clearBudget(sid);
  try {
    const { stdout, code } = await runRaw(
      editPayload(path.join(tmpDir, "src", "x.js"), tmpDir, { session_id: sid }),
    );
    assert.equal(code, 0);
    const out = JSON.parse(stdout).hookSpecificOutput;
    // Scale-gate: 1st distinct file is allowed (threshold is 3).
    assert.notEqual(out.permissionDecision, "deny",
      "without run-active, wave treated as stale; 1st edit must be allowed by scale-gate");
  } finally {
    clearBudget(sid);
    cleanDir(tmpDir);
  }
});

// B-3: wave-active PRESENT + run-active ABSENT → 3rd distinct file denied via
//      scale-gate (not wave-guard: reason mentions autopilot/verb, not wave id).
test("B: fresh wave-active + run-active ABSENT → 3rd edit denied via scale-gate reasoning", async () => {
  const tmpDir = makeFreshWaveDir("wave-b3");
  // Deliberately do NOT create run-active.
  const sid = "e1-b3";
  clearBudget(sid);
  try {
    await runRaw(editPayload(path.join(tmpDir, "src", "a.js"), tmpDir, { session_id: sid }));
    await runRaw(editPayload(path.join(tmpDir, "src", "b.js"), tmpDir, { session_id: sid }));
    const { stdout } = await runRaw(editPayload(path.join(tmpDir, "src", "c.js"), tmpDir, { session_id: sid }));
    const out = JSON.parse(stdout).hookSpecificOutput;
    assert.equal(out.permissionDecision, "deny", "3rd distinct file must be denied");
    // Must be scale-gate deny (mentions autopilot/verb), NOT wave-guard deny (would mention wave-b3).
    assert.match(out.permissionDecisionReason, /autopilot|verb/i, "deny via scale-gate message");
    assert.doesNotMatch(out.permissionDecisionReason, /wave-b3/,
      "scale-gate deny must not mention the wave-id (not a wave-guard deny)");
  } finally {
    clearBudget(sid);
    cleanDir(tmpDir);
  }
});

// B-4: no wave-active + no run-active → scale-gate as today
//      (1st/2nd allowed, 3rd denied — unchanged behavior).
test("B: no wave-active + no run-active → scale-gate exactly as today", async () => {
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), "muster-e1-test-"));
  mkdirSync(path.join(tmpDir, ".muster"), { recursive: true });
  const sid = "e1-b4";
  clearBudget(sid);
  try {
    const a = await runRaw(editPayload(path.join(tmpDir, "a.js"), tmpDir, { session_id: sid }));
    const b = await runRaw(editPayload(path.join(tmpDir, "b.js"), tmpDir, { session_id: sid }));
    const c = await runRaw(editPayload(path.join(tmpDir, "c.js"), tmpDir, { session_id: sid }));
    assert.notEqual(decision(a.stdout), "deny", "1st file allowed");
    assert.notEqual(decision(b.stdout), "deny", "2nd file allowed");
    assert.equal(decision(c.stdout), "deny", "3rd file denied by scale-gate (same as today)");
    assert.match(
      JSON.parse(c.stdout).hookSpecificOutput.permissionDecisionReason,
      /autopilot|verb/i,
      "scale-gate deny reason routes to a verb",
    );
  } finally {
    clearBudget(sid);
    cleanDir(tmpDir);
  }
});

// B-5: stale wave (>60min) + run-active ABSENT → scale-gate (existing behavior preserved).
test("B: stale wave-active (>60min) + no run-active → scale-gate (unchanged)", async () => {
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), "muster-e1-test-"));
  const stale = new Date(Date.now() - 61 * 60 * 1000);
  makeMarker(tmpDir, "wave-b5-stale", { mtime: stale });
  const sid = "e1-b5";
  clearBudget(sid);
  try {
    await runRaw(editPayload(path.join(tmpDir, "a.js"), tmpDir, { session_id: sid }));
    await runRaw(editPayload(path.join(tmpDir, "b.js"), tmpDir, { session_id: sid }));
    const c = await runRaw(editPayload(path.join(tmpDir, "c.js"), tmpDir, { session_id: sid }));
    const out = JSON.parse(c.stdout).hookSpecificOutput;
    assert.equal(out.permissionDecision, "deny", "3rd file denied under stale marker");
    assert.doesNotMatch(out.permissionDecisionReason, /wave-b5-stale/,
      "deny reason is scale-gate, not wave-guard");
    assert.match(out.permissionDecisionReason, /autopilot|verb/i);
  } finally {
    clearBudget(sid);
    cleanDir(tmpDir);
  }
});

// B-6: agent_id always allowed regardless of run-active state.
test("B: agent_id allows even when wave-active present and run-active absent", async () => {
  const tmpDir = makeFreshWaveDir("wave-b6");
  // No run-active — but subagent calls must always be allowed.
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
