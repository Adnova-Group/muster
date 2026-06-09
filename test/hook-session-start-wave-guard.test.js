// Tests for session-start wave-guard fix:
// - marker survives source:"compact" and source:"resume"
// - marker removed on "startup"/"clear"/missing-source
// - uses payload.cwd when present
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  mkdtempSync, writeFileSync, mkdirSync, existsSync, rmSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import os from "node:os";

const HOOK = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "plugin",
  "hooks",
  "session-start.js",
);

// Spawn the hook with the given cwd and stdin payload, return { stdout, code }.
function runHookStdin(cwd, stdinText) {
  return new Promise((resolve) => {
    const child = execFile("node", [HOOK], { cwd }, (err, stdout) => {
      resolve({ stdout: stdout ?? err?.stdout ?? "", code: err?.code ?? 0 });
    });
    child.stdin.end(stdinText);
  });
}

// Create a temp dir with .muster/wave-active marker, return tmpDir.
function makeMarker(waveId = "wave-001") {
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), "muster-ss-wg-"));
  mkdirSync(path.join(tmpDir, ".muster"), { recursive: true });
  writeFileSync(path.join(tmpDir, ".muster", "wave-active"), waveId);
  return tmpDir;
}

function cleanDir(dir) {
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
}

function markerExists(dir) {
  return existsSync(path.join(dir, ".muster", "wave-active"));
}

// ── source:"compact" — marker must survive ───────────────────────────────────
test("session-start: marker survives source:compact (wave guard must not fire mid-wave)", async () => {
  const tmpDir = makeMarker("wave-compact-1");
  try {
    const payload = JSON.stringify({ source: "compact", session_id: "s1", cwd: tmpDir });
    const { stdout, code } = await runHookStdin(tmpDir, payload);
    assert.equal(code, 0, "exit 0");
    assert.doesNotThrow(() => JSON.parse(stdout), "valid JSON output");
    assert.ok(markerExists(tmpDir), "wave-active marker must still exist after compact SessionStart");
  } finally {
    cleanDir(tmpDir);
  }
});

// ── source:"resume" — marker must survive ────────────────────────────────────
test("session-start: marker survives source:resume", async () => {
  const tmpDir = makeMarker("wave-resume-1");
  try {
    const payload = JSON.stringify({ source: "resume", session_id: "s2", cwd: tmpDir });
    const { stdout, code } = await runHookStdin(tmpDir, payload);
    assert.equal(code, 0, "exit 0");
    assert.doesNotThrow(() => JSON.parse(stdout), "valid JSON output");
    assert.ok(markerExists(tmpDir), "wave-active marker must still exist after resume SessionStart");
  } finally {
    cleanDir(tmpDir);
  }
});

// ── source:"startup" — marker must be removed ───────────────────────────────
test("session-start: marker removed on source:startup", async () => {
  const tmpDir = makeMarker("wave-old");
  try {
    const payload = JSON.stringify({ source: "startup", session_id: "s3", cwd: tmpDir });
    const { stdout, code } = await runHookStdin(tmpDir, payload);
    assert.equal(code, 0, "exit 0");
    assert.ok(!markerExists(tmpDir), "wave-active marker must be removed on startup");
  } finally {
    cleanDir(tmpDir);
  }
});

// ── source:"clear" — marker must be removed ─────────────────────────────────
test("session-start: marker removed on source:clear", async () => {
  const tmpDir = makeMarker("wave-old-2");
  try {
    const payload = JSON.stringify({ source: "clear", session_id: "s4", cwd: tmpDir });
    const { stdout, code } = await runHookStdin(tmpDir, payload);
    assert.equal(code, 0, "exit 0");
    assert.ok(!markerExists(tmpDir), "wave-active marker must be removed on clear");
  } finally {
    cleanDir(tmpDir);
  }
});

// ── missing source — marker must be removed (old-style no-source SessionStart) ─
test("session-start: marker removed when source field is absent", async () => {
  const tmpDir = makeMarker("wave-nosrc");
  try {
    const payload = JSON.stringify({ session_id: "s5", cwd: tmpDir });
    const { stdout, code } = await runHookStdin(tmpDir, payload);
    assert.equal(code, 0, "exit 0");
    assert.ok(!markerExists(tmpDir), "wave-active marker must be removed when source absent");
  } finally {
    cleanDir(tmpDir);
  }
});

// ── payload.cwd takes precedence over process.cwd() ────────────────────────
test("session-start: uses payload.cwd to locate the marker (not process.cwd)", async () => {
  const tmpDir = makeMarker("wave-cwd-test");
  // Run hook from a DIFFERENT directory (os.tmpdir()) but pass cwd in payload.
  try {
    const payload = JSON.stringify({ source: "startup", session_id: "s6", cwd: tmpDir });
    const { stdout, code } = await runHookStdin(os.tmpdir(), payload);
    assert.equal(code, 0, "exit 0");
    assert.ok(!markerExists(tmpDir), "hook used payload.cwd to find and remove marker");
  } finally {
    cleanDir(tmpDir);
  }
});

// ── routing-policy text appears in additionalContext ────────────────────────
test("session-start: additionalContext includes routing-policy text", async () => {
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), "muster-ss-rp-"));
  try {
    const payload = JSON.stringify({ source: "startup", cwd: tmpDir });
    const { stdout, code } = await runHookStdin(tmpDir, payload);
    assert.equal(code, 0);
    const ctx = JSON.parse(stdout).hookSpecificOutput.additionalContext;
    assert.match(ctx, /Default routing|humanizer/i, "routing policy text present in additionalContext");
  } finally {
    cleanDir(tmpDir);
  }
});
