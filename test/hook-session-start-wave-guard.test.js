// Tests for session-start wave-guard fix:
// - marker survives source:"compact" and source:"resume"
// - marker removed on "startup"/"clear"/missing-source
// - uses payload.cwd when present
// - run-active marker cleared on fresh sessions, survives mid-session sources
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync, existsSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import os from "node:os";
import { cleanDir, makeMarker, makeRunActive as makeRunMarker, spawnHook } from "./test-support/hook-helpers.js";

function runActiveExists(dir) {
  return existsSync(path.join(dir, ".muster", "run-active"));
}

const HOOK = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "plugin",
  "hooks",
  "session-start.js",
);

// Spawn the hook with the given cwd and stdin payload, return { stdout, code }.
// NOTE: cwd is set as the process working directory via execFile option, not env.
// The session-start hook reads cwd from payload.cwd, so these tests always include
// it in the JSON payload directly. spawnHook is used here via its env parameter.
function runHookStdin(cwd, stdinText) {
  return spawnHook(HOOK, stdinText);
}

// Create a temp dir with .muster/wave-active marker, return tmpDir.
function makeTmpMarker(waveId = "wave-001") {
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), "muster-ss-wg-"));
  makeMarker(tmpDir, waveId);
  return tmpDir;
}

function markerExists(dir) {
  return existsSync(path.join(dir, ".muster", "wave-active"));
}

// ── source:"compact" — marker must survive ───────────────────────────────────
test("session-start: marker survives source:compact (wave guard must not fire mid-wave)", async () => {
  const tmpDir = makeTmpMarker("wave-compact-1");
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
  const tmpDir = makeTmpMarker("wave-resume-1");
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
  const tmpDir = makeTmpMarker("wave-old");
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
  const tmpDir = makeTmpMarker("wave-old-2");
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
  const tmpDir = makeTmpMarker("wave-nosrc");
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
  const tmpDir = makeTmpMarker("wave-cwd-test");
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

// ── additionalContext is the trimmed one-line pointer ───────────────────────
test("session-start: additionalContext is the trimmed one-line pointer", async () => {
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), "muster-ss-rp-"));
  try {
    const payload = JSON.stringify({ source: "startup", cwd: tmpDir });
    const { stdout, code } = await runHookStdin(tmpDir, payload);
    assert.equal(code, 0);
    const ctx = JSON.parse(stdout).hookSpecificOutput.additionalContext;
    assert.match(ctx, /muster available/i, "one-line pointer present in additionalContext");
    assert.match(ctx, /\/muster:plan\b/, "one-line pointer names the orchestration-scale verb");
  } finally {
    cleanDir(tmpDir);
  }
});

// ── run-active marker lifecycle ──────────────────────────────────────────────

// source:"startup" — run-active must be cleared (crashed verb)
test("session-start: run-active marker removed on source:startup", async () => {
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), "muster-ss-ra-"));
  makeRunMarker(tmpDir, "run-old");
  try {
    const payload = JSON.stringify({ source: "startup", session_id: "ra1", cwd: tmpDir });
    const { stdout, code } = await runHookStdin(tmpDir, payload);
    assert.equal(code, 0, "exit 0");
    assert.doesNotThrow(() => JSON.parse(stdout), "valid JSON");
    assert.ok(!runActiveExists(tmpDir), "run-active must be removed on startup");
  } finally {
    cleanDir(tmpDir);
  }
});

// source:"clear" — run-active must be cleared
test("session-start: run-active marker removed on source:clear", async () => {
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), "muster-ss-ra-"));
  makeRunMarker(tmpDir, "run-old-2");
  try {
    const payload = JSON.stringify({ source: "clear", session_id: "ra2", cwd: tmpDir });
    const { stdout, code } = await runHookStdin(tmpDir, payload);
    assert.equal(code, 0, "exit 0");
    assert.ok(!runActiveExists(tmpDir), "run-active must be removed on clear");
  } finally {
    cleanDir(tmpDir);
  }
});

// missing source — run-active must be cleared (old-style payload)
test("session-start: run-active marker removed when source field is absent", async () => {
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), "muster-ss-ra-"));
  makeRunMarker(tmpDir, "run-nosrc");
  try {
    const payload = JSON.stringify({ session_id: "ra3", cwd: tmpDir });
    const { stdout, code } = await runHookStdin(tmpDir, payload);
    assert.equal(code, 0, "exit 0");
    assert.ok(!runActiveExists(tmpDir), "run-active must be removed when source absent");
  } finally {
    cleanDir(tmpDir);
  }
});

// source:"compact" — run-active must survive (mid-session, verb may still be running)
test("session-start: run-active marker survives source:compact", async () => {
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), "muster-ss-ra-"));
  makeRunMarker(tmpDir, "run-compact");
  try {
    const payload = JSON.stringify({ source: "compact", session_id: "ra4", cwd: tmpDir });
    const { stdout, code } = await runHookStdin(tmpDir, payload);
    assert.equal(code, 0, "exit 0");
    assert.ok(runActiveExists(tmpDir), "run-active must survive compact (verb may still be running)");
  } finally {
    cleanDir(tmpDir);
  }
});

// source:"resume" — run-active must survive
test("session-start: run-active marker survives source:resume", async () => {
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), "muster-ss-ra-"));
  makeRunMarker(tmpDir, "run-resume");
  try {
    const payload = JSON.stringify({ source: "resume", session_id: "ra5", cwd: tmpDir });
    const { stdout, code } = await runHookStdin(tmpDir, payload);
    assert.equal(code, 0, "exit 0");
    assert.ok(runActiveExists(tmpDir), "run-active must survive resume");
  } finally {
    cleanDir(tmpDir);
  }
});
