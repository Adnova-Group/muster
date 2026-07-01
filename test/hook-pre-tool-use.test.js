import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { mkdtempSync, mkdirSync } from "node:fs";
import { bashWriteTarget } from "../plugin/hooks/bash-write-target.js";
import os from "node:os";
import { cleanDir, makeMarker, spawnHook } from "./test-support/hook-helpers.js";

const HOOK = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "plugin",
  "hooks",
  "pre-tool-use.js",
);

// Spawn the hook with the pre-tool-use hook path bound.
function runRaw(stdinText, env = {}) {
  return spawnHook(HOOK, stdinText, env);
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

// Create a temp dir with a wave-active marker and return tmpDir.
function makeTmpMarker(waveId = "wave-001", mtime = null) {
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), "muster-wg-test-"));
  makeMarker(tmpDir, waveId, mtime !== null ? { mtime } : {});
  return tmpDir;
}

// ── case (a): deny when marker exists + main-loop Edit outside .muster/ ─────
test("deny when wave-active marker exists and editing outside .muster/", async () => {
  const tmpDir = makeTmpMarker("wave-042");
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
  const tmpDir = makeTmpMarker("wave-007");
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
  const tmpDir = makeTmpMarker("wave-003");
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
  const tmpDir = makeTmpMarker("wave-001", staleTime);
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
  const tmpDir = makeTmpMarker("wave-099");
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
  const tmpDir = makeTmpMarker("wave-005");
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

// ── allow-path tests: permissionDecision must be ABSENT (not merely !== deny) ─
test("allow when agent_id present: permissionDecision field must be absent", async () => {
  const tmpDir = makeTmpMarker("wave-007");
  try {
    const { stdout } = await runRaw(
      JSON.stringify({
        tool_name: "Edit",
        tool_input: { file_path: "/some/file.js" },
        cwd: tmpDir,
        agent_id: "sub-abc123",
      }),
    );
    const out = JSON.parse(stdout).hookSpecificOutput;
    assert.equal(out.hookEventName, "PreToolUse");
    assert.equal(out.permissionDecision, undefined, "allow path: permissionDecision must be ABSENT");
  } finally {
    cleanDir(tmpDir);
  }
});

test("allow when no wave-active: permissionDecision field must be absent", async () => {
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), "muster-wg-test-"));
  mkdirSync(path.join(tmpDir, ".muster"), { recursive: true });
  try {
    const { stdout } = await runRaw(editPayload("/some/project/src/foo.js", tmpDir));
    const out = JSON.parse(stdout).hookSpecificOutput;
    assert.equal(out.hookEventName, "PreToolUse");
    assert.equal(out.permissionDecision, undefined, "allow path: permissionDecision must be ABSENT");
  } finally {
    cleanDir(tmpDir);
  }
});

test("allow .muster/ path: permissionDecision field must be absent", async () => {
  const tmpDir = makeTmpMarker("wave-003");
  try {
    const { stdout } = await runRaw(editPayload(".muster/STATE.md", tmpDir));
    const out = JSON.parse(stdout).hookSpecificOutput;
    assert.equal(out.hookEventName, "PreToolUse");
    assert.equal(out.permissionDecision, undefined, "allow path: permissionDecision must be ABSENT");
  } finally {
    cleanDir(tmpDir);
  }
});

test("allow stale marker: permissionDecision field must be absent", async () => {
  const staleTime = new Date(Date.now() - 61 * 60 * 1000);
  const tmpDir = makeTmpMarker("wave-001", staleTime);
  try {
    const { stdout } = await runRaw(editPayload("/some/project/src/foo.js", tmpDir));
    const out = JSON.parse(stdout).hookSpecificOutput;
    assert.equal(out.hookEventName, "PreToolUse");
    assert.equal(out.permissionDecision, undefined, "allow path: permissionDecision must be ABSENT");
  } finally {
    cleanDir(tmpDir);
  }
});

test("warn mode: permissionDecision field must be absent", async () => {
  const tmpDir = makeTmpMarker("wave-099");
  try {
    const { stdout } = await runRaw(
      editPayload("/some/project/src/foo.js", tmpDir),
      { MUSTER_WAVE_GUARD: "warn" },
    );
    const out = JSON.parse(stdout).hookSpecificOutput;
    assert.equal(out.hookEventName, "PreToolUse");
    assert.equal(out.permissionDecision, undefined, "warn mode: permissionDecision must be ABSENT");
  } finally {
    cleanDir(tmpDir);
  }
});

test("off mode: permissionDecision field must be absent", async () => {
  const tmpDir = makeTmpMarker("wave-005");
  try {
    const { stdout } = await runRaw(
      editPayload("/some/project/src/foo.js", tmpDir),
      { MUSTER_WAVE_GUARD: "off" },
    );
    const out = JSON.parse(stdout).hookSpecificOutput;
    assert.equal(out.hookEventName, "PreToolUse");
    assert.equal(out.permissionDecision, undefined, "off mode: permissionDecision must be ABSENT");
  } finally {
    cleanDir(tmpDir);
  }
});

// ── waveId sanitization: long/garbage marker content ────────────────────────
test("waveId sanitized: long marker content is capped at 64 chars in deny reason", async () => {
  const longId = "A".repeat(200);
  const tmpDir = makeTmpMarker(longId);
  try {
    const { stdout } = await runRaw(editPayload("/some/file.js", tmpDir));
    const out = JSON.parse(stdout).hookSpecificOutput;
    assert.equal(out.permissionDecision, "deny", "should deny");
    // The wave id portion in the reason must be at most 64 chars of the original
    // (plus surrounding text). We verify the full reason is < 64 + overhead chars.
    const reason = out.permissionDecisionReason;
    // After "muster wave " there should be at most 64 printable chars before " is active"
    const match = reason.match(/muster wave (.+?) is active/);
    assert.ok(match, "reason has expected shape");
    assert.ok(match[1].length <= 64, `waveId in reason must be <= 64 chars, got ${match[1].length}`);
  } finally {
    cleanDir(tmpDir);
  }
});

test("waveId sanitized: non-printable chars stripped from deny reason", async () => {
  const dirtyId = "wave\x00\x01\x1f\x7f-dirty​ ";
  const tmpDir = makeTmpMarker(dirtyId);
  try {
    const { stdout } = await runRaw(editPayload("/some/file.js", tmpDir));
    const out = JSON.parse(stdout).hookSpecificOutput;
    assert.equal(out.permissionDecision, "deny", "should deny");
    const reason = out.permissionDecisionReason;
    // No non-printable ASCII (except ordinary spaces) in the reason
    assert.doesNotMatch(reason, /[\x00-\x1f\x7f]/, "no non-printable chars in reason");
  } finally {
    cleanDir(tmpDir);
  }
});

// ── deny reason text improvements ───────────────────────────────────────────
test("deny reason mentions shell-based file writes (sed -i, tee, heredocs)", async () => {
  const tmpDir = makeTmpMarker("wave-shell-test");
  try {
    const { stdout } = await runRaw(editPayload("/some/file.js", tmpDir));
    const out = JSON.parse(stdout).hookSpecificOutput;
    assert.equal(out.permissionDecision, "deny");
    const reason = out.permissionDecisionReason;
    // Should mention shell-based write patterns
    assert.match(reason, /sed|tee|heredoc/i, "deny reason mentions shell write patterns");
  } finally {
    cleanDir(tmpDir);
  }
});

test("deny reason mentions MUSTER_WAVE_GUARD=warn as escape hatch", async () => {
  const tmpDir = makeTmpMarker("wave-escape-test");
  try {
    const { stdout } = await runRaw(editPayload("/some/file.js", tmpDir));
    const out = JSON.parse(stdout).hookSpecificOutput;
    assert.equal(out.permissionDecision, "deny");
    const reason = out.permissionDecisionReason;
    assert.match(reason, /MUSTER_WAVE_GUARD.*warn|warn.*MUSTER_WAVE_GUARD/i, "deny reason mentions MUSTER_WAVE_GUARD=warn");
  } finally {
    cleanDir(tmpDir);
  }
});

// ── NotebookEdit deny test ────────────────────────────────────────────────────
test("deny NotebookEdit (notebook_path) when wave-active marker exists", async () => {
  const tmpDir = makeTmpMarker("wave-notebook-1");
  try {
    const { stdout, code } = await runRaw(
      JSON.stringify({
        tool_name: "NotebookEdit",
        tool_input: { notebook_path: "/some/notebook.ipynb" },
        cwd: tmpDir,
      }),
    );
    assert.equal(code, 0, "exit 0");
    const out = JSON.parse(stdout).hookSpecificOutput;
    assert.equal(out.hookEventName, "PreToolUse");
    assert.equal(out.permissionDecision, "deny", "NotebookEdit should be denied during wave");
    assert.match(out.permissionDecisionReason, /wave-notebook-1/, "reason includes wave id");
  } finally {
    cleanDir(tmpDir);
  }
});

// ── bashWriteTarget pure-function unit tests ──────────────────────────────────
// DENY cases
test("bashWriteTarget: sed -i is a write", () => {
  assert.ok(bashWriteTarget("sed -i 's/a/b/' src/x.js") !== null, "sed -i should return match");
});

test("bashWriteTarget: echo hi > src/x.js is a write", () => {
  assert.ok(bashWriteTarget("echo hi > src/x.js") !== null, "output redirect to file should match");
});

test("bashWriteTarget: cat <<EOF > config.json is a write", () => {
  assert.ok(bashWriteTarget("cat <<EOF > config.json") !== null, "heredoc with redirect to file should match");
});

test("bashWriteTarget: npm test | tee out.log is a write", () => {
  assert.ok(bashWriteTarget("npm test | tee out.log") !== null, "tee to non-exempt file should match");
});

test("bashWriteTarget: tee flags are skipped, real filename is the fragment", () => {
  // -i / --append must not be mistaken for the target (would be a wrong message
  // and, before command-keying, a budget-collapse vector).
  assert.equal(bashWriteTarget("cmd | tee -i out.log"), "tee out.log", "-i skipped");
  assert.equal(bashWriteTarget("cmd | tee --append out.log"), "tee out.log", "--append skipped");
  assert.equal(bashWriteTarget("cmd | tee -a /dev/stderr"), null, "flag skip still respects exempt target");
});

test("bashWriteTarget: echo x >> README.md is a write", () => {
  assert.ok(bashWriteTarget("echo x >> README.md") !== null, "append redirect to file should match");
});

// ALLOW cases
test("bashWriteTarget: npm test is not a write", () => {
  assert.equal(bashWriteTarget("npm test"), null, "npm test must return null");
});

test("bashWriteTarget: npm test 2>&1 is not a write (fd duplication)", () => {
  assert.equal(bashWriteTarget("npm test 2>&1"), null, "fd duplication must return null");
});

test("bashWriteTarget: git log --oneline is not a write", () => {
  assert.equal(bashWriteTarget("git log --oneline"), null);
});

test("bashWriteTarget: echo hi > /dev/null is exempt", () => {
  assert.equal(bashWriteTarget("echo hi > /dev/null"), null, "/dev/ target is exempt");
});

test("bashWriteTarget: node x.js > /tmp/out.txt is exempt", () => {
  assert.equal(bashWriteTarget("node x.js > /tmp/out.txt"), null, "/tmp/ target is exempt");
});

test("bashWriteTarget: echo state > .muster/wave-active is exempt", () => {
  assert.equal(bashWriteTarget("echo state > .muster/wave-active"), null, ".muster/ target is exempt");
});

test("bashWriteTarget: npm test 2>&1 | tee /dev/stderr is exempt", () => {
  assert.equal(bashWriteTarget("npm test 2>&1 | tee /dev/stderr"), null, "tee to /dev/ is exempt");
});

// ── Bash integration tests: deny high-confidence write commands during wave ───
function bashPayload(command, cwd, extra = {}) {
  return JSON.stringify({
    tool_name: "Bash",
    tool_input: { command },
    cwd,
    ...extra,
  });
}

test("Bash: deny sed -i during active wave", async () => {
  const tmpDir = makeTmpMarker("wave-bash-1");
  try {
    const { stdout, code } = await runRaw(bashPayload("sed -i 's/a/b/' src/x.js", tmpDir));
    assert.equal(code, 0);
    const out = JSON.parse(stdout).hookSpecificOutput;
    assert.equal(out.permissionDecision, "deny", "sed -i must be denied");
    assert.match(out.permissionDecisionReason, /wave-bash-1/, "reason includes wave id");
    assert.match(out.permissionDecisionReason, /sed/, "reason names matched pattern");
  } finally {
    cleanDir(tmpDir);
  }
});

test("Bash: deny echo > file during active wave", async () => {
  const tmpDir = makeTmpMarker("wave-bash-2");
  try {
    const { stdout, code } = await runRaw(bashPayload("echo hi > src/x.js", tmpDir));
    assert.equal(code, 0);
    const out = JSON.parse(stdout).hookSpecificOutput;
    assert.equal(out.permissionDecision, "deny", "output redirect must be denied");
  } finally {
    cleanDir(tmpDir);
  }
});

test("Bash: deny cat <<EOF > config.json during active wave", async () => {
  const tmpDir = makeTmpMarker("wave-bash-3");
  try {
    const { stdout, code } = await runRaw(bashPayload("cat <<EOF > config.json", tmpDir));
    assert.equal(code, 0);
    const out = JSON.parse(stdout).hookSpecificOutput;
    assert.equal(out.permissionDecision, "deny", "heredoc redirect must be denied");
  } finally {
    cleanDir(tmpDir);
  }
});

test("Bash: deny tee to non-exempt file during active wave", async () => {
  const tmpDir = makeTmpMarker("wave-bash-4");
  try {
    const { stdout, code } = await runRaw(bashPayload("npm test | tee out.log", tmpDir));
    assert.equal(code, 0);
    const out = JSON.parse(stdout).hookSpecificOutput;
    assert.equal(out.permissionDecision, "deny", "tee to file must be denied");
  } finally {
    cleanDir(tmpDir);
  }
});

test("Bash: deny echo >> file (append) during active wave", async () => {
  const tmpDir = makeTmpMarker("wave-bash-5");
  try {
    const { stdout, code } = await runRaw(bashPayload("echo x >> README.md", tmpDir));
    assert.equal(code, 0);
    const out = JSON.parse(stdout).hookSpecificOutput;
    assert.equal(out.permissionDecision, "deny", "append redirect must be denied");
  } finally {
    cleanDir(tmpDir);
  }
});

test("Bash: allow npm test during active wave", async () => {
  const tmpDir = makeTmpMarker("wave-bash-allow-1");
  try {
    const { stdout, code } = await runRaw(bashPayload("npm test", tmpDir));
    assert.equal(code, 0);
    const out = JSON.parse(stdout).hookSpecificOutput;
    assert.ok(out.permissionDecision !== "deny", "npm test must be allowed");
  } finally {
    cleanDir(tmpDir);
  }
});

test("Bash: allow npm test 2>&1 (fd duplication) during active wave", async () => {
  const tmpDir = makeTmpMarker("wave-bash-allow-2");
  try {
    const { stdout, code } = await runRaw(bashPayload("npm test 2>&1", tmpDir));
    assert.equal(code, 0);
    const out = JSON.parse(stdout).hookSpecificOutput;
    assert.ok(out.permissionDecision !== "deny", "2>&1 must be allowed");
  } finally {
    cleanDir(tmpDir);
  }
});

test("Bash: allow git log --oneline during active wave", async () => {
  const tmpDir = makeTmpMarker("wave-bash-allow-3");
  try {
    const { stdout, code } = await runRaw(bashPayload("git log --oneline", tmpDir));
    assert.equal(code, 0);
    const out = JSON.parse(stdout).hookSpecificOutput;
    assert.ok(out.permissionDecision !== "deny", "git log must be allowed");
  } finally {
    cleanDir(tmpDir);
  }
});

test("Bash: allow echo hi > /dev/null during active wave", async () => {
  const tmpDir = makeTmpMarker("wave-bash-allow-4");
  try {
    const { stdout, code } = await runRaw(bashPayload("echo hi > /dev/null", tmpDir));
    assert.equal(code, 0);
    const out = JSON.parse(stdout).hookSpecificOutput;
    assert.ok(out.permissionDecision !== "deny", "/dev/ redirect must be allowed");
  } finally {
    cleanDir(tmpDir);
  }
});

test("Bash: allow node x.js > /tmp/out.txt during active wave", async () => {
  const tmpDir = makeTmpMarker("wave-bash-allow-5");
  try {
    const { stdout, code } = await runRaw(bashPayload("node x.js > /tmp/out.txt", tmpDir));
    assert.equal(code, 0);
    const out = JSON.parse(stdout).hookSpecificOutput;
    assert.ok(out.permissionDecision !== "deny", "/tmp/ redirect must be allowed");
  } finally {
    cleanDir(tmpDir);
  }
});

test("Bash: allow echo state > .muster/wave-active during active wave", async () => {
  const tmpDir = makeTmpMarker("wave-bash-allow-6");
  try {
    const { stdout, code } = await runRaw(bashPayload("echo state > .muster/wave-active", tmpDir));
    assert.equal(code, 0);
    const out = JSON.parse(stdout).hookSpecificOutput;
    assert.ok(out.permissionDecision !== "deny", ".muster/ redirect must be allowed");
  } finally {
    cleanDir(tmpDir);
  }
});

test("Bash: allow npm test 2>&1 | tee /dev/stderr during active wave", async () => {
  const tmpDir = makeTmpMarker("wave-bash-allow-7");
  try {
    const { stdout, code } = await runRaw(bashPayload("npm test 2>&1 | tee /dev/stderr", tmpDir));
    assert.equal(code, 0);
    const out = JSON.parse(stdout).hookSpecificOutput;
    assert.ok(out.permissionDecision !== "deny", "tee to /dev/ must be allowed");
  } finally {
    cleanDir(tmpDir);
  }
});

test("Bash: allow when agent_id present even with write command", async () => {
  const tmpDir = makeTmpMarker("wave-bash-agent");
  try {
    const { stdout, code } = await runRaw(
      bashPayload("sed -i 's/a/b/' src/x.js", tmpDir, { agent_id: "sub-xyz" }),
    );
    assert.equal(code, 0);
    const out = JSON.parse(stdout).hookSpecificOutput;
    assert.ok(out.permissionDecision !== "deny", "subagent Bash write must be allowed");
  } finally {
    cleanDir(tmpDir);
  }
});

// ── bashWriteTarget quoted-string false-positive regression tests ────────────
test("bashWriteTarget: git commit -m with > in message is not a write", () => {
  assert.equal(
    bashWriteTarget('git commit -m "msg with > arrow"'),
    null,
    "> inside double-quoted commit message must return null",
  );
});

test("bashWriteTarget: node -e with > in double-quoted expression is not a write", () => {
  assert.equal(
    bashWriteTarget('node -e "const x = a > b"'),
    null,
    "> inside double-quoted -e expression must return null",
  );
});

test("bashWriteTarget: node -e with > in single-quoted expression is not a write", () => {
  assert.equal(
    bashWriteTarget("node -e 'a > b'"),
    null,
    "> inside single-quoted -e expression must return null",
  );
});

test("Bash: deny reason names matched pattern and mentions MUSTER_WAVE_GUARD=warn", async () => {
  const tmpDir = makeTmpMarker("wave-bash-reason");
  try {
    const { stdout } = await runRaw(bashPayload("sed -i 's/x/y/' file.js", tmpDir));
    const out = JSON.parse(stdout).hookSpecificOutput;
    assert.equal(out.permissionDecision, "deny");
    assert.match(out.permissionDecisionReason, /MUSTER_WAVE_GUARD.*warn|warn.*MUSTER_WAVE_GUARD/i);
    assert.match(out.permissionDecisionReason, /sed/i);
  } finally {
    cleanDir(tmpDir);
  }
});

// ── cp/mv detection tests ──────────────────────────────────────────────────
// DENY: cp/mv to non-exempt destinations
test("bashWriteTarget: cp to non-exempt dest is a write", () => {
  assert.ok(
    bashWriteTarget("cp config.json src/config.json") !== null,
    "cp to project path should return match",
  );
});

test("bashWriteTarget: mv to non-exempt dest is a write", () => {
  assert.ok(
    bashWriteTarget("mv old.js src/new.js") !== null,
    "mv to project path should return match",
  );
});

test("bashWriteTarget: cp with flags to non-exempt dest is a write", () => {
  assert.ok(
    bashWriteTarget("cp -r a b") !== null,
    "cp -r to project path should return match",
  );
});

test("bashWriteTarget: cp multiple sources to non-exempt dest is a write", () => {
  assert.ok(
    bashWriteTarget("cp a b c dir/") !== null,
    "cp multiple sources: last arg (dir/) is the dest and should be denied",
  );
});

// ALLOW: cp/mv to exempt destinations (/tmp/, /dev/, .muster/)
test("bashWriteTarget: cp to /tmp/ is exempt", () => {
  assert.equal(
    bashWriteTarget("cp data.csv /tmp/data.csv"),
    null,
    "cp to /tmp/ must be exempt",
  );
});

test("bashWriteTarget: mv to .muster/ is exempt", () => {
  assert.equal(
    bashWriteTarget("mv x .muster/x"),
    null,
    "mv to .muster/ must be exempt",
  );
});

test("bashWriteTarget: cp to /dev/ is exempt", () => {
  assert.equal(
    bashWriteTarget("cp log.txt /dev/null"),
    null,
    "cp to /dev/ must be exempt",
  );
});

// ALLOW: ambiguous forms fail-open
test("bashWriteTarget: cp with command substitution in src is ambiguous — allow (fail-open)", () => {
  assert.equal(
    bashWriteTarget('cp "$(ls)" dst'),
    null,
    "ambiguous cp (command substitution) must fail-open and return null",
  );
});

// Integration tests: cp/mv during active wave
test("Bash: deny cp config.json src/config.json during active wave", async () => {
  const tmpDir = makeTmpMarker("wave-cp-1");
  try {
    const { stdout, code } = await runRaw(bashPayload("cp config.json src/config.json", tmpDir));
    assert.equal(code, 0);
    const out = JSON.parse(stdout).hookSpecificOutput;
    assert.equal(out.permissionDecision, "deny", "cp to project path must be denied");
    assert.match(out.permissionDecisionReason, /wave-cp-1/, "reason includes wave id");
    assert.match(out.permissionDecisionReason, /cp|mv/, "reason names the command");
  } finally {
    cleanDir(tmpDir);
  }
});

test("Bash: deny mv old.js src/new.js during active wave", async () => {
  const tmpDir = makeTmpMarker("wave-mv-1");
  try {
    const { stdout, code } = await runRaw(bashPayload("mv old.js src/new.js", tmpDir));
    assert.equal(code, 0);
    const out = JSON.parse(stdout).hookSpecificOutput;
    assert.equal(out.permissionDecision, "deny", "mv to project path must be denied");
  } finally {
    cleanDir(tmpDir);
  }
});

test("Bash: allow cp data.csv /tmp/data.csv during active wave", async () => {
  const tmpDir = makeTmpMarker("wave-cp-allow-1");
  try {
    const { stdout, code } = await runRaw(bashPayload("cp data.csv /tmp/data.csv", tmpDir));
    assert.equal(code, 0);
    const out = JSON.parse(stdout).hookSpecificOutput;
    assert.ok(out.permissionDecision !== "deny", "cp to /tmp/ must be allowed");
  } finally {
    cleanDir(tmpDir);
  }
});

test("Bash: allow mv x .muster/x during active wave", async () => {
  const tmpDir = makeTmpMarker("wave-mv-allow-1");
  try {
    const { stdout, code } = await runRaw(bashPayload("mv x .muster/x", tmpDir));
    assert.equal(code, 0);
    const out = JSON.parse(stdout).hookSpecificOutput;
    assert.ok(out.permissionDecision !== "deny", "mv to .muster/ must be allowed");
  } finally {
    cleanDir(tmpDir);
  }
});

test('Bash: allow cp "$(ls)" dst (ambiguous — fail-open) during active wave', async () => {
  const tmpDir = makeTmpMarker("wave-cp-ambig-1");
  try {
    const { stdout, code } = await runRaw(bashPayload('cp "$(ls)" dst', tmpDir));
    assert.equal(code, 0);
    const out = JSON.parse(stdout).hookSpecificOutput;
    assert.ok(out.permissionDecision !== "deny", "ambiguous cp must fail-open and be allowed");
  } finally {
    cleanDir(tmpDir);
  }
});
