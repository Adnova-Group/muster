// test/hook-task-completed-gate.test.js
//
// TaskCompleted gating hook (backlog item `task-board-authoritative`): the
// native task board becomes the authoritative progress surface, so its own
// "completed" tick must be tied to a real review-gate PASS instead of being
// trusted at face value. `.muster/task-board.json` (written by orchestrator/
// go-backlog SKILL prose at TaskCreate time, then flipped to "pass" the
// moment review-gate returns PASS for that task -- see
// plugin/skills/orchestrator/SKILL.md's "Task board" section) is this hook's
// only input besides the TaskCompleted payload itself.
//
// Decision order (fail-open by design -- see plugin/hooks/task-completed-gate.js
// header): MUSTER_TASK_GATE=off -> allow; no task-board.json -> allow
// (untracked run); task_id absent from the map -> allow (not a muster-tracked
// task); reviewGate !== "pass" -> DENY (exit 2); reviewGate === "pass" -> allow.

import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import { cleanDir, spawnHook } from "./test-support/hook-helpers.js";

const HOOK = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "plugin",
  "hooks",
  "task-completed-gate.js",
);

function makeDir() {
  return mkdtempSync(path.join(os.tmpdir(), "muster-task-gate-test-"));
}

function writeBoard(dir, board) {
  mkdirSync(path.join(dir, ".muster"), { recursive: true });
  writeFileSync(path.join(dir, ".muster", "task-board.json"), JSON.stringify(board));
}

function payload(taskId, cwd, extra = {}) {
  return JSON.stringify({ task_id: taskId, cwd, session_id: "sess-test", ...extra });
}

test("TaskCompleted: a muster-tracked task with no recorded review-gate PASS is BLOCKED (exit 2)", async () => {
  const dir = makeDir();
  try {
    writeBoard(dir, { "native-1": { manifestTaskId: "task-a", reviewGate: "pending" } });
    const { code } = await spawnHook(HOOK, payload("native-1", dir));
    assert.equal(code, 2, "a completion tick with no recorded PASS must be denied (exit 2)");
  } finally {
    cleanDir(dir);
  }
});

test("TaskCompleted: a muster-tracked task WITH a recorded review-gate PASS is ALLOWED (exit 0)", async () => {
  const dir = makeDir();
  try {
    writeBoard(dir, { "native-1": { manifestTaskId: "task-a", reviewGate: "pass" } });
    const { code } = await spawnHook(HOOK, payload("native-1", dir));
    assert.equal(code, 0, "a completion tick with a recorded PASS must be allowed (exit 0)");
  } finally {
    cleanDir(dir);
  }
});

test("TaskCompleted: an escalated task (never reached PASS) stays BLOCKED (exit 2)", async () => {
  const dir = makeDir();
  try {
    writeBoard(dir, { "native-1": { manifestTaskId: "task-a", reviewGate: "escalated" } });
    const { code } = await spawnHook(HOOK, payload("native-1", dir));
    assert.equal(code, 2, "an escalated task must not be completable via this hook");
  } finally {
    cleanDir(dir);
  }
});

test("TaskCompleted: fail-open when .muster/task-board.json is absent (no muster run tracked this task)", async () => {
  const dir = makeDir();
  try {
    const { code } = await spawnHook(HOOK, payload("native-1", dir));
    assert.equal(code, 0, "no task-board.json at all must never block a harness-native task");
  } finally {
    cleanDir(dir);
  }
});

test("TaskCompleted: fail-open when the task_id is not tracked in task-board.json (a different, non-muster task)", async () => {
  const dir = makeDir();
  try {
    writeBoard(dir, { "native-1": { manifestTaskId: "task-a", reviewGate: "pending" } });
    const { code } = await spawnHook(HOOK, payload("some-other-native-task", dir));
    assert.equal(code, 0, "an untracked task_id must never be blocked -- this hook only gates its own board entries");
  } finally {
    cleanDir(dir);
  }
});

test("TaskCompleted: MUSTER_TASK_GATE=off disables the gate entirely, even for a pending tracked task", async () => {
  const dir = makeDir();
  try {
    writeBoard(dir, { "native-1": { manifestTaskId: "task-a", reviewGate: "pending" } });
    const { code } = await spawnHook(HOOK, payload("native-1", dir), { MUSTER_TASK_GATE: "off" });
    assert.equal(code, 0, "MUSTER_TASK_GATE=off must allow unconditionally");
  } finally {
    cleanDir(dir);
  }
});

test("TaskCompleted: fail-open on malformed task-board.json (never crash the session)", async () => {
  const dir = makeDir();
  try {
    mkdirSync(path.join(dir, ".muster"), { recursive: true });
    writeFileSync(path.join(dir, ".muster", "task-board.json"), "{not valid json");
    const { code } = await spawnHook(HOOK, payload("native-1", dir));
    assert.equal(code, 0, "malformed task-board.json must fail open, not crash/deny");
  } finally {
    cleanDir(dir);
  }
});

test("TaskCompleted: fail-open on malformed stdin payload", async () => {
  const { code } = await spawnHook(HOOK, "{not valid json");
  assert.equal(code, 0, "malformed stdin must fail open");
});

test("TaskCompleted: missing task_id in an otherwise-valid payload fails open", async () => {
  const dir = makeDir();
  try {
    writeBoard(dir, { "native-1": { manifestTaskId: "task-a", reviewGate: "pending" } });
    const { code } = await spawnHook(HOOK, JSON.stringify({ cwd: dir, session_id: "sess-test" }));
    assert.equal(code, 0, "no task_id at all means nothing to look up -- fail open");
  } finally {
    cleanDir(dir);
  }
});
