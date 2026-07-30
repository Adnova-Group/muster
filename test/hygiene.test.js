import { test } from "node:test";
import assert from "node:assert/strict";
import {
  findZombieProcesses,
  reapZombieProcesses,
  parseWorktreePorcelain,
  evaluateWorktreeSweep,
  findStaleClaims,
  releaseStaleClaims,
  deriveMusterWorktreeRoots,
  runHygiene,
  renderHygieneReport,
} from "../src/hygiene.js";

// Direct unit tests for src/hygiene.js -- the burn-hygiene guards' pure-function
// cores. Every provider (process list, worktree list, claim timestamps) is
// injected, so none of this touches a real OS process or a real git worktree --
// deterministic, no `ps`/`git` spawns, no real clock.
//
// Incident this guards against: a Codex orchestration burn left 2 zombie codex
// CLI processes running for a day (quota drain), 34 stale worktrees, and a dead
// runner's claim ({claimed: codex-efficiency@...}) parked for a day.

// ---------------------------------------------------------------------------
// Guard 1 -- zombie provider CLI process: detect + reap
// ---------------------------------------------------------------------------

test("findZombieProcesses + reapZombieProcesses: detects and reaps an orphaned provider CLI process fixture with a dispatch receipt", () => {
  const processes = [
    // The zombie fixture: a codex CLI process reparented to init after its
    // supervisor died -- exactly the burn incident's "2 zombie codex CLI
    // processes running for a day" shape. Its dispatch receipt establishes
    // ownership and its stable start identity closes PID-reuse races.
    {
      pid: 100,
      ppid: 1,
      command: "codex --profile default",
      startedAt: "2026-07-14T00:00:00Z",
      startIdentity: "linux-proc-stat:1000",
      cwd: "/repo/.worktrees/burn-fix",
    },
    // A live provider process whose parent is still running -- must be left alone.
    { pid: 200, ppid: 50, command: "claude --print", startedAt: "2026-07-15T23:50:00Z", cwd: "/repo/.worktrees/burn-fix" },
    { pid: 50, ppid: 10, command: "bash orchestrator.sh", startedAt: "2026-07-15T23:00:00Z" },
  ];

  const { ok, zombies } = findZombieProcesses(processes, {
    newestRunMarkerAt: "2026-07-16T00:00:00Z",
    musterRoots: ["/repo/.worktrees/burn-fix"],
    dispatchPids: [100],
  });
  assert.equal(ok, true);
  assert.equal(zombies.length, 1);
  assert.equal(zombies[0].pid, 100);
  // A day-old orphan legitimately trips BOTH criteria (dead parent, and its
  // start predates the run marker past the default threshold) -- the
  // reapable gate below is what actually matters, not which reason(s) fired.
  assert.deepEqual(zombies[0].reasons, ["orphaned-parent", "stale-start"]);
  assert.equal(zombies[0].provenance, "dispatch-receipt");
  assert.equal(zombies[0].reapable, true);

  const killed = [];
  const { reaped, skipped } = reapZombieProcesses(zombies, {
    getProcessIdentity: () => "linux-proc-stat:1000",
    kill: (pid) => killed.push(pid),
  });
  assert.deepEqual(reaped, [100]);
  assert.deepEqual(skipped, []);
  assert.deepEqual(killed, [100]);
});

// Audit S10 (security): orphanage alone is NOT sufficient to SIGTERM a host
// process -- another tool's legitimately orphaned codex/claude process (a
// detached editor session, a crashed non-muster run) matches the same shape.
// Reap eligibility must be corroborated by muster-owned state: the process's
// cwd under a known muster worktree, or a recorded dispatch receipt.
test("findZombieProcesses + reapZombieProcesses (adversarial): an orphaned provider process with NO muster provenance is reported but NEVER reaped", () => {
  const processes = [
    // Another tool's legitimately orphaned codex process: dead parent, old
    // start -- but its cwd is nowhere near a muster worktree and no dispatch
    // receipt names its pid.
    { pid: 150, ppid: 1, command: "codex --profile default", startedAt: "2026-07-14T00:00:00Z", cwd: "/home/ryan/other-tool" },
  ];

  const { zombies } = findZombieProcesses(processes, {
    newestRunMarkerAt: "2026-07-16T00:00:00Z",
    musterRoots: ["/repo/.worktrees/burn-fix"],
  });
  assert.equal(zombies.length, 1, "still detected and reported");
  assert.deepEqual(zombies[0].reasons, ["orphaned-parent", "stale-start"]);
  assert.equal(zombies[0].provenance, null);
  assert.equal(zombies[0].reapable, false, "orphanage alone is never sufficient to kill");

  const { reaped, skipped } = reapZombieProcesses(zombies, {
    kill: () => { throw new Error("must not be called -- no muster provenance"); },
  });
  assert.deepEqual(reaped, []);
  assert.equal(skipped.length, 1);
  assert.equal(skipped[0].pid, 150);
  assert.match(skipped[0].reason, /no muster provenance/);
});

test("findZombieProcesses + reapZombieProcesses (adversarial): a manually-created `.worktrees/` cwd without a dispatch receipt is report-only", () => {
  const processes = [
    {
      pid: 151,
      ppid: 1,
      command: "codex --profile default",
      startedAt: "2026-07-14T00:00:00Z",
      startIdentity: "linux-proc-stat:12345",
      cwd: "/repo/.worktrees/manually-created",
    },
  ];

  const { zombies } = findZombieProcesses(processes, {
    newestRunMarkerAt: "2026-07-16T00:00:00Z",
    musterRoots: ["/repo/.worktrees/manually-created"],
  });
  assert.equal(zombies.length, 1, "candidate remains diagnostically visible");
  assert.equal(zombies[0].provenance, null, "a cwd naming convention is not ownership evidence");
  assert.equal(zombies[0].reapable, false);

  const { reaped, skipped } = reapZombieProcesses(zombies, {
    getProcessIdentity: () => "linux-proc-stat:12345",
    kill: () => assert.fail("an unreceipted worktree process must not be signaled"),
  });
  assert.deepEqual(reaped, []);
  assert.equal(skipped[0].pid, 151);
  assert.match(skipped[0].reason, /no muster provenance/);
});

test("findZombieProcesses + reapZombieProcesses: a recorded dispatch receipt corroborates reap eligibility without a cwd", () => {
  const processes = [
    {
      pid: 4242,
      ppid: 1,
      command: "claude --print",
      startedAt: "2026-07-14T00:00:00Z",
      startIdentity: "linux-proc-stat:777",
    },
  ];
  const { zombies } = findZombieProcesses(processes, {
    newestRunMarkerAt: "2026-07-16T00:00:00Z",
    dispatchPids: [4242],
  });
  assert.equal(zombies.length, 1);
  assert.equal(zombies[0].provenance, "dispatch-receipt");
  assert.equal(zombies[0].reapable, true);

  const killed = [];
  const { reaped } = reapZombieProcesses(zombies, {
    getProcessIdentity: () => "linux-proc-stat:777",
    kill: (pid) => killed.push(pid),
  });
  assert.deepEqual(reaped, [4242]);
  assert.deepEqual(killed, [4242]);
});

test("findZombieProcesses + reapZombieProcesses: a receipted process without stable start identity remains report-only", () => {
  const { zombies } = findZombieProcesses([
    { pid: 4243, ppid: 1, command: "claude --print", startedAt: "2026-07-14T00:00:00Z" },
  ], {
    newestRunMarkerAt: "2026-07-16T00:00:00Z",
    dispatchPids: [4243],
  });
  assert.equal(zombies[0].provenance, "dispatch-receipt");
  assert.equal(zombies[0].startIdentity, null);
  assert.equal(zombies[0].reapable, false, "unsupported identity platforms fail closed");

  const { reaped, skipped } = reapZombieProcesses(zombies, {
    kill: () => assert.fail("a process without stable identity must not be signaled"),
  });
  assert.deepEqual(reaped, []);
  assert.match(skipped[0].reason, /stable process-start identity unavailable/);
});

test("reapZombieProcesses (adversarial): PID reuse between classification and reap is detected before signaling", () => {
  const { zombies } = findZombieProcesses([
    {
      pid: 4343,
      ppid: 1,
      command: "codex exec",
      startedAt: "2026-07-14T00:00:00Z",
      startIdentity: "linux-proc-stat:100",
    },
  ], {
    newestRunMarkerAt: "2026-07-16T00:00:00Z",
    dispatchPids: [4343],
  });
  assert.equal(zombies[0].reapable, true, "classification sees both receipt and stable identity");

  const { reaped, skipped } = reapZombieProcesses(zombies, {
    getProcessIdentity: () => "linux-proc-stat:200",
    kill: () => assert.fail("a reused PID must never be signaled"),
  });
  assert.deepEqual(reaped, []);
  assert.equal(skipped[0].pid, 4343);
  assert.match(skipped[0].reason, /process identity changed/);
});

test("deriveMusterWorktreeRoots: only `.worktrees/` entries are muster-owned roots", () => {
  const roots = deriveMusterWorktreeRoots([
    { path: "/repo", bare: false },
    { path: "/repo/.bare", bare: true },
    { path: "/repo/.worktrees/item-1", bare: false },
    { path: "/repo/.worktrees/item-2", bare: false },
    { path: "/elsewhere/scratch", bare: false },
  ]);
  assert.deepEqual(roots.sort(), ["/repo/.worktrees/item-1", "/repo/.worktrees/item-2"]);
});

test("runHygiene: cwd remains diagnostic but only a dispatch receipt authorizes reap", async () => {
  const killed = [];
  const result = await runHygiene({
    processes: [
      // Receipted orphan: cwd is useful context, but the receipt is authority.
      { pid: 100, ppid: 1, command: "codex exec", startedAt: "2026-07-14T00:00:00Z", startIdentity: "linux-proc-stat:100", cwd: "/repo/.worktrees/burn-fix/sub" },
      // foreign orphan: same shape, cwd elsewhere -> reported, never killed
      { pid: 200, ppid: 1, command: "codex exec", startedAt: "2026-07-14T00:00:00Z", cwd: "/opt/other-tool" },
    ],
    worktrees: [
      { path: "/repo", bare: false },
      { path: "/repo/.worktrees/burn-fix", bare: false },
    ],
    now: Date.parse("2026-07-16T00:00:00Z"),
    reap: true,
    zombieOptions: { dispatchPids: [100] },
    getProcessIdentity: () => "linux-proc-stat:100",
    kill: (pid) => killed.push(pid),
  });
  assert.deepEqual(killed, [100], "only the muster-provenanced orphan is reaped");
  assert.deepEqual(result.reapedProcesses.reaped, [100]);
  assert.equal(result.reapedProcesses.skipped.length, 1);
  assert.equal(result.reapedProcesses.skipped[0].pid, 200);
  assert.match(result.reapedProcesses.skipped[0].reason, /no muster provenance/);
});

// Ownership surfacing: the CLI currently wires no dispatch receipt store, so
// --reap can never fire and the report must say that explicitly.
test("runHygiene + renderHygieneReport: ownership receipts unavailable is surfaced, not silent", async () => {
  const result = await runHygiene({
    processes: [
      // the non-Linux shape: provider captured the process but cwd is null
      { pid: 100, ppid: 1, command: "codex exec", startedAt: "2026-07-14T00:00:00Z", cwd: null },
      { pid: 101, ppid: 1, command: "claude --print", startedAt: "2026-07-14T00:00:00Z" },
    ],
    worktrees: [{ path: "/repo/.worktrees/burn-fix", bare: false }],
    now: Date.parse("2026-07-16T00:00:00Z"),
    reap: true,
    kill: () => assert.fail("nothing may be killed when provenance is unavailable"),
  });
  assert.equal(result.zombies.length, 2);
  assert.equal(result.provenance.blind, true);
  assert.equal(result.provenance.cwdAvailable, false);
  assert.equal(result.provenance.dispatchReceipts, 0);
  assert.deepEqual(result.reapedProcesses.reaped, []);
  const report = renderHygieneReport(result);
  assert.match(report, /ownership receipts unavailable: reap disabled for 2 candidates/);
  assert.match(report, /report-only \(no dispatch receipt\)/);
});

test("runHygiene: cwd alone remains blind; injected dispatch receipts provide ownership evidence", async () => {
  const base = {
    worktrees: [],
    now: Date.parse("2026-07-16T00:00:00Z"),
    kill: () => {},
  };
  const withCwd = await runHygiene({
    ...base,
    processes: [{ pid: 100, ppid: 1, command: "codex exec", startedAt: "2026-07-14T00:00:00Z", cwd: "/somewhere" }],
  });
  assert.equal(withCwd.provenance.blind, true, "a readable cwd is diagnostic, not ownership evidence");
  assert.match(renderHygieneReport(withCwd), /ownership receipts unavailable/);

  const withReceipts = await runHygiene({
    ...base,
    processes: [{ pid: 100, ppid: 1, command: "codex exec", startedAt: "2026-07-14T00:00:00Z", cwd: null }],
    zombieOptions: { dispatchPids: [999] },
  });
  assert.equal(withReceipts.provenance.blind, false, "injected receipts mean provenance was evaluated");

  const empty = await runHygiene({ ...base, processes: [] });
  assert.equal(empty.provenance.blind, false, "no process list captured at all is a degraded provider, not a blind one");
});

test("findZombieProcesses + reapZombieProcesses (adversarial): a live run's process is reported but NEVER reaped, even past the stale-start threshold", () => {
  const processes = [
    // Very old start relative to the newest run marker -- flagged by the age
    // heuristic -- but its parent (900) is alive, so it is still owned by a
    // live supervisor. Killing it on age alone would be exactly the burn this
    // guard exists to prevent, not fix.
    { pid: 300, ppid: 900, command: "codex exec", startedAt: "2026-07-01T00:00:00Z" },
    { pid: 900, ppid: 1, command: "node runner.js", startedAt: "2026-07-15T00:00:00Z" },
  ];

  const { zombies } = findZombieProcesses(processes, {
    newestRunMarkerAt: "2026-07-16T00:00:00Z",
    staleMs: 60 * 60 * 1000,
  });
  const flagged = zombies.find((z) => z.pid === 300);
  assert.ok(flagged, "a stale-start provider process is still reported");
  assert.deepEqual(flagged.reasons, ["stale-start"]);
  assert.equal(flagged.reapable, false, "parent-alive processes are never reap-eligible on age alone");

  const { reaped, skipped } = reapZombieProcesses(zombies, {
    kill: () => { throw new Error("must not be called -- reapable is false"); },
  });
  assert.deepEqual(reaped, []);
  assert.equal(skipped.length, 1);
  assert.equal(skipped[0].pid, 300);
  assert.match(skipped[0].reason, /parent alive/);
});

test("findZombieProcesses: a non-provider process is never flagged, however long it has run or whatever its parentage", () => {
  const processes = [
    { pid: 400, ppid: 1, command: "node build.js --watch", startedAt: "2020-01-01T00:00:00Z" },
  ];
  const { zombies } = findZombieProcesses(processes, { newestRunMarkerAt: "2026-07-16T00:00:00Z" });
  assert.deepEqual(zombies, []);
});

test("findZombieProcesses (regression): a process whose PATH merely contains 'codex'/'claude' as a substring is never flagged -- only the actual invoked executable's basename counts", () => {
  const processes = [
    // muster's own worktree layout puts hook scripts under a `.claude/worktrees/...`
    // path -- a naive substring/word-boundary match against the whole command
    // line would misidentify this as a "claude" provider process. It must not.
    { pid: 500, ppid: 1, command: "node /home/ryan/dev/muster/.claude/worktrees/agent-x/plugin/hooks/pre-tool-use.js", startedAt: "2020-01-01T00:00:00Z" },
    { pid: 501, ppid: 1, command: "/usr/bin/some-codex-wrapper-tool --run", startedAt: "2020-01-01T00:00:00Z" },
  ];
  const { zombies } = findZombieProcesses(processes, { newestRunMarkerAt: "2026-07-16T00:00:00Z" });
  assert.deepEqual(zombies, [], "neither process is the actual codex/claude executable, so neither is flagged");
});

test("findZombieProcesses: the real executable IS matched however it's invoked (bare name or a full path, incl. one containing '.claude')", () => {
  const processes = [
    { pid: 502, ppid: 1, command: "claude --print", startedAt: "2020-01-01T00:00:00Z" },
    { pid: 503, ppid: 1, command: "/home/ryan/.claude/local/claude exec", startedAt: "2020-01-01T00:00:00Z" },
  ];
  const { zombies } = findZombieProcesses(processes, { newestRunMarkerAt: "2026-07-16T00:00:00Z" });
  assert.deepEqual(zombies.map((z) => z.pid).sort(), [502, 503]);
});

// ---------------------------------------------------------------------------
// Guard 2 -- stale-worktree sweep offer
// ---------------------------------------------------------------------------

test("evaluateWorktreeSweep: fires a sweep offer only once live worktrees exceed the threshold", () => {
  const makeWorktrees = (n) =>
    Array.from({ length: n }, (_, i) => ({ path: `/tmp/wt-${i}`, bare: false, prunable: false }));

  const atThreshold = evaluateWorktreeSweep(makeWorktrees(10));
  assert.equal(atThreshold.count, 10);
  assert.equal(atThreshold.sweepOffered, false, "exactly at the threshold does not fire");

  const overThreshold = evaluateWorktreeSweep(makeWorktrees(11));
  assert.equal(overThreshold.count, 11);
  assert.equal(overThreshold.sweepOffered, true);
  assert.match(overThreshold.message, /sweep/i);
  assert.match(overThreshold.message, /does not remove worktrees automatically/i, "the offer is a report, never an automatic delete");
});

test("parseWorktreePorcelain: parses a real `git worktree list --porcelain` block; a bare entry is excluded from the live count", () => {
  const text = [
    "worktree /repo",
    "HEAD abc123",
    "branch refs/heads/main",
    "",
    "worktree /repo/.bare",
    "bare",
    "",
    "worktree /repo/.worktrees/item-1",
    "HEAD def456",
    "branch refs/heads/item-1",
    "",
    "worktree /repo/.worktrees/item-2",
    "HEAD 789abc",
    "detached",
    "prunable gitdir file points to non-existent location",
    "",
  ].join("\n");

  const worktrees = parseWorktreePorcelain(text);
  assert.equal(worktrees.length, 4, "all four entries (including the bare one) are parsed");

  const result = evaluateWorktreeSweep(worktrees, { threshold: 2 });
  assert.equal(result.count, 3, "the bare entry does not count as a live worktree");
  assert.equal(result.sweepOffered, true);
  assert.deepEqual(result.candidates, ["/repo/.worktrees/item-2"], "only the prunable entry is a sweep candidate");
});

// ---------------------------------------------------------------------------
// Guard 3 -- stale coordination-claim auto-release
// ---------------------------------------------------------------------------

test("releaseStaleClaims: auto-releases a claim whose heartbeat is older than 60 minutes, leaving a receipt", () => {
  const now = Date.parse("2026-07-16T02:00:00Z");
  const content = [
    "# Backlog",
    "",
    "- [ ] Fix the thing {id: fix-thing} {claimed: codex-efficiency@2026-07-15T00:00:00Z}",
    "- [ ] Fresh item {id: fresh-item} {claimed: alice@2026-07-16T01:50:00Z}",
  ].join("\n");

  const { ok, content: updated, releases } = releaseStaleClaims(content, { now });
  assert.equal(ok, true);
  assert.equal(releases.length, 1);
  assert.equal(releases[0].id, "fix-thing");
  assert.equal(releases[0].runner, "codex-efficiency");
  assert.match(releases[0].receipt, /^RELEASED fix-thing codex-efficiency/);

  const lines = updated.split("\n");
  const releasedLine = lines.find((l) => l.includes("fix-thing"));
  const freshLine = lines.find((l) => l.includes("fresh-item"));
  assert.doesNotMatch(releasedLine, /claimed/, "the stale claim annotation is stripped");
  assert.match(releasedLine, /\{id: fix-thing\}/, "other annotations on the released line stay intact");
  assert.match(freshLine, /\{claimed: alice@2026-07-16T01:50:00Z\}/, "a fresh (<60min) claim is left completely untouched");
});

test("releaseStaleClaims (regression, review finding): a `{claimed: ...}`-shaped substring in the item's own PROSE (before the real trailing annotation) is never mistaken for the annotation to strip -- only the real trailing {claimed:} is ever touched", () => {
  const now = Date.parse("2026-07-16T02:00:00Z");
  // The item's own text is literally about renaming a `{claimed: ...}`-shaped flag --
  // that occurrence sits BEFORE the real trailing annotation block and must be left
  // completely alone; only the genuine trailing {claimed:} annotation is stale here.
  const content = "- [ ] Rename the {claimed: legacy-flag} field {id: task-1} {claimed: codex-efficiency@2020-01-01T00:00:00Z}";

  const { releases, content: updated } = releaseStaleClaims(content, { now });
  assert.equal(releases.length, 1);
  assert.equal(releases[0].id, "task-1");
  assert.equal(releases[0].runner, "codex-efficiency");

  assert.match(updated, /\{claimed: legacy-flag\}/, "the prose-embedded look-alike is untouched");
  assert.match(updated, /\{id: task-1\}/, "the real id annotation survives");
  // The real trailing claim (the actually-stale one) must be gone -- if the strip
  // mistakenly targeted the prose occurrence instead, this second {claimed:} would
  // still be present on disk despite the receipt claiming it was released.
  assert.doesNotMatch(updated, /codex-efficiency@2020-01-01/, "the real stale claim annotation is actually gone, not just reported as gone");
});

test("releaseStaleClaims (adversarial, race guard): a boundary claim exactly at 60 minutes is kept; one second past is released -- a live runner's own heartbeat refresh is what keeps it safe, never a race", () => {
  const now = Date.parse("2026-07-16T01:00:00Z");

  const exactlyOnThreshold = releaseStaleClaims(
    "- [ ] A {id: a} {claimed: bob@2026-07-16T00:00:00Z}",
    { now }
  );
  assert.equal(exactlyOnThreshold.releases.length, 0, "age == staleMs is not yet stale");

  const pastThreshold = releaseStaleClaims(
    "- [ ] B {id: b} {claimed: bob@2026-07-15T23:59:59Z}",
    { now }
  );
  assert.equal(pastThreshold.releases.length, 1, "age > staleMs is released");
});

test("releaseStaleClaims: the stale threshold is configurable", () => {
  const now = Date.parse("2026-07-16T00:10:00Z");
  const content = "- [ ] A {id: a} {claimed: bob@2026-07-16T00:00:00Z}";
  const r = releaseStaleClaims(content, { now, staleMs: 5 * 60 * 1000 });
  assert.equal(r.releases.length, 1, "a 10-minute-old claim is stale under a 5-minute configured threshold");
});

test("findStaleClaims: no claims at all reports zero, no crash", () => {
  const content = "- [ ] Nothing claimed {id: x}";
  const { ok, stale } = findStaleClaims(content, { now: Date.now() });
  assert.equal(ok, true);
  assert.deepEqual(stale, []);
});
