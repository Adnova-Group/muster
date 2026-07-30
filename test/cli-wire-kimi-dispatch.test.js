/**
 * CLI wire-format integration tests for the harness-native dispatch packet +
 * session receipt verbs (audit 2026-07-29, slice E):
 *
 *   kimi-goal-invocation   -> src/kimi-dispatch.js's kimiGoalInvocation
 *   kimi-process-dispatch  -> src/kimi-dispatch.js's kimiProcessDispatch
 *   kimi-session-usage     -> src/kimi-receipts.js's captureSessionId /
 *                             resolveSessionForCwd / readSessionUsage
 *   kimi-summarize-receipts -> src/kimi-receipts.js's summarizeItemReceipts
 *   codex-spawn-packet     -> src/wave-dispatch.js's codexSpawnAgentCall
 *   codex-wait-packet      -> src/wave-dispatch.js's codexWaitAgentCall
 *
 * These verbs are the ONLY path by which the model layer reaches those
 * builders (the two-layer boundary): the prose commands/reference files name
 * `$MUSTER_CLI <verb>` invocations, and these tests pin the exact JSON shapes
 * that prose depends on.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";
import { writeFile, mkdir, readFile, rm, symlink, cp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { trackedMkdtemp as mkdtemp } from "../test-support/helpers.js";

const pexecFile = promisify(execFile);

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..");
const CLI = join(REPO_ROOT, "src/cli.js");

const FIXTURE_SESSION = join(REPO_ROOT, "test", "fixtures", "kimi-session-usage");
const FIXTURE_STDOUT = join(REPO_ROOT, "test", "fixtures", "kimi-stream-stdout.jsonl");
const CAPTURED_ID = "session_fb2161ac-ff97-40f2-9f2c-dd60f5e84c5f";

function run(args, options = {}) {
  return pexecFile(process.execPath, [CLI, ...args], { cwd: REPO_ROOT, ...options });
}

// A rejection helper: the command must exit nonzero with the expected stderr.
async function fails(args, pattern, options = {}) {
  await assert.rejects(
    run(args, options),
    (err) => {
      assert.match(err.stderr, pattern);
      return true;
    }
  );
}

// ---------------------------------------------------------------------------
// kimi-goal-invocation
// ---------------------------------------------------------------------------

test("cli wire: kimi-goal-invocation prints the argv+env descriptor, stream-json opt-in", async () => {
  const plain = JSON.parse((await run(["kimi-goal-invocation", "Ship the feature with tests green"])).stdout);
  assert.deepEqual(plain.argv, ["-p", "/goal Ship the feature with tests green", "-m", "kimi-code/k3"]);
  assert.equal(plain.env.KIMI_CODE_EXPERIMENTAL_FLAG, "1");
  assert.ok(plain.env.KIMI_SECONDARY_MODEL, "the lane bind rides the env pair");
  assert.deepEqual(plain.exitCodes, { complete: 0, blocked: 3, paused: 6 });

  const streamed = JSON.parse((await run(["kimi-goal-invocation", "Ship it", "--stream-json"])).stdout);
  assert.deepEqual(streamed.argv, ["-p", "/goal Ship it", "--output-format", "stream-json", "-m", "kimi-code/k3"]);

  const secondary = JSON.parse((await run(["kimi-goal-invocation", "Ship it", "--secondary", "kimi-code/k3"])).stdout);
  assert.equal(secondary.env.KIMI_SECONDARY_MODEL, "kimi-code/k3");
});

test("cli wire: kimi-goal-invocation fails loud on a missing or /goal-prefixed objective", async () => {
  await fails(["kimi-goal-invocation"], /kimi-goal-invocation <objective>.*missing objective/);
  await fails(["kimi-goal-invocation", "/goal already prefixed"], /pass the bare objective/);
});

// ---------------------------------------------------------------------------
// kimi-process-dispatch
// ---------------------------------------------------------------------------

test("cli wire: kimi-process-dispatch prints the headless -p descriptor, -m ALWAYS emitted", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "muster-kimi-wire-dispatch-"));
  const agentFile = join(cwd, "worker.md");
  await writeFile(agentFile, "---\nname: worker\n---\n");
  for (const [lane, model] of [["primary", "kimi-code/k3"], ["secondary", "kimi-code/kimi-for-coding"]]) {
    const d = JSON.parse((await run([
      "kimi-process-dispatch", "--brief", "Implement the feature.", "--agent-file", agentFile, "--cwd", cwd, "--lane", lane,
    ])).stdout);
    assert.deepEqual(d.argv, ["-p", "Implement the feature.", "--agent-file", agentFile, "--output-format", "stream-json", "-m", model]);
    assert.equal(d.env.KIMI_CODE_EXPERIMENTAL_FLAG, "1");
    assert.equal(d.cwd, cwd);
    assert.equal(d.lane, lane);
  }
});

test("cli wire: kimi-process-dispatch resolves a bare agent-file name under KIMI_CODE_HOME", async () => {
  const home = await mkdtemp(join(tmpdir(), "muster-kimi-wire-home-"));
  await mkdir(join(home, "agents"), { recursive: true });
  await writeFile(join(home, "agents", "muster-builder.md"), "---\nname: muster-builder\n---\n");
  const cwd = await mkdtemp(join(tmpdir(), "muster-kimi-wire-cwd-"));
  const d = JSON.parse((await run(
    ["kimi-process-dispatch", "--brief", "b", "--agent-file", "muster-builder.md", "--cwd", cwd, "--lane", "primary"],
    { env: { ...process.env, KIMI_CODE_HOME: home } }
  )).stdout);
  assert.deepEqual(d.argv.slice(2, 4), ["--agent-file", join(home, "agents", "muster-builder.md")]);
});

test("cli wire: kimi-process-dispatch fails loud on missing/invalid args", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "muster-kimi-wire-fail-"));
  const agentFile = join(cwd, "worker.md");
  await writeFile(agentFile, "---\nname: worker\n---\n");
  await fails(["kimi-process-dispatch", "--agent-file", agentFile, "--cwd", cwd, "--lane", "primary"], /missing --brief/);
  await fails(["kimi-process-dispatch", "--brief", "b", "--cwd", cwd, "--lane", "primary"], /missing --agent-file/);
  await fails(["kimi-process-dispatch", "--brief", "b", "--agent-file", agentFile, "--lane", "primary"], /missing --cwd/);
  await fails(["kimi-process-dispatch", "--brief", "b", "--agent-file", agentFile, "--cwd", cwd], /missing --lane/);
  await fails(["kimi-process-dispatch", "--brief", "b", "--agent-file", agentFile, "--cwd", cwd, "--lane", "k3"], /lane is required and must be one of primary\|secondary/);
  await fails(["kimi-process-dispatch", "--brief", "b", "--agent-file", agentFile, "--cwd", join(cwd, "nope"), "--lane", "primary"], /cwd must be an existing directory/);
});

// ---------------------------------------------------------------------------
// kimi-session-usage
// ---------------------------------------------------------------------------

test("cli wire: kimi-session-usage --session-dir reads a known session's usage", async () => {
  const usage = JSON.parse((await run(["kimi-session-usage", "--session-dir", FIXTURE_SESSION])).stdout);
  assert.equal(usage.sessionDir, FIXTURE_SESSION);
  assert.ok(usage.agents.main, "the main agent's usage is present");
  assert.ok(usage.dispatches["agent-0"], "the sub agent surfaces in the dispatches view");
  assert.equal(typeof usage.total.total, "number");
});

// One temp root laid out the way kimi lays out its home: session_index.jsonl at
// the root, the session tree under it (a copy of the real capture, so the usage
// numbers stay real). A resolved sessionDir is contained against THIS root, so a
// test that parked the session tree in an unrelated part of the filesystem would
// be exercising the planted-entry shape, not a legitimate flow.
async function indexRoot(prefix) {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  const sessionDir = join(dir, "sessions", "wd_repo_leg", "session_leg");
  await mkdir(dirname(sessionDir), { recursive: true });
  await cp(FIXTURE_SESSION, sessionDir, { recursive: true });
  return { dir, indexPath: join(dir, "session_index.jsonl"), sessionDir };
}

test("cli wire: kimi-session-usage --cwd resolves via the captured stdout id, then reads usage", async () => {
  // The run root is process.cwd() and every file arg must resolve inside it
  // (the slice-B containment), so the leg's files live in one temp run root.
  const { dir, indexPath, sessionDir } = await indexRoot("muster-kimi-wire-cwd-");
  const stdoutFile = join(dir, "stdout.jsonl");
  await writeFile(stdoutFile, await readFile(FIXTURE_STDOUT, "utf8"));
  await writeFile(indexPath, JSON.stringify({ sessionId: CAPTURED_ID, sessionDir, workDir: "/repo/other" }) + "\n");
  const result = JSON.parse((await run([
    "kimi-session-usage", "--cwd", "/repo/leg", "--stdout-file", stdoutFile, "--index", indexPath,
  ], { cwd: dir })).stdout);
  assert.deepEqual(result.resolution, {
    resolved: true, sessionId: CAPTURED_ID, sessionDir, source: "captured",
  });
  assert.ok(result.usage.total.total > 0, "usage rides the resolved session dir");
});

test("cli wire: kimi-session-usage --cwd falls back to the index, and UNKNOWN exits 0", async () => {
  const { dir, indexPath, sessionDir } = await indexRoot("muster-kimi-wire-index-arm-");
  await writeFile(indexPath, JSON.stringify({ sessionId: "session_leg", sessionDir, workDir: "/repo/leg" }) + "\n");
  const resolved = JSON.parse((await run(["kimi-session-usage", "--cwd", "/repo/leg", "--index", indexPath], { cwd: dir })).stdout);
  assert.equal(resolved.resolution.source, "index-unique");
  assert.equal(resolved.resolution.sessionId, "session_leg");

  const unknown = JSON.parse((await run(["kimi-session-usage", "--cwd", "/repo/nothing", "--index", indexPath], { cwd: dir })).stdout);
  assert.deepEqual(unknown, { resolution: { resolved: false, reason: "no-sessions-for-cwd", candidates: [] } });
});

test("cli wire: kimi-session-usage fails loud on missing or conflicting arm flags", async () => {
  await fails(["kimi-session-usage"], /missing --session-dir or --cwd/);
  await fails(
    ["kimi-session-usage", "--session-dir", FIXTURE_SESSION, "--cwd", "/repo/leg"],
    /mutually exclusive/
  );
});

// ---------------------------------------------------------------------------
// kimi-summarize-receipts
// ---------------------------------------------------------------------------

test("cli wire: kimi-summarize-receipts prints one line per item, UNKNOWN as a line", async () => {
  const dir = await mkdtemp(join(tmpdir(), "muster-kimi-wire-summary-"));
  const itemsFile = join(dir, "items.json");
  await writeFile(itemsFile, JSON.stringify([
    { itemId: "item-1", resolution: { resolved: true, sessionId: CAPTURED_ID, sessionDir: FIXTURE_SESSION, source: "captured" } },
    { itemId: "item-2", resolution: { resolved: false, reason: "ambiguous-tie", candidates: ["a", "b"] } },
  ]));
  const { stdout } = await run(["kimi-summarize-receipts", itemsFile], { cwd: dir });
  const lines = stdout.trim().split("\n");
  assert.equal(lines.length, 2);
  assert.match(lines[0], /^item-1: session=kimi-session-usage source=captured total=\d+ in=\d+ out=\d+ cache-read=\d+ cache-create=\d+ records=\d+ dispatches: /);
  assert.equal(lines[1], "item-2: UNKNOWN (ambiguous-tie)");
});

test("cli wire: kimi-summarize-receipts fails loud on a missing file or non-array input", async () => {
  await fails(["kimi-summarize-receipts"], /kimi-summarize-receipts <items.json>: missing items file/);
  const dir = await mkdtemp(join(tmpdir(), "muster-kimi-wire-summary-bad-"));
  const badFile = join(dir, "bad.json");
  await writeFile(badFile, JSON.stringify({ not: "an array" }));
  await fails(["kimi-summarize-receipts", badFile], /summarizeItemReceipts: items must be an array/, { cwd: dir });
});

// ---------------------------------------------------------------------------
// codex-spawn-packet
// ---------------------------------------------------------------------------

test("cli wire: codex-spawn-packet fails closed to the v1 shape without --version", async () => {
  const packet = JSON.parse((await run([
    "codex-spawn-packet", "--task-id", "task-1", "--agent-type", "muster-builder", "--message", "Do the thing",
  ])).stdout);
  assert.deepEqual(packet, {
    tool: "multi_agent_v1.spawn_agent",
    message: "Do the thing",
    fork_context: false,
    agent_type: "muster-builder",
  });
});

test("cli wire: codex-spawn-packet --version v2 prints the collaboration shape with STRING fork_turns", async () => {
  const packet = JSON.parse((await run([
    "codex-spawn-packet", "--task-id", "task-1", "--agent-type", "muster-builder", "--version", "v2", "--fork-turns", "3",
  ])).stdout);
  assert.deepEqual(packet, {
    tool: "collaboration.spawn_agent",
    task_name: "task-1",
    message: "",
    fork_turns: "3",
    agent_type: "muster-builder",
  });
});

test("cli wire: codex-spawn-packet --message-file reads the brief from disk; the two message arms conflict", async () => {
  const dir = await mkdtemp(join(tmpdir(), "muster-codex-wire-spawn-"));
  const briefFile = join(dir, "brief.md");
  await writeFile(briefFile, "Build the wave task.\n");
  const packet = JSON.parse((await run([
    "codex-spawn-packet", "--task-id", "task-1", "--agent-type", "muster-builder", "--message-file", briefFile,
  ], { cwd: dir })).stdout);
  assert.equal(packet.message, "Build the wave task.\n");
  await fails([
    "codex-spawn-packet", "--task-id", "task-1", "--agent-type", "muster-builder", "--message", "x", "--message-file", briefFile,
  ], /mutually exclusive/);
});

test("cli wire: codex-spawn-packet fails loud on missing args, a bad version, or fork_turns \"all\"", async () => {
  await fails(["codex-spawn-packet", "--agent-type", "muster-builder"], /missing --task-id/);
  await fails(["codex-spawn-packet", "--task-id", "task-1"], /missing --agent-type/);
  await fails(["codex-spawn-packet", "--task-id", "task-1", "--agent-type", "muster-builder", "--version", "v3"], /unknown multi_agent_version/);
  await fails(["codex-spawn-packet", "--task-id", "task-1", "--agent-type", "muster-builder", "--version", "v2", "--fork-turns", "all"], /full-history fork/);
});

test("cli wire: codex-spawn-packet --version v1 --fork-turns fails loud -- v1 has no fork_turns to send", async () => {
  // v1 takes fork_context, not fork_turns: silently dropping the flag would
  // print a packet the caller believes forks N turns but forks none.
  await fails(
    ["codex-spawn-packet", "--task-id", "task-1", "--agent-type", "muster-builder", "--version", "v1", "--fork-turns", "3"],
    /fork_turns is v2-only/
  );
});

// ---------------------------------------------------------------------------
// file-arg containment (the slice-B convention on the new verbs)
// ---------------------------------------------------------------------------
// Every file-arg READ in these verbs resolves through resolveContainedRealpath
// against the run root (process.cwd()) before reading -- the same discipline
// the sprint-waves branch carries (test/fs-safe.test.js). A planted symlink
// (.muster/brief.md -> ~/.ssh/id_rsa) fails with the named refusal, never a
// read; --message-file is the worst case because its contents are ECHOED into
// the printed packet JSON.

// Plant `name` inside `dir` as a symlink to a file OUTSIDE the run root.
async function plantEscape(dir, name, contents = "TOPSECRET-target-contents\n") {
  const outside = join(tmpdir(), `muster-wire-outside-${process.pid}-${name}`);
  await writeFile(outside, contents);
  await symlink(outside, join(dir, name));
  return outside;
}

test("cli wire: codex-spawn-packet --message-file refuses a symlink escaping the run root -- contents never echoed", async () => {
  const dir = await mkdtemp(join(tmpdir(), "muster-codex-wire-symlink-"));
  const outside = await plantEscape(dir, "brief.md");
  try {
    await assert.rejects(
      run(["codex-spawn-packet", "--task-id", "task-1", "--agent-type", "muster-builder", "--message-file", "brief.md"], { cwd: dir }),
      (err) => {
        assert.match(err.stderr, /contained under the run root/);
        assert.ok(!String(err.stdout).includes("TOPSECRET"), "the symlink target's contents must never be echoed into the printed packet");
        return true;
      }
    );
  } finally {
    await rm(outside, { force: true });
  }
});

test("cli wire: kimi-session-usage refuses symlink-escaping --session-dir, --stdout-file, and --index", async () => {
  const dir = await mkdtemp(join(tmpdir(), "muster-kimi-wire-symlink-"));
  const outsideDir = await mkdtemp(join(tmpdir(), "muster-kimi-wire-outside-session-"));
  const outsideStdout = await plantEscape(dir, "stdout.jsonl", "{}\n");
  const outsideIndex = await plantEscape(dir, "session_index.jsonl", "");
  await symlink(outsideDir, join(dir, "session"));
  try {
    await fails(["kimi-session-usage", "--session-dir", "session"], /contained under the run root/, { cwd: dir });
    await fails(["kimi-session-usage", "--cwd", dir, "--stdout-file", "stdout.jsonl"], /contained under the run root/, { cwd: dir });
    await fails(["kimi-session-usage", "--cwd", dir, "--index", "session_index.jsonl"], /contained under the run root/, { cwd: dir });
  } finally {
    await rm(outsideStdout, { force: true });
    await rm(outsideIndex, { force: true });
  }
});

// Plant a REAL session tree (one usage record, a distinctive model name so a
// leaked read shows up verbatim in stdout) at `dir`.
async function plantSessionTree(dir, model = "TOPSECRET-model") {
  await mkdir(join(dir, "agents", "main"), { recursive: true });
  await writeFile(
    join(dir, "agents", "main", "wire.jsonl"),
    `{"type":"usage.record","model":"${model}","usage":{"inputOther":1,"output":2,"inputCacheRead":3,"inputCacheCreation":4},"usageScope":"turn","time":1}\n`
  );
  return dir;
}

test("cli wire: kimi-session-usage --cwd refuses an index-planted session dir escaping the session index root", async () => {
  // The resolved sessionDir is DATA, not a flag: it comes back from the session
  // index, which kimi writes at the kimi-home root with every sessionDir under
  // it (src/kimi-receipts.js's probe evidence). So the index's own directory is
  // the root, and an entry pointing outside it -- relative traversal, an
  // absolute tree elsewhere, or an in-root name symlinked out -- is planted,
  // never a session: the named refusal, never a read (audit S2 P1).
  const root = await mkdtemp(join(tmpdir(), "muster-kimi-index-root-"));
  const outside = await plantSessionTree(await mkdtemp(join(tmpdir(), "muster-kimi-outside-session-")));
  const indexPath = join(root, "session_index.jsonl");
  await symlink(outside, join(root, "linked-session"));
  for (const sessionDir of ["../../etc", outside, join(root, "linked-session")]) {
    await writeFile(indexPath, JSON.stringify({ sessionId: "session_planted", sessionDir, workDir: "/repo/leg" }) + "\n");
    await assert.rejects(
      run(["kimi-session-usage", "--cwd", "/repo/leg", "--index", "session_index.jsonl"], { cwd: root }),
      (err) => {
        assert.match(err.stderr, /contained under the session index root/, `planted sessionDir ${sessionDir} must hit the named refusal`);
        assert.ok(!String(err.stdout).includes("TOPSECRET"), "the planted tree's usage must never be echoed into the CLI JSON");
        return true;
      }
    );
  }
});

test("cli wire: kimi-summarize-receipts refuses a symlink items file escaping the run root", async () => {
  const dir = await mkdtemp(join(tmpdir(), "muster-kimi-wire-symlink-items-"));
  const outside = await plantEscape(dir, "items.json", "[]\n");
  try {
    await fails(["kimi-summarize-receipts", "items.json"], /contained under the run root/, { cwd: dir });
  } finally {
    await rm(outside, { force: true });
  }
});

// ---------------------------------------------------------------------------
// codex-wait-packet
// ---------------------------------------------------------------------------

test("cli wire: codex-wait-packet prints the per-version barrier shapes", async () => {
  const v2 = JSON.parse((await run(["codex-wait-packet", "--version", "v2"])).stdout);
  assert.deepEqual(v2, { tool: "collaboration.wait_agent", timeout_ms: 30000 });

  const v1 = JSON.parse((await run(["codex-wait-packet", "--targets", "agent-1,agent-2", "--timeout-ms", "60000"])).stdout);
  assert.deepEqual(v1, { tool: "multi_agent_v1.wait_agent", targets: ["agent-1", "agent-2"], timeout_ms: 60000 });
});

test("cli wire: codex-wait-packet fails loud on a version/targets mismatch or a bad timeout", async () => {
  await fails(["codex-wait-packet"], /v1 wait_agent requires a non-empty targets array/);
  await fails(["codex-wait-packet", "--version", "v2", "--targets", "agent-1"], /v2 wait_agent takes no targets/);
  await fails(["codex-wait-packet", "--version", "v2", "--timeout-ms", "5"], /timeoutMs must be an integer within 10000\.\.3600000 ms/);
  await fails(["codex-wait-packet", "--version", "v2", "--timeout-ms", "abc"], /--timeout-ms must be an integer/);
});

// ---------------------------------------------------------------------------
// usage string
// ---------------------------------------------------------------------------

test("cli wire: the usage string names all six dispatch packet/receipt verbs", async () => {
  const { stdout } = await run(["help"]);
  for (const verb of [
    "kimi-goal-invocation", "kimi-process-dispatch", "kimi-session-usage",
    "kimi-summarize-receipts", "codex-spawn-packet", "codex-wait-packet",
  ]) {
    assert.ok(stdout.includes(verb), `usage must name ${verb}`);
  }
});
