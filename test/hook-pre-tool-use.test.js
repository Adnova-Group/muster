// test/hook-pre-tool-use.test.js
//
// Two unrelated concerns share this file:
//   1. bashWriteTarget() pure-function unit tests — bash-write-target.js is
//      unchanged by the enforcement-model redesign; it is still imported by
//      pre-tool-use.js to key the border-invitation's cumulative counter for
//      high-confidence Bash file writes (see hook-pre-tool-use-scale.test.js),
//      it just no longer backs any deny path.
//   2. T-no-deny: a property-style sweep over the OLD wave-guard/bash-deny
//      fixture matrix (every payload that used to deny under a live
//      .muster/wave-active marker) — now asserting ALLOW. This is the
//      replacement coverage for the deleted wave-guard integration tests
//      (deny during active wave, GUARD-SCOPE-during-wave, waveId
//      sanitization, denyBash sanitization, etc.) — the wave-guard is gone,
//      so every one of those fixtures must now fall through to allow. The
//      ONE exception (the action-class fence, still a hard deny) is proven
//      separately in hook-pre-tool-use-action-fence.test.js and re-asserted
//      here as a control case so "no deny EXCEPT the action fence" is
//      actually falsifiable by this sweep.

import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { mkdtempSync, writeFileSync } from "node:fs";
import { bashWriteTarget } from "../plugin/hooks/bash-write-target.js";
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

function decision(stdout) {
  return JSON.parse(stdout).hookSpecificOutput.permissionDecision;
}

// ── bashWriteTarget pure-function unit tests ──────────────────────────────────
// DENY-shaped cases (bashWriteTarget itself still classifies these as writes —
// only the hook-level deny path built on top of it is gone).
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

// ── cp/mv detection tests ──────────────────────────────────────────────────
test("bashWriteTarget: cp to non-exempt dest is a write", () => {
  assert.ok(bashWriteTarget("cp config.json src/config.json") !== null, "cp to project path should return match");
});

test("bashWriteTarget: mv to non-exempt dest is a write", () => {
  assert.ok(bashWriteTarget("mv old.js src/new.js") !== null, "mv to project path should return match");
});

test("bashWriteTarget: cp with flags to non-exempt dest is a write", () => {
  assert.ok(bashWriteTarget("cp -r a b") !== null, "cp -r to project path should return match");
});

test("bashWriteTarget: cp multiple sources to non-exempt dest is a write", () => {
  assert.ok(
    bashWriteTarget("cp a b c dir/") !== null,
    "cp multiple sources: last arg (dir/) is the dest and should be denied",
  );
});

test("bashWriteTarget: cp to /tmp/ is exempt", () => {
  assert.equal(bashWriteTarget("cp data.csv /tmp/data.csv"), null, "cp to /tmp/ must be exempt");
});

test("bashWriteTarget: mv to .muster/ is exempt", () => {
  assert.equal(bashWriteTarget("mv x .muster/x"), null, "mv to .muster/ must be exempt");
});

test("bashWriteTarget: cp to /dev/ is exempt", () => {
  assert.equal(bashWriteTarget("cp log.txt /dev/null"), null, "cp to /dev/ must be exempt");
});

test("bashWriteTarget: cp with command substitution in src is ambiguous — allow (fail-open)", () => {
  assert.equal(
    bashWriteTarget('cp "$(ls)" dst'),
    null,
    "ambiguous cp (command substitution) must fail-open and return null",
  );
});

// ── path-traversal fix — normalize target before EXEMPT_TARGET_RE.test ──────
test("bashWriteTarget: tee .muster/../app.js is NOT exempt (path traversal)", () => {
  assert.ok(
    bashWriteTarget("tee .muster/../app.js") !== null,
    ".muster/../app.js normalizes to app.js which is not under .muster/ — must be denied",
  );
});

test("bashWriteTarget: echo x > .muster/../app.js is NOT exempt (path traversal)", () => {
  assert.ok(
    bashWriteTarget("echo x > .muster/../app.js") !== null,
    ".muster/../app.js redirect must not be exempt after normalization",
  );
});

test("bashWriteTarget: cp src .muster/../app.js is NOT exempt (path traversal)", () => {
  assert.ok(
    bashWriteTarget("cp src .muster/../app.js") !== null,
    "cp to .muster/../app.js must not be exempt after normalization",
  );
});

test("bashWriteTarget: .muster/wave-active remains exempt after normalize", () => {
  assert.equal(
    bashWriteTarget("echo state > .muster/wave-active"),
    null,
    ".muster/wave-active has no traversal — must still be exempt",
  );
});

test("bashWriteTarget: /tmp/x remains exempt after normalize", () => {
  assert.equal(bashWriteTarget("echo x > /tmp/x"), null, "/tmp/x must remain exempt");
});

// ── ANSI-C / subshell / sed long-form hardening (still pure-function truths) ─
test("bashWriteTarget: tee with ANSI-C hex escape in exempt prefix is denied", () => {
  assert.ok(
    bashWriteTarget("tee /tmp/$'\\x2e\\x2e\\x2fetc\\x2fpasswd'") !== null,
    "tee target containing $' (ANSI-C escape) inside exempt prefix must be denied",
  );
});

test("bashWriteTarget: redirect to $'...' embedded in exempt prefix is denied", () => {
  assert.ok(
    bashWriteTarget("node x > /tmp/$'\\x2e\\x2e\\x2fetc\\x2fpasswd'") !== null,
    "redirect to ANSI-C escape embedded in exempt prefix must be denied",
  );
});

test('bashWriteTarget: sed -i"" double-quote suffix is a write', () => {
  assert.ok(
    bashWriteTarget('sed -i"" \'s/a/b/\' file.js') !== null,
    'sed -i"" (BSD/GNU empty backup extension) must be detected as a write',
  );
});

test("bashWriteTarget: sed --in-place long form is a write", () => {
  assert.ok(bashWriteTarget("sed --in-place 's/a/b/' file.js") !== null, "sed --in-place must be detected as a write");
});

test("bashWriteTarget: sed --in-place=.bak is a write", () => {
  assert.ok(
    bashWriteTarget("sed --in-place=.bak 's/a/b/' file.js") !== null,
    "sed --in-place=.bak must be detected as a write",
  );
});

test("bashWriteTarget: tee /dev/null evil.js — second non-exempt target must be denied", () => {
  assert.ok(
    bashWriteTarget("tee /dev/null evil.js") !== null,
    "tee with a second non-exempt target must be denied even when first is exempt",
  );
});

test("bashWriteTarget: tee with $( subshell in exempt-prefix path is denied", () => {
  assert.ok(
    bashWriteTarget("npm test | tee /tmp/$(cp src dst)") !== null,
    "tee target containing $( (subshell) inside exempt prefix must be denied",
  );
});

test("bashWriteTarget: plain $VAR in exempt redirect target is denied (fail-closed)", () => {
  assert.equal(
    bashWriteTarget("node cmd > /tmp/$SESSION_ID"),
    "> /tmp/$SESSION_ID",
    "plain $VAR in /tmp/ redirect must be denied (unresolvable variable, fail-closed)",
  );
});

test("bashWriteTarget: redirect with $( subshell in exempt prefix is denied", () => {
  assert.ok(
    bashWriteTarget("node x > /tmp/$(cp a b)") !== null,
    "redirect target containing $( (command substitution) in exempt prefix must be denied",
  );
});

// ── T-no-deny: the wave-guard is gone — the OLD deny fixture matrix now allows ─
// Every payload below used to trigger a hard DENY from the (deleted) wave-guard
// while .muster/wave-active was present. This sweep runs the identical fixture
// set against the rewritten hook and asserts none of them denies — coverage
// REPLACING the deleted wave-guard integration tests, not silently dropping it.

function makeWaveDir(waveId = "wave-sweep") {
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), "muster-nodeny-test-"));
  makeMarker(tmpDir, waveId);
  makeRunActive(tmpDir); // the strongest possible old-deny precondition
  return tmpDir;
}

function bashPayload(command, cwd, extra = {}) {
  return JSON.stringify({ tool_name: "Bash", tool_input: { command }, cwd, ...extra });
}

test("T-no-deny: Edit to an in-cwd file, live wave-active + run-active present -> allowed", async () => {
  const tmpDir = makeWaveDir();
  try {
    const { stdout, code } = await runRaw(editPayload(path.join(tmpDir, "src", "foo.js"), tmpDir));
    assert.equal(code, 0);
    assert.notEqual(decision(stdout), "deny");
  } finally {
    cleanDir(tmpDir);
  }
});

test("T-no-deny: Write to an in-cwd file, live wave-active + run-active present -> allowed", async () => {
  const tmpDir = makeWaveDir();
  try {
    const { stdout, code } = await runRaw(
      JSON.stringify({ tool_name: "Write", tool_input: { file_path: path.join(tmpDir, "src", "new.js") }, cwd: tmpDir }),
    );
    assert.equal(code, 0);
    assert.notEqual(decision(stdout), "deny");
  } finally {
    cleanDir(tmpDir);
  }
});

test("T-no-deny: NotebookEdit to an in-cwd notebook, live wave-active + run-active present -> allowed", async () => {
  const tmpDir = makeWaveDir();
  try {
    const { stdout, code } = await runRaw(
      JSON.stringify({
        tool_name: "NotebookEdit",
        tool_input: { notebook_path: path.join(tmpDir, "notebook.ipynb") },
        cwd: tmpDir,
      }),
    );
    assert.equal(code, 0);
    assert.notEqual(decision(stdout), "deny");
  } finally {
    cleanDir(tmpDir);
  }
});

const SWEEP_BASH_COMMANDS = [
  "sed -i 's/a/b/' src/x.js",
  "echo hi > src/x.js",
  "cat <<EOF > config.json",
  "npm test | tee out.log",
  "echo x >> README.md",
  "cp config.json src/config.json",
  "mv old.js src/new.js",
  "tee /dev/null evil.js",
  "npm test | tee /tmp/$(cp src dst)",
  "node cmd > /tmp/$SESSION_ID",
  "sed --in-place 's/a/b/' file.js",
  "echo hi > " + "A".repeat(300) + "\x00\x01\x1f\x7fevil",
];

for (const command of SWEEP_BASH_COMMANDS) {
  test(`T-no-deny: Bash "${command.slice(0, 40)}..." with live wave-active + run-active present -> allowed`, async () => {
    const tmpDir = makeWaveDir();
    try {
      const { stdout, code } = await runRaw(bashPayload(command, tmpDir));
      assert.equal(code, 0);
      assert.notEqual(decision(stdout), "deny", `command must not deny: ${command}`);
    } finally {
      cleanDir(tmpDir);
    }
  });
}

test("T-no-deny: agent_id subagent Bash write is allowed regardless of markers", async () => {
  const tmpDir = makeWaveDir();
  try {
    const { stdout, code } = await runRaw(
      bashPayload("sed -i 's/a/b/' src/x.js", tmpDir, { agent_id: "sub-xyz" }),
    );
    assert.equal(code, 0);
    assert.notEqual(decision(stdout), "deny");
  } finally {
    cleanDir(tmpDir);
  }
});

test("T-no-deny: mcp send-named tool with no forbidden-actions configured is allowed even mid-wave", async () => {
  const tmpDir = makeWaveDir();
  try {
    const { stdout, code } = await runRaw(
      JSON.stringify({ tool_name: "mcp__gmail__send_email", tool_input: {}, cwd: tmpDir }),
    );
    assert.equal(code, 0);
    assert.notEqual(decision(stdout), "deny");
  } finally {
    cleanDir(tmpDir);
  }
});

test("T-no-deny: garbled stdin is a silent allow, valid JSON, exit 0 (fail-safe)", async () => {
  const { stdout, code } = await runRaw("not valid json {{{{");
  assert.equal(code, 0, "exit 0 on garbled stdin");
  assert.doesNotThrow(() => JSON.parse(stdout), "stdout must be valid JSON");
  assert.notEqual(decision(stdout), "deny");
});

// ── control case: the action-class fence is the ONE exception, and it still denies ─
test("control: the action-class fence still denies (the one exception to T-no-deny)", async () => {
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), "muster-nodeny-fence-"));
  makeRunActive(tmpDir);
  writeFileSync(path.join(tmpDir, ".muster", "forbidden-actions"), "publish");
  try {
    const { stdout, code } = await runRaw(bashPayload("npm publish", tmpDir));
    assert.equal(code, 0);
    assert.equal(decision(stdout), "deny", "action-class fence is still a hard deny");
  } finally {
    cleanDir(tmpDir);
  }
});
