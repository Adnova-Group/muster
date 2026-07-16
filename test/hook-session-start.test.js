import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { cumFile, readCum, directiveFile } from "../plugin/hooks/inline-budget.js";

const HOOK = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "plugin",
  "hooks",
  "session-start.js",
);

async function runHook(cwd) {
  // Never rejects on non-zero exit; capture both for assertions.
  return new Promise((resolve) => {
    const child = execFile("node", [HOOK], { cwd }, (err, stdout) => {
      resolve({ stdout: stdout ?? err?.stdout ?? "", code: err?.code ?? 0 });
    });
    child.stdin.end(""); // close stdin immediately
  });
}

function runHookStdin(cwd, stdinText) {
  return new Promise((resolve) => {
    const child = execFile("node", [HOOK], { cwd }, (err, stdout) => {
      resolve({ stdout: stdout ?? err?.stdout ?? "", code: err?.code ?? 0 });
    });
    child.stdin.end(stdinText);
  });
}

// ── T-session-start: trimmed one-line pointer ───────────────────────────────

test("session-start hook: emits the one-line pointer, not the old full-payload guidance", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "muster-hook-node-"));
  await writeFile(path.join(dir, "package.json"), JSON.stringify({ name: "x" }));

  const { stdout, code } = await runHook(dir);
  assert.equal(code, 0, "exit 0");

  const parsed = JSON.parse(stdout);
  const out = parsed.hookSpecificOutput;
  assert.equal(out.hookEventName, "SessionStart");
  assert.ok(!("sessionTitle" in out), "must not override the session title");

  const ctx = out.additionalContext;
  assert.equal(typeof ctx, "string");
  assert.match(ctx, /muster available/i, "one-line pointer names muster");
  assert.match(ctx, /\/muster:plan\b/, "one-line pointer names the orchestration-scale verb");

  // The old full-payload content (principles, all seven verbs, project sniff)
  // is gone — the context is now exactly the one-line pointer.
  assert.doesNotMatch(ctx, /muster principles:/i, "no full principles payload");
  assert.doesNotMatch(ctx, /TDD|glass-box/i, "no principle keywords");
  assert.doesNotMatch(ctx, /Node project|Python project|Go project|Rust project/i, "no project-sniff text");
});

test("session-start hook: output is parseable JSON and exit 0 (fail-safe)", async () => {
  const nodeDir = await mkdtemp(path.join(tmpdir(), "muster-hook-n2-"));
  await writeFile(path.join(nodeDir, "package.json"), "{}");
  const emptyDir = await mkdtemp(path.join(tmpdir(), "muster-hook-e2-"));

  for (const dir of [nodeDir, emptyDir]) {
    const { stdout, code } = await runHook(dir);
    assert.equal(code, 0);
    assert.doesNotThrow(() => JSON.parse(stdout), "stdout is valid JSON");
    const ctx = JSON.parse(stdout).hookSpecificOutput.additionalContext;
    assert.match(ctx, /muster available/i, "one-line pointer present regardless of project type");
  }
});

test("session-start hook: emits the same one-line pointer on a compact-source event", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "muster-hook-compact-"));
  await writeFile(path.join(dir, "package.json"), "{}");

  const { stdout, code } = await runHookStdin(
    dir,
    JSON.stringify({ source: "compact", session_id: "x" }),
  );
  assert.equal(code, 0, "exit 0");

  const ctx = JSON.parse(stdout).hookSpecificOutput.additionalContext;
  assert.match(ctx, /muster available/i, "one-line pointer present after compact too");
});

// ── cumulative cross-turn drift counter is reset on SessionStart ───────────
test("session-start hook: resets the cumulative cross-turn drift counter for the session", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "muster-hook-cum-"));
  const sid = "ss-cum-1";
  const cFile = cumFile(sid, tmpdir());
  await writeFile(cFile, JSON.stringify({ files: ["a.js", "b.js"], nudged: true }));
  try {
    const { code } = await runHookStdin(
      dir,
      JSON.stringify({ source: "startup", session_id: sid, cwd: dir }),
    );
    assert.equal(code, 0, "exit 0");
    assert.deepEqual(
      readCum(cFile),
      { files: [], nudged: false },
      "cumulative drift counter reset on SessionStart",
    );
  } finally {
    await rm(cFile, { force: true });
  }
});

test("session-start hook: the cumulative drift counter SURVIVES a compact-source event", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "muster-hook-cum2-"));
  const sid = "ss-cum-2";
  const cFile = cumFile(sid, tmpdir());
  const seeded = { files: ["a.js", "b.js", "c.js"], nudged: true };
  await writeFile(cFile, JSON.stringify(seeded));
  try {
    const { code } = await runHookStdin(
      dir,
      JSON.stringify({ source: "compact", session_id: sid, cwd: dir }),
    );
    assert.equal(code, 0, "exit 0");
    assert.deepEqual(
      readCum(cFile),
      seeded,
      "cumulative drift counter survives compact (mid-run; long drifting sessions are the ones that auto-compact)",
    );
  } finally {
    await rm(cFile, { force: true });
  }
});

test("session-start hook: resets the cumulative drift counter on a clear-source event", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "muster-hook-cum3-"));
  const sid = "ss-cum-3";
  const cFile = cumFile(sid, tmpdir());
  await writeFile(cFile, JSON.stringify({ files: ["a.js", "b.js"], nudged: true }));
  try {
    const { code } = await runHookStdin(
      dir,
      JSON.stringify({ source: "clear", session_id: sid, cwd: dir }),
    );
    assert.equal(code, 0, "exit 0");
    assert.deepEqual(
      readCum(cFile),
      { files: [], nudged: false },
      "cumulative drift counter reset on clear (fresh-start semantics)",
    );
  } finally {
    await rm(cFile, { force: true });
  }
});

// ── once-per-crossing directive marker lifecycle ────────────────────────────

test("session-start hook: clears the once-per-crossing directive marker on a clear-source event", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "muster-hook-dir1-"));
  const sid = "ss-dir-1";
  const dFile = directiveFile(sid, tmpdir());
  await writeFile(dFile, "1");
  try {
    const { code } = await runHookStdin(
      dir,
      JSON.stringify({ source: "clear", session_id: sid, cwd: dir }),
    );
    assert.equal(code, 0, "exit 0");
    assert.ok(!existsSync(dFile), "directive marker removed on clear (fresh session re-arms the nudge)");
  } finally {
    await rm(dFile, { force: true });
  }
});

test("session-start hook: the once-per-crossing directive marker SURVIVES a compact-source event", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "muster-hook-dir2-"));
  const sid = "ss-dir-2";
  const dFile = directiveFile(sid, tmpdir());
  await writeFile(dFile, "1");
  try {
    const { code } = await runHookStdin(
      dir,
      JSON.stringify({ source: "compact", session_id: sid, cwd: dir }),
    );
    assert.equal(code, 0, "exit 0");
    assert.ok(existsSync(dFile), "directive marker survives compact (mid-session, already nudged this crossing)");
  } finally {
    await rm(dFile, { force: true });
  }
});
