import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const execFileP = promisify(execFile);
const HOOK = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "plugin",
  "hooks",
  "session-start.js",
);

async function runHook(cwd) {
  // Never rejects on non-zero exit; capture both for assertions.
  // Pass empty input so the hook's readFileSync(0) returns empty string (parses
  // as {}) rather than blocking on an open pipe.
  return new Promise((resolve) => {
    const child = execFile("node", [HOOK], { cwd }, (err, stdout) => {
      resolve({ stdout: stdout ?? err?.stdout ?? "", code: err?.code ?? 0 });
    });
    child.stdin.end(""); // close stdin immediately
  });
}

// Run the hook with a stdin payload (e.g. a compact-source SessionStart event).
function runHookStdin(cwd, stdinText) {
  return new Promise((resolve) => {
    const child = execFile("node", [HOOK], { cwd }, (err, stdout) => {
      resolve({ stdout: stdout ?? err?.stdout ?? "", code: err?.code ?? 0 });
    });
    child.stdin.end(stdinText);
  });
}

test("session-start hook: Node project in git repo emits full guidance", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "muster-hook-node-"));
  await writeFile(path.join(dir, "package.json"), JSON.stringify({ name: "x" }));
  await mkdtemp(path.join(dir, ".git-")); // ensure dir exists; real .git below
  await writeFile(path.join(dir, ".git"), "gitdir: /nowhere"); // file form is fine for existsSync

  const { stdout, code } = await runHook(dir);
  assert.equal(code, 0, "exit 0");

  const parsed = JSON.parse(stdout);
  const out = parsed.hookSpecificOutput;
  assert.equal(out.hookEventName, "SessionStart");
  assert.ok(!("sessionTitle" in out), "must not override the session title");

  const ctx = out.additionalContext;
  assert.equal(typeof ctx, "string");

  // All four verbs present.
  for (const verb of ["run", "autopilot", "diagnose", "audit"]) {
    assert.match(ctx, new RegExp(verb), `mentions ${verb}`);
  }
  // At least one principle keyword.
  assert.match(ctx, /TDD|verify|glass-box/i, "has a principle keyword");
  // Node/JS detection mention.
  assert.match(ctx, /Node|JS|JavaScript/i, "detects Node project");
});

test("session-start hook: empty dir still emits valid JSON, no recognized project", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "muster-hook-empty-"));

  const { stdout, code } = await runHook(dir);
  assert.equal(code, 0, "exit 0");

  const parsed = JSON.parse(stdout);
  const out = parsed.hookSpecificOutput;
  assert.equal(out.hookEventName, "SessionStart");

  assert.match(
    out.additionalContext,
    /No recognized project/i,
    "indicates no recognized project",
  );
});

test("session-start hook: output is parseable JSON and exit 0 in both cases (fail-safe)", async () => {
  const nodeDir = await mkdtemp(path.join(tmpdir(), "muster-hook-n2-"));
  await writeFile(path.join(nodeDir, "package.json"), "{}");
  const emptyDir = await mkdtemp(path.join(tmpdir(), "muster-hook-e2-"));

  for (const dir of [nodeDir, emptyDir]) {
    const { stdout, code } = await runHook(dir);
    assert.equal(code, 0);
    assert.doesNotThrow(() => JSON.parse(stdout), "stdout is valid JSON");
  }
});

test("session-start hook: emits full payload on a compact-source event (backstop)", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "muster-hook-compact-"));
  await writeFile(path.join(dir, "package.json"), "{}");

  const { stdout, code } = await runHookStdin(
    dir,
    JSON.stringify({ source: "compact", session_id: "x" }),
  );
  assert.equal(code, 0, "exit 0");

  const ctx = JSON.parse(stdout).hookSpecificOutput.additionalContext;
  assert.match(ctx, /muster principles:/, "full principles present after compact");
  for (const verb of ["run", "autopilot", "diagnose", "audit"]) {
    assert.match(ctx, new RegExp(verb), `mentions ${verb}`);
  }
});
