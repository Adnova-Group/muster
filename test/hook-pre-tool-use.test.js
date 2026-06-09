import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { mkdtempSync, writeFileSync, mkdirSync, utimesSync, rmSync } from "node:fs";
import os from "node:os";

const HOOK = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "plugin",
  "hooks",
  "pre-tool-use.js",
);

// Spawn the hook, pipe stdinText to it, return { stdout, code }. Never rejects.
function runRaw(stdinText, env = {}) {
  return new Promise((resolve) => {
    const child = execFile(
      "node",
      [HOOK],
      { env: { ...process.env, ...env } },
      (err, stdout) => {
        resolve({ stdout: stdout ?? err?.stdout ?? "", code: err?.code ?? 0 });
      },
    );
    child.stdin.end(stdinText);
  });
}

// Build a payload for an Edit tool call targeting file_path, with the given cwd.
function editPayload(filePath, cwd, extra = {}) {
  return JSON.stringify({
    tool_name: "Edit",
    tool_input: { file_path: filePath },
    cwd,
    ...extra,
  });
}

// Create a temp dir, write .muster/wave-active with the given content, return tmpDir.
function makeMarker(waveId = "wave-001", mtime = null) {
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), "muster-wg-test-"));
  mkdirSync(path.join(tmpDir, ".muster"), { recursive: true });
  const markerPath = path.join(tmpDir, ".muster", "wave-active");
  writeFileSync(markerPath, waveId);
  if (mtime !== null) {
    utimesSync(markerPath, mtime, mtime);
  }
  return tmpDir;
}

// Remove the temp dir (best-effort).
function cleanDir(dir) {
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
}

// ── case (a): deny when marker exists + main-loop Edit outside .muster/ ─────
test("deny when wave-active marker exists and editing outside .muster/", async () => {
  const tmpDir = makeMarker("wave-042");
  try {
    // MUSTER_WAVE_GUARD unset => deny
    const { stdout, code } = await runRaw(
      editPayload("/some/project/src/foo.js", tmpDir),
    );
    assert.equal(code, 0, "hook always exits 0");
    const out = JSON.parse(stdout).hookSpecificOutput;
    assert.equal(out.hookEventName, "PreToolUse");
    assert.equal(out.permissionDecision, "deny", "should deny");
    assert.match(out.permissionDecisionReason, /wave-042/, "reason includes wave id");
    assert.match(out.permissionDecisionReason, /wave-active/, "reason mentions wave-active file");
  } finally {
    cleanDir(tmpDir);
  }
});

// ── case (b): allow when agent_id present (subagent call) ───────────────────
test("allow when agent_id is present (crew subagent)", async () => {
  const tmpDir = makeMarker("wave-007");
  try {
    const { stdout, code } = await runRaw(
      JSON.stringify({
        tool_name: "Edit",
        tool_input: { file_path: "/some/file.js" },
        cwd: tmpDir,
        agent_id: "sub-abc123",
      }),
    );
    assert.equal(code, 0);
    const out = JSON.parse(stdout).hookSpecificOutput;
    assert.equal(out.hookEventName, "PreToolUse");
    assert.ok(out.permissionDecision !== "deny", "should not deny subagent");
  } finally {
    cleanDir(tmpDir);
  }
});

// ── case (c): allow when no marker exists ───────────────────────────────────
test("allow when no wave-active marker exists", async () => {
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), "muster-wg-test-"));
  mkdirSync(path.join(tmpDir, ".muster"), { recursive: true }); // .muster exists but no marker
  try {
    const { stdout, code } = await runRaw(
      editPayload("/some/project/src/foo.js", tmpDir),
    );
    assert.equal(code, 0);
    const out = JSON.parse(stdout).hookSpecificOutput;
    assert.equal(out.hookEventName, "PreToolUse");
    assert.ok(out.permissionDecision !== "deny", "should not deny without marker");
  } finally {
    cleanDir(tmpDir);
  }
});

// ── case (d): allow for .muster/ path target ────────────────────────────────
test("allow Edit targeting a path inside .muster/", async () => {
  const tmpDir = makeMarker("wave-003");
  try {
    // file_path is inside .muster/ (relative or absolute under cwd)
    const { stdout, code } = await runRaw(
      editPayload(".muster/STATE.md", tmpDir),
    );
    assert.equal(code, 0);
    const out = JSON.parse(stdout).hookSpecificOutput;
    assert.equal(out.hookEventName, "PreToolUse");
    assert.ok(out.permissionDecision !== "deny", "should allow .muster/ paths");
  } finally {
    cleanDir(tmpDir);
  }
});

// ── case (e): allow when marker mtime > 60 minutes ago (stale) ──────────────
test("allow when wave-active marker is older than 60 minutes (stale/crashed wave)", async () => {
  // Backdate by 61 minutes
  const staleTime = new Date(Date.now() - 61 * 60 * 1000);
  const tmpDir = makeMarker("wave-001", staleTime);
  try {
    const { stdout, code } = await runRaw(
      editPayload("/some/project/src/foo.js", tmpDir),
    );
    assert.equal(code, 0);
    const out = JSON.parse(stdout).hookSpecificOutput;
    assert.equal(out.hookEventName, "PreToolUse");
    assert.ok(out.permissionDecision !== "deny", "should allow stale marker");
  } finally {
    cleanDir(tmpDir);
  }
});

// ── case (f): warn mode emits additionalContext, does NOT deny ───────────────
test("warn mode: emits additionalContext reminder, no deny", async () => {
  const tmpDir = makeMarker("wave-099");
  try {
    const { stdout, code } = await runRaw(
      editPayload("/some/project/src/foo.js", tmpDir),
      { MUSTER_WAVE_GUARD: "warn" },
    );
    assert.equal(code, 0);
    const out = JSON.parse(stdout).hookSpecificOutput;
    assert.equal(out.hookEventName, "PreToolUse");
    assert.ok(out.permissionDecision !== "deny", "warn mode must not deny");
    assert.ok("additionalContext" in out, "warn mode must emit additionalContext");
    assert.match(out.additionalContext, /crew|Agent|dispatch/i, "warn includes dispatch reminder");
  } finally {
    cleanDir(tmpDir);
  }
});

// ── case (g): off mode is silent allow ──────────────────────────────────────
test("off mode: silent allow, no additionalContext, no deny", async () => {
  const tmpDir = makeMarker("wave-005");
  try {
    const { stdout, code } = await runRaw(
      editPayload("/some/project/src/foo.js", tmpDir),
      { MUSTER_WAVE_GUARD: "off" },
    );
    assert.equal(code, 0);
    const out = JSON.parse(stdout).hookSpecificOutput;
    assert.equal(out.hookEventName, "PreToolUse");
    assert.ok(out.permissionDecision !== "deny", "off mode must not deny");
    assert.ok(!("additionalContext" in out), "off mode must be silent");
  } finally {
    cleanDir(tmpDir);
  }
});

// ── case (h): garbled stdin → silent allow, exit 0 ──────────────────────────
test("garbled stdin: silent allow, valid JSON, exit 0 (fail-safe)", async () => {
  const { stdout, code } = await runRaw("not valid json {{{{");
  assert.equal(code, 0, "exit 0 on garbled stdin");
  assert.doesNotThrow(() => JSON.parse(stdout), "stdout must be valid JSON");
  const out = JSON.parse(stdout).hookSpecificOutput;
  assert.equal(out.hookEventName, "PreToolUse");
  assert.ok(out.permissionDecision !== "deny", "garbled stdin must not deny");
});
