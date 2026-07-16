import { test } from "node:test";
import assert from "node:assert/strict";
import {
  findZombieProcesses,
  reapZombieProcesses,
  parseWorktreePorcelain,
  evaluateWorktreeSweep,
  findStaleClaims,
  releaseStaleClaims,
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

test("findZombieProcesses + reapZombieProcesses: detects and reaps an orphaned provider CLI process fixture", () => {
  const processes = [
    // The zombie fixture: a codex CLI process reparented to init after its
    // supervisor died -- exactly the burn incident's "2 zombie codex CLI
    // processes running for a day" shape.
    { pid: 100, ppid: 1, command: "codex --profile default", startedAt: "2026-07-14T00:00:00Z" },
    // A live provider process whose parent is still running -- must be left alone.
    { pid: 200, ppid: 50, command: "claude --print", startedAt: "2026-07-15T23:50:00Z" },
    { pid: 50, ppid: 10, command: "bash orchestrator.sh", startedAt: "2026-07-15T23:00:00Z" },
  ];

  const { ok, zombies } = findZombieProcesses(processes, { newestRunMarkerAt: "2026-07-16T00:00:00Z" });
  assert.equal(ok, true);
  assert.equal(zombies.length, 1);
  assert.equal(zombies[0].pid, 100);
  // A day-old orphan legitimately trips BOTH criteria (dead parent, and its
  // start predates the run marker past the default threshold) -- the
  // reapable gate below is what actually matters, not which reason(s) fired.
  assert.deepEqual(zombies[0].reasons, ["orphaned-parent", "stale-start"]);
  assert.equal(zombies[0].reapable, true);

  const killed = [];
  const { reaped, skipped } = reapZombieProcesses(zombies, { kill: (pid) => killed.push(pid) });
  assert.deepEqual(reaped, [100]);
  assert.deepEqual(skipped, []);
  assert.deepEqual(killed, [100]);
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
