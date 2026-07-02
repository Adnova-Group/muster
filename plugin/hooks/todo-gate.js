#!/usr/bin/env node
// muster PreToolUse hook — todo-driving enforcement gate.
//
// Prevents the orchestrator from dispatching a subagent wave (Task tool) during
// a live muster run without first creating a native todo list, so plan progress
// stays visible in Claude Code's todo UI.
//
// Decision order (bias HARD toward ALLOW on any uncertainty —
// a false deny that blocks a legit dispatch is worse than an occasional miss):
//   1. tool_name !== "Task"  → ALLOW (not a subagent dispatch)
//   2. .muster/run-active absent in cwd → ALLOW (no live muster run)
//   3. MUSTER_TODO_GATE=off  → ALLOW; =warn → ALLOW with additionalContext note
//   4. Read transcript_path. Missing/unreadable/unparseable → ALLOW (fail-open).
//      Scan JSONL for assistant tool_use named TodoWrite|TaskCreate|TaskUpdate
//      with timestamp >= .muster/run-active mtime (statSync mtimeMs).
//      - Qualifying entry found  → ALLOW.
//      - Transcript clean + NO qualifying entry:
//          * If all found TodoWrites had readable timestamps but none >= mtime → DENY.
//          * If any TodoWrite lacked a readable timestamp → ALLOW (fallback: never
//            deny purely because timestamps are unreadable).
//          * No TodoWrite anywhere → DENY.
//   5. Wrap EVERYTHING in try/catch → ALLOW on any exception (fail-open, exit 0).
//
// SELF-CONTAINED: imports only node: builtins. No src/ imports.

import { readFileSync, statSync } from "node:fs";
import path from "node:path";

const EVENT = "PreToolUse";

// Self-contained emit — mirrors guidance.js pattern but copied here so this
// hook ships stand-alone (plugin/hooks/* must not import from src/).
function emit(obj) {
  process.stdout.write(JSON.stringify(obj));
}

function allow() {
  emit({ hookSpecificOutput: { hookEventName: EVENT } });
  process.exit(0);
}

function denyWith(reason) {
  emit({
    hookSpecificOutput: {
      hookEventName: EVENT,
      permissionDecision: "deny",
      permissionDecisionReason: reason,
    },
  });
  process.exit(0);
}

function warnWith(additionalContext) {
  emit({ hookSpecificOutput: { hookEventName: EVENT, additionalContext } });
  process.exit(0);
}

// Tool names that qualify as "a todo list was created".
const QUALIFYING_TOOLS = new Set(["TodoWrite", "TaskCreate", "TaskUpdate"]);

// Scan a parsed JSONL line for a qualifying tool_use entry.
// Returns { found, hasReadableTimestamp, timestampMs }.
function scanLine(obj) {
  const NOT_FOUND = { found: false, hasReadableTimestamp: false, timestampMs: null };
  if (!obj || typeof obj !== "object") return NOT_FOUND;

  // Collect candidate tool_use blocks.
  const candidates = [];

  // Line is itself a tool_use block.
  if (obj.type === "tool_use" && QUALIFYING_TOOLS.has(obj.name)) {
    candidates.push(obj);
  }

  // Line is a message with a content array.
  if (Array.isArray(obj.content)) {
    for (const item of obj.content) {
      if (item && item.type === "tool_use" && QUALIFYING_TOOLS.has(item.name)) {
        candidates.push(item);
      }
    }
  }

  if (candidates.length === 0) return NOT_FOUND;

  // Try to extract a timestamp from the outer message object.
  let timestampMs = null;
  let hasReadableTimestamp = false;

  const rawTs = obj.timestamp;
  if (typeof rawTs === "number" && isFinite(rawTs)) {
    timestampMs = rawTs;
    hasReadableTimestamp = true;
  } else if (typeof rawTs === "string") {
    const parsed = Date.parse(rawTs);
    if (!isNaN(parsed)) {
      timestampMs = parsed;
      hasReadableTimestamp = true;
    }
  }

  return { found: true, hasReadableTimestamp, timestampMs };
}

try {
  // 0. Read payload from stdin.
  let payload;
  try {
    payload = JSON.parse(readFileSync(0, "utf8"));
  } catch {
    allow();
  }

  // 1. Only gate the Task (subagent-dispatch) tool.
  if (payload.tool_name !== "Task") allow();

  // 2. Resolve cwd; check for the run-active marker.
  const cwd =
    typeof payload.cwd === "string" && payload.cwd.length > 0
      ? payload.cwd
      : process.cwd();

  let runActiveStat;
  try {
    runActiveStat = statSync(path.join(cwd, ".muster", "run-active"));
  } catch {
    allow(); // No live muster run — allow.
  }
  if (!runActiveStat) allow(); // defensive

  // 3. Escape hatch: MUSTER_TODO_GATE env var.
  const gate = (process.env.MUSTER_TODO_GATE || "").toLowerCase();
  if (gate === "off") allow();
  if (gate === "warn") {
    warnWith(
      "muster runs are todo-driven — a TodoWrite list per plan step is expected " +
        "before dispatching waves. Create the run's todo list first.",
    );
  }

  // 4. Read and scan the transcript.
  const transcriptPath = payload.transcript_path;
  if (!transcriptPath || typeof transcriptPath !== "string") allow();

  let transcriptText;
  try {
    transcriptText = readFileSync(transcriptPath, "utf8");
  } catch {
    allow(); // Missing / unreadable → fail-open.
  }
  if (typeof transcriptText !== "string") allow(); // defensive

  const runActiveMtime = runActiveStat.mtimeMs;

  // Scan JSONL lines.
  let parsedCleanly = true; // flipped to false if any non-empty line fails to parse
  let foundQualifyingByTimestamp = false; // TodoWrite with timestamp >= mtime
  let foundAnyTodoWrite = false; // any TodoWrite at all (for fallback)
  let foundTodoWriteWithoutReadableTs = false; // for the "timestamps unreadable" fallback

  const lines = transcriptText.split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue; // blank lines OK

    let obj;
    try {
      obj = JSON.parse(trimmed);
    } catch {
      parsedCleanly = false;
      continue;
    }

    const { found, hasReadableTimestamp, timestampMs } = scanLine(obj);
    if (!found) continue;

    foundAnyTodoWrite = true;

    if (hasReadableTimestamp) {
      if (timestampMs >= runActiveMtime) {
        foundQualifyingByTimestamp = true;
        break; // no need to scan further
      }
      // timestamp readable but pre-run — keep scanning
    } else {
      // No readable timestamp on this entry.
      foundTodoWriteWithoutReadableTs = true;
    }
  }

  // Decision tree (most-permissive first):

  // Qualifying TodoWrite found since run start → ALLOW.
  if (foundQualifyingByTimestamp) allow();

  // Any TodoWrite lacked a readable timestamp → never deny on timestamp uncertainty.
  if (foundTodoWriteWithoutReadableTs) allow();

  // Transcript didn't parse cleanly → fail-open.
  if (!parsedCleanly) allow();

  // Transcript parsed cleanly with no qualifying TodoWrite → DENY.
  denyWith(
    "muster runs are todo-driven so plan progress stays visible. " +
      "Create the run's todo list first — one TodoWrite item per plan step " +
      "(encode the crew owner + state in each item's text), then dispatch the wave.",
  );
} catch {
  // FAIL-SAFE: never break the session.
  allow();
}
