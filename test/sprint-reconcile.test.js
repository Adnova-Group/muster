import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { computeSprintWaves, reconcileSprintProgress } from "../src/sprint-waves.js";

const pexecFile = promisify(execFile);
const repoRoot = new URL("../", import.meta.url).pathname;
const cli = join(repoRoot, "src", "cli.js");

function plan(lines) {
  return computeSprintWaves(lines.join("\n"));
}

function receipt(id, itemId, phase, status = "completed", attempt = 1) {
  return { id, itemId, phase, status, attempt };
}

function flight(itemId, phase, attempt = 1) {
  return { itemId, phase, attempt };
}

test("a completion wake immediately exposes review instead of returning to idle", () => {
  const sprint = plan(["- [ ] A {id: a} {deps: none} {disposition: pr}"]);
  const result = reconcileSprintProgress(sprint, {
    inFlight: [flight("a", "implementation")],
    receipts: [receipt("impl-a", "a", "implementation")],
  });

  assert.equal(result.ok, true);
  assert.equal(result.items.a.state, "review_ready");
  assert.deepEqual(result.actions, [{ type: "dispatch", itemId: "a", phase: "review", wave: 1 }]);
  assert.deepEqual(result.inFlight, []);
  assert.equal(result.next, "dispatch");
  assert.equal(result.wait.eligible, false);
});

test("one wake drains multiple simultaneous implementation completions", () => {
  const sprint = plan([
    "- [ ] A {id: a} {deps: none} {disposition: pr}",
    "- [ ] B {id: b} {deps: none} {disposition: keep}",
  ]);
  const result = reconcileSprintProgress(sprint, {
    inFlight: [
      flight("a", "implementation"),
      flight("b", "implementation"),
    ],
    receipts: [
      receipt("impl-b", "b", "implementation"),
      receipt("impl-a", "a", "implementation"),
    ],
  });

  assert.deepEqual(result.actions, [
    { type: "dispatch", itemId: "a", phase: "review", wave: 1 },
    { type: "dispatch", itemId: "b", phase: "review", wave: 1 },
  ]);
  assert.equal(result.wait.eligible, false);
});

test("new dispatch actions preserve the schedule concurrency cap", () => {
  const sprint = computeSprintWaves([
    "- [ ] A {id: a} {deps: none} {disposition: pr}",
    "- [ ] B {id: b} {deps: none} {disposition: pr}",
    "- [ ] C {id: c} {deps: none} {disposition: pr}",
  ].join("\n"), { parallelLimit: 2 });
  const result = reconcileSprintProgress(sprint);

  assert.deepEqual(result.actions, [
    { type: "dispatch", itemId: "a", phase: "implementation", wave: 1 },
    { type: "dispatch", itemId: "b", phase: "implementation", wave: 1 },
  ]);
  assert.equal(result.metadata.buildReview.maxConcurrency, 2);
});

test("duplicate and out-of-order receipts are retained and applied idempotently", () => {
  const sprint = plan(["- [ ] A {id: a} {deps: none} {disposition: pr}"]);
  const early = receipt("review-a", "a", "review");
  const first = reconcileSprintProgress(sprint, { receipts: [early, early] });

  assert.equal(first.items.a.state, "implementation_ready");
  assert.equal(first.receipts.length, 1);

  const second = reconcileSprintProgress(sprint, {
    receipts: [...first.receipts, early, receipt("impl-a", "a", "implementation")],
  });
  assert.equal(second.items.a.state, "completed");
  assert.deepEqual(second.actions, []);
  assert.equal(second.next, "terminal");
});

test("failed, cancelled, and missing receipts never unlock dependencies", () => {
  const sprint = plan([
    "- [ ] A {id: a} {deps: none} {disposition: pr}",
    "- [ ] B {id: b} {deps: a} {disposition: pr}",
    "- [ ] C {id: c} {deps: none} {disposition: pr}",
  ]);
  const result = reconcileSprintProgress(sprint, {
    inFlight: [
      flight("a", "implementation"),
      flight("c", "implementation"),
    ],
    receipts: [receipt("impl-a-failed", "a", "implementation", "failed")],
  });

  assert.equal(result.items.a.state, "failed");
  assert.equal(result.items.b.state, "blocked");
  assert.equal(result.items.c.state, "implementation_in_flight");
  assert.ok(!result.actions.some((action) => action.itemId === "b"));
  assert.equal(result.next, "wait");
  assert.equal(result.wait.eligible, true);

  const cancelled = reconcileSprintProgress(sprint, {
    receipts: [receipt("impl-a-cancelled", "a", "implementation", "cancelled")],
  });
  assert.equal(cancelled.items.a.state, "cancelled");
  assert.equal(cancelled.items.b.state, "blocked");
  assert.ok(!cancelled.actions.some((action) => action.itemId === "b"));
});

test("review barrier exposes merge integration one item at a time in backlog order", () => {
  const sprint = plan([
    "- [ ] A {id: a} {deps: none} {disposition: merge-local}",
    "- [ ] B {id: b} {deps: none} {disposition: merge-push}",
  ]);
  const reviewsDone = [
    receipt("impl-a", "a", "implementation"),
    receipt("review-a", "a", "review"),
    receipt("impl-b", "b", "implementation"),
    receipt("review-b", "b", "review"),
  ];
  const first = reconcileSprintProgress(sprint, { receipts: reviewsDone });

  assert.deepEqual(first.actions, [{ type: "dispatch", itemId: "a", phase: "integration", wave: 1 }]);
  assert.equal(first.items.b.state, "integration_ready");
  assert.equal(first.metadata.buildReview.maxConcurrency, 5);
  assert.equal(first.metadata.degradation.integrationOrder, "preserved");

  const second = reconcileSprintProgress(sprint, {
    receipts: [...first.receipts, receipt("integrate-a", "a", "integration")],
  });
  assert.deepEqual(second.actions, [{ type: "dispatch", itemId: "b", phase: "integration", wave: 1 }]);
});

test("a later dependency wave waits for all prior-wave integration", () => {
  const sprint = plan([
    "- [ ] A {id: a} {deps: none} {disposition: pr}",
    "- [ ] Merge C {id: c} {deps: none} {disposition: merge-local}",
    "- [ ] B {id: b} {deps: a} {disposition: pr}",
  ]);
  const result = reconcileSprintProgress(sprint, {
    receipts: [
      receipt("impl-a", "a", "implementation"),
      receipt("review-a", "a", "review"),
      receipt("impl-c", "c", "implementation"),
      receipt("review-c", "c", "review"),
    ],
  });

  assert.deepEqual(result.actions, [{ type: "dispatch", itemId: "c", phase: "integration", wave: 1 }]);
  assert.equal(result.items.b.state, "implementation_ready");
});

test("sprint-reconcile CLI consumes the machine-checkable receipt envelope", async () => {
  const dir = await mkdtemp(join(tmpdir(), "muster-sprint-reconcile-"));
  try {
    const input = join(dir, "progress.json");
    await writeFile(input, JSON.stringify({
      plan: plan(["- [ ] A {id: a} {deps: none} {disposition: pr}"]),
      inFlight: [flight("a", "implementation")],
      receipts: [receipt("impl-a", "a", "implementation")],
    }));
    const { stdout } = await pexecFile(process.execPath, [cli, "sprint-reconcile", input], { cwd: repoRoot });
    const result = JSON.parse(stdout);

    assert.equal(result.next, "dispatch");
    assert.deepEqual(result.actions, [{ type: "dispatch", itemId: "a", phase: "review", wave: 1 }]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("malformed or forged plans fail deterministically and never become wait-eligible", () => {
  const sprint = plan(["- [ ] A {id: a} {deps: none} {disposition: pr}"]);
  const mutations = [
    (value) => { value.schedule.waves = null; },
    (value) => { value.waves = [["a", "a"]]; },
    (value) => { value.items.a.deps = ["ghost"]; },
    (value) => { value.schedule.buildReview.maxConcurrency = 999; },
    (value) => { value.schedule.waves[0].buildReview.itemIds = ["forged"]; },
  ];

  for (const mutate of mutations) {
    const forged = structuredClone(sprint);
    mutate(forged);
    const result = reconcileSprintProgress(forged);
    assert.equal(result.ok, false);
    assert.ok(result.errors.length > 0);
    assert.notEqual(result.wait?.eligible, true);
  }
});

test("in-flight attempts are causal and a newer retry outranks a stale failure", () => {
  const sprint = plan(["- [ ] A {id: a} {deps: none} {disposition: pr}"]);
  const retry = reconcileSprintProgress(sprint, {
    receipts: [receipt("impl-a-1", "a", "implementation", "failed", 1)],
    inFlight: [flight("a", "implementation", 2)],
  });
  assert.equal(retry.ok, true);
  assert.equal(retry.items.a.state, "implementation_in_flight");
  assert.deepEqual(retry.inFlight, [flight("a", "implementation", 2)]);
  assert.equal(retry.wait.eligible, true);

  const impossible = reconcileSprintProgress(sprint, {
    receipts: [],
    inFlight: [flight("a", "review", 1)],
  });
  assert.equal(impossible.ok, false);
  assert.match(impossible.errors.join(" | "), /review.*implementation/i);
  assert.notEqual(impossible.wait?.eligible, true);
});

test("reconciliation rejects oversized collections and identifiers before indexing", () => {
  const sprint = plan(["- [ ] A {id: a} {deps: none} {disposition: pr}"]);
  const tooMany = reconcileSprintProgress(sprint, {
    receipts: Array.from({ length: 10_001 }, (_, index) =>
      receipt(`r-${index}`, "a", "implementation", "failed", index + 1)),
  });
  assert.equal(tooMany.ok, false);
  assert.match(tooMany.errors.join(" | "), /receipts.*limit/i);

  const longId = reconcileSprintProgress(sprint, {
    receipts: [receipt("r".repeat(257), "a", "implementation")],
  });
  assert.equal(longId.ok, false);
  assert.match(longId.errors.join(" | "), /id.*256/i);
});

test("sprint-reconcile CLI returns structured ok:false for a malformed plan", async () => {
  const dir = await mkdtemp(join(tmpdir(), "muster-sprint-reconcile-bad-"));
  try {
    const input = join(dir, "progress.json");
    const forged = plan(["- [ ] A {id: a} {deps: none}"]);
    forged.schedule.waves = null;
    await writeFile(input, JSON.stringify({ plan: forged, receipts: [], inFlight: [] }));
    await assert.rejects(
      pexecFile(process.execPath, [cli, "sprint-reconcile", input], { cwd: repoRoot }),
      (error) => {
        const result = JSON.parse(error.stdout);
        assert.equal(result.ok, false);
        assert.ok(result.errors.length > 0);
        assert.notEqual(result.wait?.eligible, true);
        return true;
      },
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("shared harness protocols require reconcile-dispatch-wait and forbid idle with ready actions", async () => {
  const paths = [
    "plugin/commands/go-backlog.md",
    "plugin/skills/orchestrator/SKILL.md",
    "plugin/skills/orchestrator/references/codex-dispatch.md",
    "codex/skill-adapter.md",
    "cowork/sprint-protocol.md",
  ];
  for (const path of paths) {
    const text = await readFile(join(repoRoot, path), "utf8");
    assert.match(text, /reconcile (?:→|->) dispatch (?:→|->) wait/i, path);
    assert.match(text, /wait\.eligible:true/i, path);
  }
});
