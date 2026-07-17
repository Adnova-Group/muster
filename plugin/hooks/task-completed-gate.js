#!/usr/bin/env node
// muster TaskCompleted hook — ties the native task board's own "completed"
// tick to a recorded review-gate PASS, so the board can be the run's
// AUTHORITATIVE progress surface without trusting a tick at face value.
//
// Backlog item `task-board-authoritative`: the native task board
// (TaskCreate/TaskUpdate/TaskList) replaces STATE-mirrored per-item
// pending/running/done tracking as the live status surface (see
// plugin/skills/orchestrator/SKILL.md's "Task board" section). That only
// works if "completed" on the board actually means "the review gate passed
// this task" — otherwise the board is just a second place a status could go
// stale. This hook is the enforcement half of that claim.
//
// Input (`.muster/task-board.json`, written by orchestrator/go-backlog SKILL
// prose, never by this hook): a flat map keyed by the harness's own native
// task id (the value TaskCreate returned), one entry per muster-tracked task:
//   { "<nativeTaskId>": { "manifestTaskId": "<id>", "reviewGate": "pending"|"pass"|"escalated" } }
// Written "pending" at TaskCreate time, flipped to "pass" the instant
// review-gate (orchestrator step 4c) returns PASS for that task — BEFORE the
// orchestrator calls TaskUpdate to mark it completed. An escalated task's
// entry is left "escalated" and its native task should stay in_progress; this
// hook denies a completion attempt on it regardless.
//
// Decision order (fail-open by design — this hook only ever gates ITS OWN
// board entries, never a harness-native task muster did not create):
//   1. MUSTER_TASK_GATE=off -> allow unconditionally (escape hatch).
//   2. Malformed/unreadable stdin payload -> allow (nothing to gate).
//   3. No task_id in the payload -> allow (nothing to look up).
//   4. .muster/task-board.json absent, unreadable, or malformed JSON -> allow
//      (no muster run tracked anything here — the board isn't muster's to gate).
//   5. task_id not a key in the map -> allow (not a muster-tracked task).
//   6. entry.reviewGate === "pass" -> allow.
//   7. Anything else ("pending", "escalated", or an unrecognized value) ->
//      DENY: exit 2, reason on stderr (per the documented TaskCreated/
//      TaskCompleted exit-code contract — "exit 2 rolls back the
//      [creation/completion], stderr fed to the model" — no JSON output
//      needed here, unlike PreToolUse's hookSpecificOutput shape).
//
// FAIL-SAFE: entire body wrapped in try/catch; any unexpected error -> allow.

import { readFileSync } from "node:fs";
import path from "node:path";

function allow() {
  process.exit(0);
}

function deny(reason) {
  process.stderr.write(reason + "\n");
  process.exit(2);
}

try {
  // 1. Escape hatch.
  if ((process.env.MUSTER_TASK_GATE || "").toLowerCase() === "off") {
    allow();
  }

  // 2. Parse the TaskCompleted payload.
  let payload;
  try {
    payload = JSON.parse(readFileSync(0, "utf8"));
  } catch {
    allow();
  }

  // 3. Nothing to look up without a task_id.
  const taskId = payload && payload.task_id;
  if (typeof taskId !== "string" || taskId.length === 0) {
    allow();
  }

  const cwd = typeof payload.cwd === "string" && payload.cwd.length > 0
    ? payload.cwd
    : process.cwd();

  // 4. Read the board map — absent/unreadable/malformed all fail open, since
  //    this hook has nothing of its own to gate without it.
  let board;
  try {
    board = JSON.parse(readFileSync(path.join(cwd, ".muster", "task-board.json"), "utf8"));
  } catch {
    allow();
  }

  // 5. Not a muster-tracked task -> not this hook's business.
  const entry = board && typeof board === "object" ? board[taskId] : undefined;
  if (!entry || typeof entry !== "object") {
    allow();
  }

  // 6/7. The one thing this hook actually gates: a completion tick with no
  // recorded review-gate PASS.
  if (entry.reviewGate === "pass") {
    allow();
  }

  deny(
    `Task "${taskId}" (manifest task "${entry.manifestTaskId || "unknown"}") cannot be completed: ` +
    `no recorded review-gate PASS (.muster/task-board.json reviewGate="${entry.reviewGate}"). ` +
    `Run the review gate to PASS before marking this task completed, or set MUSTER_TASK_GATE=off to disable this check.`,
  );
} catch {
  // FAIL-SAFE: never break the session over this hook's own bug.
  allow();
}
