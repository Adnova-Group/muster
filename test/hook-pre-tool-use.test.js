// test/hook-pre-tool-use.test.js
//
// T-no-deny: a property-style sweep over the OLD wave-guard/bash-deny fixture
// matrix (every payload that used to deny under a live .muster/wave-active
// marker) — asserting ALLOW. The wave-guard and the border counter are gone;
// pre-tool-use.js is now only the action-class fence, so every one of these
// fixtures must fall through to allow. The ONE exception (the action-class
// fence, a hard deny) is proven in hook-pre-tool-use-action-fence.test.js and
// re-asserted here as a control case so "no deny EXCEPT the action fence" is
// actually falsifiable by this sweep.

import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { writeFileSync } from "node:fs";
import os from "node:os";
import { cleanDir, makeMarker, makeRunActive, editPayload, spawnHook } from "./test-support/hook-helpers.js";
import { trackedMkdtempSync as mkdtempSync } from "../test-support/helpers.js";

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
