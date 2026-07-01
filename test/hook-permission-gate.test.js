// test/hook-permission-gate.test.js — wave-2 CC adapter: permission layer integration tests.
//
// These tests exercise the permission gate wired into plugin/hooks/pre-tool-use.js.
// The gate fires for main-loop calls (no agent_id) at every path where the
// wave-guard/scale-gate would otherwise allow the call. It never overrides a deny.
//
// Scenarios covered:
//   1. Allowlisted Bash → permissionDecision "allow" + glass-box additionalContext
//   2. Destructive rm -rf overrides run allowlist → permissionDecision "ask" (load-bearing)
//   3. Non-allowlisted non-destructive → no permissionDecision (defer to CC native)
//   4. Malformed payload → fail-open (no permissionDecision, no crash)
//   5. agent_id present → permission layer skipped even for destructive command

import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import os from "node:os";
import { spawnHook } from "./test-support/hook-helpers.js";

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

// Create a temp dir with .muster/ but NO wave-active marker.
// This puts the hook in "scale gate" mode.
function noWaveDir() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "muster-perm-test-"));
  mkdirSync(path.join(dir, ".muster"), { recursive: true });
  return dir;
}

// Write the run allowlist store into tmpDir/.muster/allow.run.json.
function seedRunStore(dir, keys) {
  writeFileSync(path.join(dir, ".muster", "allow.run.json"), JSON.stringify(keys));
}

function bashPayload(command, cwd, extra = {}) {
  return JSON.stringify({ tool_name: "Bash", tool_input: { command }, cwd, ...extra });
}

// ── 1. Allowlisted Bash → permissionDecision "allow" + glass-box additionalContext ──

test("allowlisted Bash command → permissionDecision allow with glass-box additionalContext", async () => {
  const tmpDir = noWaveDir();
  try {
    seedRunStore(tmpDir, ["Bash:npm test"]);
    const { stdout, code } = await runRaw(bashPayload("npm test", tmpDir));
    assert.equal(code, 0, "hook exits 0");
    const out = JSON.parse(stdout).hookSpecificOutput;
    assert.equal(out.hookEventName, "PreToolUse");
    assert.equal(out.permissionDecision, "allow", "allowlisted Bash must emit permissionDecision:allow");
    assert.ok(
      typeof out.additionalContext === "string" && out.additionalContext.includes("auto-allowed"),
      `additionalContext must include 'auto-allowed'; got: ${out.additionalContext}`,
    );
    assert.match(
      out.additionalContext,
      /Bash/,
      "additionalContext must name the tool",
    );
    assert.match(
      out.additionalContext,
      /run allowlist/,
      "additionalContext must name the scope",
    );
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ── 2. Destructive rm -rf overrides run allowlist → permissionDecision "ask" ────────
//
// Load-bearing carve-out: even when the exact command key is pre-seeded in the
// run allowlist, classifyDestructive matches rm -rf and forces a re-prompt.
// The test is named literally as the spec asks so it is easy to find in the report.

test("destructive rm -rf overrides run allowlist — permissionDecision ask", async () => {
  const tmpDir = noWaveDir();
  try {
    const destructiveCmd = "rm -rf x";
    const allowlistKey = `Bash:${destructiveCmd}`;
    // Pre-seed the exact key into the run allowlist.
    seedRunStore(tmpDir, [allowlistKey]);
    const { stdout, code } = await runRaw(bashPayload(destructiveCmd, tmpDir));
    assert.equal(code, 0, "hook exits 0");
    const out = JSON.parse(stdout).hookSpecificOutput;
    assert.equal(out.hookEventName, "PreToolUse");
    assert.equal(
      out.permissionDecision,
      "ask",
      "destructive command must emit permissionDecision:ask even when allowlisted",
    );
    // Must NOT be "allow" — the carve-out is the whole point.
    assert.notEqual(
      out.permissionDecision,
      "allow",
      "destructive command must never be silently allowed",
    );
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ── 3. Non-allowlisted non-destructive → no permissionDecision (defer) ─────────────

test("non-allowlisted non-destructive Bash → no permissionDecision (defer to CC native prompt)", async () => {
  const tmpDir = noWaveDir();
  try {
    // Empty store — command is not allowlisted and not destructive.
    seedRunStore(tmpDir, []);
    const { stdout, code } = await runRaw(bashPayload("git log --oneline", tmpDir));
    assert.equal(code, 0, "hook exits 0");
    const out = JSON.parse(stdout).hookSpecificOutput;
    assert.equal(out.hookEventName, "PreToolUse");
    assert.equal(
      out.permissionDecision,
      undefined,
      "non-allowlisted non-destructive must not set permissionDecision (defer to CC native)",
    );
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ── 4. Malformed payload → fail-open (no permissionDecision, no crash) ──────────────

test("malformed payload → fail-open: no permissionDecision, exit 0", async () => {
  const { stdout, code } = await runRaw("not valid json {{{");
  assert.equal(code, 0, "garbled stdin must exit 0");
  assert.doesNotThrow(() => JSON.parse(stdout), "stdout must be valid JSON even on garbled stdin");
  const out = JSON.parse(stdout).hookSpecificOutput;
  assert.equal(out.hookEventName, "PreToolUse");
  assert.equal(
    out.permissionDecision,
    undefined,
    "fail-open: no permissionDecision on garbled stdin",
  );
});

// ── 5. agent_id present → permission layer skipped ──────────────────────────────────
//
// Subagent calls (agent_id present) early-allow before the permission gate.
// Even a destructive command with no allowlist entry must not trigger "ask".

test("agent_id present → permission layer skipped even for destructive command", async () => {
  const tmpDir = noWaveDir();
  try {
    // No allowlist. Destructive command. But agent_id is present.
    const { stdout, code } = await runRaw(
      bashPayload("rm -rf everything", tmpDir, { agent_id: "sub-trusted" }),
    );
    assert.equal(code, 0, "hook exits 0 for subagent");
    const out = JSON.parse(stdout).hookSpecificOutput;
    assert.equal(out.hookEventName, "PreToolUse");
    assert.equal(
      out.permissionDecision,
      undefined,
      "subagent early-allow: permissionDecision must be absent",
    );
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ── 6. Project allowlist (--project scope) is also honoured ─────────────────────────

test("project-allowlisted Bash command → permissionDecision allow with project scope", async () => {
  const tmpDir = noWaveDir();
  try {
    // Write project store (not in .muster/, at repo root level of the fake cwd).
    writeFileSync(path.join(tmpDir, ".muster-allow.json"), JSON.stringify(["Bash:npm run build"]));
    const { stdout, code } = await runRaw(bashPayload("npm run build", tmpDir));
    assert.equal(code, 0, "hook exits 0");
    const out = JSON.parse(stdout).hookSpecificOutput;
    assert.equal(out.permissionDecision, "allow", "project-allowlisted command → allow");
    assert.match(
      out.additionalContext,
      /project allowlist/,
      "additionalContext must say 'project allowlist'",
    );
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});
