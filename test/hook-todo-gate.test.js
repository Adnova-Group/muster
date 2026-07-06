// hook-todo-gate.test.js — PreToolUse todo-driving enforcement gate.
//
// Verifies that:
//   • Task dispatch during a live run WITHOUT a prior TodoWrite → DENY
//   • Task dispatch during a live run WITH a qualifying TodoWrite → ALLOW
//   • Task dispatch with no run-active marker → ALLOW (no live run)
//   • MUSTER_TODO_GATE=off bypasses the gate → ALLOW
//   • Missing / garbage transcript_path → ALLOW (fail-open)
//   • Non-Task tool (e.g. Edit) → ALLOW (gate only fires on Task)
//   • Self-containment: todo-gate.js imports nothing from src/
import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import os from "node:os";
import { cleanDir, spawnHook } from "./test-support/hook-helpers.js";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const HOOK = path.join(ROOT, "plugin", "hooks", "todo-gate.js");
const TODO_GATE_SRC = path.join(ROOT, "plugin", "hooks", "todo-gate.js");

// ── Transcript JSONL fixture helpers ─────────────────────────────────────────

/**
 * Build one JSONL line representing an assistant message with a tool_use block.
 * @param {string} toolName   – e.g. "TodoWrite", "Task"
 * @param {string|null} ts    – ISO 8601 timestamp string, or null to omit
 */
function toolUseLine(toolName, ts = null) {
  const msg = {
    role: "assistant",
    content: [{ type: "tool_use", name: toolName, id: "id-1", input: {} }],
  };
  if (ts !== null) msg.timestamp = ts;
  return JSON.stringify(msg);
}

/**
 * Write a temporary JSONL transcript file and return its path.
 * @param {string[]} lines – JSONL lines (already serialised)
 * @param {string} dir     – directory to write into
 */
function writeTranscript(lines, dir) {
  const p = path.join(dir, "transcript.jsonl");
  writeFileSync(p, lines.join("\n") + "\n");
  return p;
}

/**
 * Create a temp dir with:
 *   .muster/run-active  (written NOW so mtime is current)
 * Returns { tmpDir, runActiveMtime } — the mtime in ms.
 */
function makeLiveRun() {
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), "muster-todo-gate-"));
  mkdirSync(path.join(tmpDir, ".muster"), { recursive: true });
  const markerPath = path.join(tmpDir, ".muster", "run-active");
  writeFileSync(markerPath, "run-001");
  const { mtimeMs } = require_statSync(markerPath);
  return { tmpDir, runActiveMtime: mtimeMs };
}

// statSync wrapper importable here without importing from guidance.js
import { statSync } from "node:fs";
function require_statSync(p) { return statSync(p); }

// ── Payload builder ───────────────────────────────────────────────────────────

function taskPayload(transcriptPath, cwd, extra = {}) {
  return JSON.stringify({
    tool_name: "Task",
    tool_input: { description: "do work" },
    transcript_path: transcriptPath,
    cwd,
    session_id: "sess-test",
    ...extra,
  });
}

// Same shape as taskPayload but for an arbitrary dispatch-tool name (e.g. "Agent") —
// current Claude Code harnesses name the subagent dispatch tool "Agent" rather
// than "Task".
function dispatchPayload(toolName, transcriptPath, cwd, extra = {}) {
  return JSON.stringify({
    tool_name: toolName,
    tool_input: { description: "do work" },
    transcript_path: transcriptPath,
    cwd,
    session_id: "sess-test",
    ...extra,
  });
}

// ── Spawn helper ──────────────────────────────────────────────────────────────

function runGate(stdinText, env = {}) {
  return spawnHook(HOOK, stdinText, env);
}

// ── Tests ─────────────────────────────────────────────────────────────────────

// 1. Task + run-active + NO TodoWrite in transcript → DENY
test("todo-gate: Task during live run with no TodoWrite in transcript → DENY", async () => {
  const { tmpDir } = makeLiveRun();
  try {
    // Transcript has only a non-TodoWrite tool_use (another Task).
    const ts = new Date(Date.now() + 5000).toISOString(); // future — definitely post-run
    const transcriptPath = writeTranscript([toolUseLine("Task", ts)], tmpDir);

    const { stdout, code } = await runGate(taskPayload(transcriptPath, tmpDir));
    assert.equal(code, 0, "hook exits 0");
    const out = JSON.parse(stdout).hookSpecificOutput;
    assert.equal(out.hookEventName, "PreToolUse");
    assert.equal(out.permissionDecision, "deny", "should DENY without a TodoWrite");
    assert.match(
      out.permissionDecisionReason,
      /todo-driven|TodoWrite|todo list/i,
      "reason mentions todo requirement",
    );
  } finally {
    cleanDir(tmpDir);
  }
});

// 2. Task + run-active + TodoWrite with timestamp AFTER run-active mtime → ALLOW
test("todo-gate: Task during live run with qualifying TodoWrite → ALLOW", async () => {
  const { tmpDir, runActiveMtime } = makeLiveRun();
  try {
    // Timestamp slightly after the run-active mtime.
    const afterRunTs = new Date(runActiveMtime + 5000).toISOString();
    const transcriptPath = writeTranscript([toolUseLine("TodoWrite", afterRunTs)], tmpDir);

    const { stdout, code } = await runGate(taskPayload(transcriptPath, tmpDir));
    assert.equal(code, 0);
    const out = JSON.parse(stdout).hookSpecificOutput;
    assert.equal(out.hookEventName, "PreToolUse");
    assert.equal(out.permissionDecision, undefined, "ALLOW path: no permissionDecision field");
  } finally {
    cleanDir(tmpDir);
  }
});

// 3. Task + NO run-active marker → ALLOW (no live run)
test("todo-gate: Task with no run-active marker → ALLOW (no live run)", async () => {
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), "muster-todo-gate-"));
  mkdirSync(path.join(tmpDir, ".muster"), { recursive: true });
  // Do NOT write run-active.
  try {
    const transcriptPath = writeTranscript([], tmpDir);
    const { stdout, code } = await runGate(taskPayload(transcriptPath, tmpDir));
    assert.equal(code, 0);
    const out = JSON.parse(stdout).hookSpecificOutput;
    assert.equal(out.hookEventName, "PreToolUse");
    assert.equal(out.permissionDecision, undefined, "no live run → must ALLOW");
  } finally {
    cleanDir(tmpDir);
  }
});

// 4. Task + run-active + MUSTER_TODO_GATE=off → ALLOW (escape hatch)
test("todo-gate: MUSTER_TODO_GATE=off bypasses gate → ALLOW", async () => {
  const { tmpDir } = makeLiveRun();
  try {
    const transcriptPath = writeTranscript([], tmpDir); // no TodoWrite
    const { stdout, code } = await runGate(
      taskPayload(transcriptPath, tmpDir),
      { MUSTER_TODO_GATE: "off" },
    );
    assert.equal(code, 0);
    const out = JSON.parse(stdout).hookSpecificOutput;
    assert.equal(out.hookEventName, "PreToolUse");
    assert.equal(out.permissionDecision, undefined, "GATE=off → ALLOW");
    assert.equal(out.additionalContext, undefined, "off mode is silent");
  } finally {
    cleanDir(tmpDir);
  }
});

// 5. Task + run-active + MUSTER_TODO_GATE=warn → ALLOW with additionalContext
test("todo-gate: MUSTER_TODO_GATE=warn → ALLOW with additionalContext note", async () => {
  const { tmpDir } = makeLiveRun();
  try {
    const transcriptPath = writeTranscript([], tmpDir); // no TodoWrite
    const { stdout, code } = await runGate(
      taskPayload(transcriptPath, tmpDir),
      { MUSTER_TODO_GATE: "warn" },
    );
    assert.equal(code, 0);
    const out = JSON.parse(stdout).hookSpecificOutput;
    assert.equal(out.hookEventName, "PreToolUse");
    assert.equal(out.permissionDecision, undefined, "warn mode must not deny");
    assert.ok("additionalContext" in out, "warn mode must emit additionalContext");
    assert.match(out.additionalContext, /todo|TodoWrite/i, "additionalContext mentions todo");
  } finally {
    cleanDir(tmpDir);
  }
});

// 6. Fail-open: missing transcript_path → ALLOW
test("todo-gate: missing transcript_path → ALLOW (fail-open)", async () => {
  const { tmpDir } = makeLiveRun();
  try {
    const { stdout, code } = await runGate(
      JSON.stringify({
        tool_name: "Task",
        tool_input: { description: "work" },
        // transcript_path omitted
        cwd: tmpDir,
        session_id: "sess-x",
      }),
    );
    assert.equal(code, 0);
    const out = JSON.parse(stdout).hookSpecificOutput;
    assert.equal(out.hookEventName, "PreToolUse");
    assert.equal(out.permissionDecision, undefined, "missing transcript_path → ALLOW");
  } finally {
    cleanDir(tmpDir);
  }
});

// 7. Fail-open: transcript_path points to a non-existent file → ALLOW
test("todo-gate: unreadable transcript_path → ALLOW (fail-open)", async () => {
  const { tmpDir } = makeLiveRun();
  try {
    const { stdout, code } = await runGate(
      taskPayload("/nonexistent/path/transcript.jsonl", tmpDir),
    );
    assert.equal(code, 0);
    const out = JSON.parse(stdout).hookSpecificOutput;
    assert.equal(out.hookEventName, "PreToolUse");
    assert.equal(out.permissionDecision, undefined, "unreadable transcript → ALLOW");
  } finally {
    cleanDir(tmpDir);
  }
});

// 8. Fail-open: transcript is garbage (unparseable JSON lines) → ALLOW
test("todo-gate: garbage transcript → ALLOW (fail-open)", async () => {
  const { tmpDir } = makeLiveRun();
  try {
    const transcriptPath = writeTranscript([
      "not valid json {{{{",
      "also bad",
    ], tmpDir);
    const { stdout, code } = await runGate(taskPayload(transcriptPath, tmpDir));
    assert.equal(code, 0);
    const out = JSON.parse(stdout).hookSpecificOutput;
    assert.equal(out.hookEventName, "PreToolUse");
    assert.equal(out.permissionDecision, undefined, "garbage transcript → ALLOW (fail-open)");
  } finally {
    cleanDir(tmpDir);
  }
});

// 9. Non-Task tool (Edit) → ALLOW regardless
test("todo-gate: non-Task tool (Edit) → ALLOW", async () => {
  const { tmpDir } = makeLiveRun();
  try {
    const { stdout, code } = await runGate(
      JSON.stringify({
        tool_name: "Edit",
        tool_input: { file_path: "/some/file.js" },
        transcript_path: path.join(tmpDir, "transcript.jsonl"),
        cwd: tmpDir,
        session_id: "sess-y",
      }),
    );
    assert.equal(code, 0);
    const out = JSON.parse(stdout).hookSpecificOutput;
    assert.equal(out.hookEventName, "PreToolUse");
    assert.equal(out.permissionDecision, undefined, "non-Task tool → ALLOW");
  } finally {
    cleanDir(tmpDir);
  }
});

// 10. Garbled stdin → ALLOW (fail-safe)
test("todo-gate: garbled stdin → ALLOW (fail-safe, exit 0)", async () => {
  const { stdout, code } = await runGate("not valid json {{{{");
  assert.equal(code, 0);
  const out = JSON.parse(stdout).hookSpecificOutput;
  assert.equal(out.hookEventName, "PreToolUse");
  assert.equal(out.permissionDecision, undefined, "garbled stdin → ALLOW");
});

// 11. Timestamps missing on TodoWrite entries → ALLOW (fallback — never deny on unreadable ts)
test("todo-gate: TodoWrite without timestamp → ALLOW (timestamp-fallback)", async () => {
  const { tmpDir } = makeLiveRun();
  try {
    // TodoWrite line with no timestamp field → fallback allows.
    const transcriptPath = writeTranscript([toolUseLine("TodoWrite", null)], tmpDir);
    const { stdout, code } = await runGate(taskPayload(transcriptPath, tmpDir));
    assert.equal(code, 0);
    const out = JSON.parse(stdout).hookSpecificOutput;
    assert.equal(out.hookEventName, "PreToolUse");
    assert.equal(out.permissionDecision, undefined, "no-timestamp TodoWrite → ALLOW (fallback)");
  } finally {
    cleanDir(tmpDir);
  }
});

// 12. TodoWrite with timestamp BEFORE run-active mtime → DENY (pre-run todo doesn't count)
test("todo-gate: TodoWrite before run-active mtime → DENY (pre-run todo)", async () => {
  const { tmpDir, runActiveMtime } = makeLiveRun();
  try {
    // Timestamp well before the run-active file was written.
    const beforeRunTs = new Date(runActiveMtime - 10000).toISOString();
    const transcriptPath = writeTranscript([toolUseLine("TodoWrite", beforeRunTs)], tmpDir);

    const { stdout, code } = await runGate(taskPayload(transcriptPath, tmpDir));
    assert.equal(code, 0);
    const out = JSON.parse(stdout).hookSpecificOutput;
    assert.equal(out.hookEventName, "PreToolUse");
    assert.equal(out.permissionDecision, "deny", "pre-run TodoWrite should not qualify → DENY");
  } finally {
    cleanDir(tmpDir);
  }
});

// 13. Grace-boundary: TodoWrite ~1s BEFORE run-active mtime (within GRACE_MS=2s) → ALLOW
test("todo-gate: TodoWrite ~1s before run-active mtime (within GRACE_MS) → ALLOW", async () => {
  const { tmpDir, runActiveMtime } = makeLiveRun();
  try {
    // 1 second before the marker mtime — inside the 2 s grace window.
    // Models the sub-second ISO-flooring case: a todo written at T.050 recorded
    // as T.000 by a second-resolution clock still qualifies.
    const nearBeforeTs = new Date(runActiveMtime - 1000).toISOString();
    const transcriptPath = writeTranscript([toolUseLine("TodoWrite", nearBeforeTs)], tmpDir);

    const { stdout, code } = await runGate(taskPayload(transcriptPath, tmpDir));
    assert.equal(code, 0);
    const out = JSON.parse(stdout).hookSpecificOutput;
    assert.equal(out.hookEventName, "PreToolUse");
    assert.equal(
      out.permissionDecision,
      undefined,
      "within GRACE_MS → ALLOW (no sub-second false-deny)",
    );
  } finally {
    cleanDir(tmpDir);
  }
});

// 14. Still-denies: TodoWrite 10s BEFORE run-active mtime (beyond GRACE_MS) → DENY
test("todo-gate: TodoWrite 10s before run-active mtime (beyond GRACE_MS) → DENY", async () => {
  const { tmpDir, runActiveMtime } = makeLiveRun();
  try {
    // 10 seconds before — clearly a pre-run todo that must not qualify.
    const wellBeforeTs = new Date(runActiveMtime - 10000).toISOString();
    const transcriptPath = writeTranscript([toolUseLine("TodoWrite", wellBeforeTs)], tmpDir);

    const { stdout, code } = await runGate(taskPayload(transcriptPath, tmpDir));
    assert.equal(code, 0);
    const out = JSON.parse(stdout).hookSpecificOutput;
    assert.equal(out.hookEventName, "PreToolUse");
    assert.equal(
      out.permissionDecision,
      "deny",
      "10 s before run (beyond GRACE_MS) → DENY (pre-run guard still works)",
    );
  } finally {
    cleanDir(tmpDir);
  }
});

// 16. TaskCreate (forward-compat name) qualifies as a todo-write → ALLOW
test("todo-gate: TaskCreate (forward-compat) qualifies → ALLOW", async () => {
  const { tmpDir, runActiveMtime } = makeLiveRun();
  try {
    const afterRunTs = new Date(runActiveMtime + 3000).toISOString();
    const transcriptPath = writeTranscript([toolUseLine("TaskCreate", afterRunTs)], tmpDir);

    const { stdout, code } = await runGate(taskPayload(transcriptPath, tmpDir));
    assert.equal(code, 0);
    const out = JSON.parse(stdout).hookSpecificOutput;
    assert.equal(out.permissionDecision, undefined, "TaskCreate qualifies → ALLOW");
  } finally {
    cleanDir(tmpDir);
  }
});

// 17. Empty transcript (no lines) + run-active → DENY
test("todo-gate: empty transcript + run-active → DENY", async () => {
  const { tmpDir } = makeLiveRun();
  try {
    const transcriptPath = writeTranscript([], tmpDir);
    const { stdout, code } = await runGate(taskPayload(transcriptPath, tmpDir));
    assert.equal(code, 0);
    const out = JSON.parse(stdout).hookSpecificOutput;
    assert.equal(out.permissionDecision, "deny", "empty transcript → DENY");
  } finally {
    cleanDir(tmpDir);
  }
});

// 18. Agent-named dispatch (current Claude Code harness name) + no TodoWrite → DENY
test("todo-gate: Agent dispatch during live run with no todo in transcript → DENY", async () => {
  const { tmpDir } = makeLiveRun();
  try {
    const ts = new Date(Date.now() + 5000).toISOString(); // future — definitely post-run
    const transcriptPath = writeTranscript([toolUseLine("Agent", ts)], tmpDir);

    const { stdout, code } = await runGate(dispatchPayload("Agent", transcriptPath, tmpDir));
    assert.equal(code, 0, "hook exits 0");
    const out = JSON.parse(stdout).hookSpecificOutput;
    assert.equal(out.hookEventName, "PreToolUse");
    assert.equal(out.permissionDecision, "deny", "Agent dispatch without a todo should DENY");
    assert.match(
      out.permissionDecisionReason,
      /todo-driven|TodoWrite|todo list/i,
      "reason mentions todo requirement",
    );
  } finally {
    cleanDir(tmpDir);
  }
});

// 19. Agent-named dispatch + qualifying TaskCreate since run start → ALLOW
test("todo-gate: Agent dispatch with qualifying TaskCreate → ALLOW", async () => {
  const { tmpDir, runActiveMtime } = makeLiveRun();
  try {
    const afterRunTs = new Date(runActiveMtime + 5000).toISOString();
    const transcriptPath = writeTranscript([toolUseLine("TaskCreate", afterRunTs)], tmpDir);

    const { stdout, code } = await runGate(dispatchPayload("Agent", transcriptPath, tmpDir));
    assert.equal(code, 0);
    const out = JSON.parse(stdout).hookSpecificOutput;
    assert.equal(out.hookEventName, "PreToolUse");
    assert.equal(out.permissionDecision, undefined, "Agent dispatch with a recent TaskCreate → ALLOW");
  } finally {
    cleanDir(tmpDir);
  }
});

// 20. Non-dispatch tool (Bash) → ALLOW regardless, gate only fires on Task|Agent
test("todo-gate: non-dispatch tool (Bash) → ALLOW", async () => {
  const { tmpDir } = makeLiveRun();
  try {
    const { stdout, code } = await runGate(
      JSON.stringify({
        tool_name: "Bash",
        tool_input: { command: "echo hi" },
        transcript_path: path.join(tmpDir, "transcript.jsonl"),
        cwd: tmpDir,
        session_id: "sess-z",
      }),
    );
    assert.equal(code, 0);
    const out = JSON.parse(stdout).hookSpecificOutput;
    assert.equal(out.hookEventName, "PreToolUse");
    assert.equal(out.permissionDecision, undefined, "non-dispatch tool → ALLOW");
  } finally {
    cleanDir(tmpDir);
  }
});

// ── Self-containment guard ────────────────────────────────────────────────────

test("todo-gate.js: imports nothing from src/ (self-containment)", () => {
  const src = readFileSync(TODO_GATE_SRC, "utf8");

  // Match all static import declarations and dynamic imports.
  const staticRe = /^\s*import\s+.*?\s+from\s+['"]([^'"]+)['"]/gm;
  const dynamicRe = /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g;

  const specifiers = [];
  let m;
  while ((m = staticRe.exec(src)) !== null) specifiers.push(m[1]);
  while ((m = dynamicRe.exec(src)) !== null) specifiers.push(m[1]);

  assert.ok(
    specifiers.length > 0,
    "todo-gate.js must have at least one import for this guard to be meaningful",
  );

  for (const s of specifiers) {
    assert.ok(
      !s.includes("/src/") && !s.startsWith("src/"),
      `import specifier "${s}" must not reference src/ — todo-gate.js must be self-contained`,
    );
  }
});
