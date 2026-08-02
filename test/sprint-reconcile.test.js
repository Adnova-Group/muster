import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  buildSprintReceipt,
  computeSprintWaves,
  integrationApprovalDigest,
  reconcileSprintProgress,
} from "../src/sprint-waves.js";

const pexecFile = promisify(execFile);
const repoRoot = new URL("../", import.meta.url).pathname;
const cli = join(repoRoot, "src", "cli.js");

function plan(lines) {
  return computeSprintWaves(lines.join("\n"));
}

function receipt(id, itemId, phase, status = "completed", attempt = 1) {
  return {
    id, itemId, phase, status, attempt,
    ...(["implementation", "review"].includes(phase) && status === "completed" ? { candidateSha: SHA_A } : {}),
  };
}

function flight(itemId, phase, attempt = 1) {
  return { itemId, phase, attempt, ...(["review", "integration"].includes(phase) ? { candidateSha: SHA_A } : {}) };
}

const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);
const FINDING_A = "1".repeat(64);
const BASE_SHA = "c".repeat(40);

function integrationTarget(itemId) {
  return { [itemId]: { workBranch: `work/${itemId}`, baseBranch: "main", baseHeadSha: BASE_SHA } };
}

function authorization(itemId, candidateSha, operation) {
  return { itemId, workBranch: `work/${itemId}`, workHeadSha: candidateSha, baseBranch: "main", baseHeadSha: BASE_SHA, operation };
}

function approval(itemId, candidateSha, operation) {
  const value = { ...authorization(itemId, candidateSha, operation), approvedBy: "human-reviewer" };
  return { ...value, digest: integrationApprovalDigest(value) };
}

test("a completion wake immediately exposes review instead of returning to idle", () => {
  const sprint = plan(["- [ ] A {id: a} {deps: none} {disposition: pr}"]);
  const result = reconcileSprintProgress(sprint, {
    inFlight: [flight("a", "implementation")],
    receipts: [receipt("impl-a", "a", "implementation")],
  });

  assert.equal(result.ok, true);
  assert.equal(result.items.a.state, "review_ready");
  assert.deepEqual(result.actions, [{ type: "dispatch", itemId: "a", phase: "review", wave: 1, candidateSha: SHA_A }]);
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
    { type: "dispatch", itemId: "a", phase: "review", wave: 1, candidateSha: SHA_A },
    { type: "dispatch", itemId: "b", phase: "review", wave: 1, candidateSha: SHA_A },
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

  assert.equal(result.items.a.state, "blocked");
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

test("a repaired commit after a failed review self-heals by dispatching another independent review", () => {
  const sprint = plan(["- [ ] A {id: a} {deps: none} {disposition: pr}"]);
  const result = reconcileSprintProgress(sprint, {
    receipts: [
      { ...receipt("impl-a-1", "a", "implementation", "completed", 1), candidateSha: SHA_A },
      { ...receipt("review-a-1", "a", "review", "failed", 1), candidateSha: SHA_A, progressFingerprint: FINDING_A },
      { ...receipt("impl-a-2", "a", "implementation", "completed", 2), candidateSha: SHA_B },
    ],
  });

  assert.equal(result.items.a.state, "review_ready");
  assert.deepEqual(result.actions, [{ type: "dispatch", itemId: "a", phase: "review", wave: 1, attempt: 2, candidateSha: SHA_B }]);
  assert.equal(result.next, "dispatch");
  assert.equal(result.escalated, false);
});

test("an unchanged repair and same-SHA review resurrection both remain invalidated", () => {
  const sprint = plan(["- [ ] A {id: a} {deps: none} {disposition: pr}"]);
  const receipts = [
    { ...receipt("impl-a-1", "a", "implementation"), candidateSha: SHA_A },
    { ...receipt("review-a-1", "a", "review", "failed"), candidateSha: SHA_A, progressFingerprint: FINDING_A },
    { ...receipt("impl-a-2", "a", "implementation", "completed", 2), candidateSha: SHA_A },
  ];
  const unchanged = reconcileSprintProgress(sprint, { receipts });
  assert.equal(unchanged.next, "blocked");
  assert.equal(unchanged.terminalReason, "no-progress");

  const resurrected = reconcileSprintProgress(sprint, { receipts: [
    ...receipts,
    { ...receipt("review-a-2", "a", "review", "completed", 2), candidateSha: SHA_A },
  ] });
  assert.equal(resurrected.next, "blocked");
  assert.notEqual(resurrected.next, "terminal");
});

test("trusted receipt construction verifies worktree HEAD and computes findings evidence", () => {
  const built = buildSprintReceipt({
    id: "review-a", itemId: "a", phase: "review", status: "failed", candidateSha: SHA_A,
    findings: [{ code: "unsafe" }], verifyCandidate: (sha) => sha === SHA_A,
  });
  assert.equal(built.candidateSha, SHA_A);
  assert.match(built.progressFingerprint, /^[0-9a-f]{64}$/);
  assert.throws(() => buildSprintReceipt({
    id: "review-a", itemId: "a", phase: "review", candidateSha: SHA_A,
    verifyCandidate: () => false,
  }), /worktree HEAD/);
});

test("failed review outcomes dispatch repair while candidates change and block on an unchanged candidate", () => {
  const sprint = plan(["- [ ] A {id: a} {deps: none} {disposition: pr}"]);
  const progressing = reconcileSprintProgress(sprint, {
    receipts: [
      { ...receipt("impl-a-1", "a", "implementation"), candidateSha: SHA_A },
      { ...receipt("review-a-1", "a", "review", "failed", 1), candidateSha: SHA_A, progressFingerprint: FINDING_A },
      { ...receipt("impl-a-2", "a", "implementation", "completed", 2), candidateSha: SHA_B },
      { ...receipt("review-a-2", "a", "review", "failed", 2), candidateSha: SHA_B, progressFingerprint: FINDING_A },
    ],
  });
  assert.deepEqual(progressing.actions, [{
    type: "dispatch", itemId: "a", phase: "implementation", wave: 1,
    attempt: 3, recovery: "repair", candidateSha: SHA_B,
  }]);
  assert.equal(progressing.next, "dispatch");

  const stalled = reconcileSprintProgress(sprint, {
    receipts: [
      { ...receipt("impl-a-1", "a", "implementation"), candidateSha: SHA_A },
      { ...receipt("review-a-1", "a", "review", "failed", 1), candidateSha: SHA_A, progressFingerprint: FINDING_A },
      { ...receipt("impl-a-2", "a", "implementation", "completed", 2), candidateSha: SHA_A },
      { ...receipt("review-a-2", "a", "review", "failed", 2), candidateSha: SHA_A, progressFingerprint: FINDING_A },
    ],
  });
  assert.deepEqual(stalled.actions, []);
  assert.equal(stalled.next, "blocked");
  assert.equal(stalled.terminalReason, "no-progress");
});

test("duplicate failed receipt ids are idempotent and cannot fabricate no-progress", () => {
  const sprint = plan(["- [ ] A {id: a} {deps: none} {disposition: pr}"]);
  const failedReview = {
    ...receipt("review-a-1", "a", "review", "failed"),
    candidateSha: SHA_A,
    progressFingerprint: FINDING_A,
  };
  const result = reconcileSprintProgress(sprint, {
    receipts: [
      { ...receipt("impl-a", "a", "implementation"), candidateSha: SHA_A },
      failedReview,
      failedReview,
    ],
  });
  assert.equal(result.next, "dispatch");
  assert.equal(result.items.a.state, "implementation_repair_ready");
});

test("conflicting logical receipts reject deterministically regardless of input order", () => {
  const sprint = plan(["- [ ] A {id: a} {deps: none} {disposition: pr}"]);
  const progressFailure = { ...receipt("failure-progress", "a", "implementation", "failed"), progressFingerprint: FINDING_A };
  const terminalFailure = { ...receipt("failure-terminal", "a", "implementation", "failed"), terminalReason: "external-impossibility" };
  for (const receipts of [[progressFailure, terminalFailure], [terminalFailure, progressFailure]]) {
    const result = reconcileSprintProgress(sprint, { receipts });
    assert.equal(result.next, "invalid");
    assert.match(result.errors.join(" "), /conflicting receipts/);
  }
});

test("stale review and integration receipts cannot complete a repaired candidate", () => {
  const sprint = plan(["- [ ] A {id: a} {deps: none} {disposition: merge-local}"]);
  const approvedA = approval("a", SHA_A, "merge-local");
  const result = reconcileSprintProgress(sprint, {
    integrationTargets: integrationTarget("a"),
    approvals: [approvedA],
    receipts: [
      { ...receipt("impl-a-1", "a", "implementation"), candidateSha: SHA_A },
      { ...receipt("review-a-1", "a", "review"), candidateSha: SHA_A },
      { ...receipt("integration-a-1", "a", "integration"), candidateSha: SHA_A, approvalDigest: approvedA.digest },
      { ...receipt("impl-a-2", "a", "implementation", "completed", 2), candidateSha: SHA_B },
    ],
  });
  assert.equal(result.items.a.state, "review_ready");
  assert.deepEqual(result.actions, [{ type: "dispatch", itemId: "a", phase: "review", wave: 1, attempt: 2, candidateSha: SHA_B }]);
});

test("stale in-flight review and integration are rejected against a changed candidate", () => {
  const reviewSprint = plan(["- [ ] A {id: a} {deps: none} {disposition: pr}"]);
  const review = reconcileSprintProgress(reviewSprint, {
    receipts: [{ ...receipt("impl-a", "a", "implementation"), candidateSha: SHA_B }],
    inFlight: [{ ...flight("a", "review"), candidateSha: SHA_A }],
  });
  assert.equal(review.next, "invalid");
  assert.match(review.errors.join(" "), /stale candidate/);

  const mergeSprint = plan(["- [ ] A {id: a} {deps: none} {disposition: merge-local}"]);
  const integration = reconcileSprintProgress(mergeSprint, {
    receipts: [
      { ...receipt("impl-a", "a", "implementation"), candidateSha: SHA_B },
      { ...receipt("review-a", "a", "review"), candidateSha: SHA_B },
    ],
    inFlight: [{ ...flight("a", "integration"), candidateSha: SHA_A, approvalDigest: "2".repeat(64) }],
  });
  assert.equal(integration.next, "invalid");
  assert.match(integration.errors.join(" "), /stale candidate/);
});

test("completed integration requires matching approval evidence", () => {
  const sprint = plan(["- [ ] A {id: a} {deps: none} {disposition: merge-local}"]);
  const result = reconcileSprintProgress(sprint, {
    receipts: [
      { ...receipt("impl-a", "a", "implementation"), candidateSha: SHA_A },
      { ...receipt("review-a", "a", "review"), candidateSha: SHA_A },
      { ...receipt("integrate-a", "a", "integration"), candidateSha: SHA_A, approvalDigest: "2".repeat(64) },
    ],
  });
  assert.equal(result.next, "invalid");
  assert.match(result.errors.join(" "), /matching exact-head approval/);
});

test("terminal integration failure blocks destructive redispatch", () => {
  const sprint = plan(["- [ ] A {id: a} {deps: none} {disposition: merge-push}"]);
  const result = reconcileSprintProgress(sprint, {
    receipts: [
      { ...receipt("impl-a", "a", "implementation"), candidateSha: SHA_A },
      { ...receipt("review-a", "a", "review"), candidateSha: SHA_A },
      { ...receipt("integration-a", "a", "integration", "failed"), candidateSha: SHA_A, terminalReason: "external-impossibility" },
    ],
  });
  assert.deepEqual(result.actions, []);
  assert.equal(result.next, "blocked");
  assert.equal(result.terminalReason, "external-impossibility");
});

test("explicit external impossibility remains terminal and is never redispatched", () => {
  const sprint = plan(["- [ ] A {id: a} {deps: none} {disposition: pr}"]);
  const result = reconcileSprintProgress(sprint, {
    receipts: [
      { ...receipt("impl-a", "a", "implementation", "failed"), terminalReason: "external-impossibility" },
    ],
  });
  assert.deepEqual(result.actions, []);
  assert.equal(result.next, "blocked");
  assert.equal(result.terminalReason, "external-impossibility");
});

test("review barrier exposes merge integration one item at a time in backlog order", () => {
  const sprint = plan([
    "- [ ] A {id: a} {deps: none} {disposition: merge-local}",
    "- [ ] B {id: b} {deps: none} {disposition: merge-push}",
  ]);
  const reviewsDone = [
    { ...receipt("impl-a", "a", "implementation"), candidateSha: SHA_A },
    { ...receipt("review-a", "a", "review"), candidateSha: SHA_A },
    { ...receipt("impl-b", "b", "implementation"), candidateSha: SHA_B },
    { ...receipt("review-b", "b", "review"), candidateSha: SHA_B },
  ];
  const integrationTargets = { ...integrationTarget("a"), ...integrationTarget("b") };
  const first = reconcileSprintProgress(sprint, { receipts: reviewsDone, integrationTargets });

  assert.deepEqual(first.actions, [{
    type: "approval", phase: "integration", wave: 1,
    authorization: authorization("a", SHA_A, "merge-local"),
    digest: integrationApprovalDigest(authorization("a", SHA_A, "merge-local")),
  }]);
  assert.equal(first.items.b.state, "integration_ready");
  assert.equal(first.metadata.buildReview.maxConcurrency, 5);
  assert.equal(first.metadata.degradation.integrationOrder, "preserved");

  const approvedA = approval("a", SHA_A, "merge-local");
  const dispatchA = reconcileSprintProgress(sprint, {
    receipts: first.receipts, integrationTargets, approvals: [approvedA],
  });
  assert.deepEqual(dispatchA.actions, [{
    type: "dispatch", itemId: "a", phase: "integration", wave: 1,
    candidateSha: SHA_A, approvalDigest: approvedA.digest,
  }]);
  const second = reconcileSprintProgress(sprint, {
    receipts: [...first.receipts, {
      ...receipt("integrate-a", "a", "integration"), candidateSha: SHA_A, approvalDigest: approvedA.digest,
    }],
    integrationTargets,
    approvals: [approvedA],
  });
  assert.deepEqual(second.actions, [{
    type: "approval", phase: "integration", wave: 1,
    authorization: authorization("b", SHA_B, "merge-push"),
    digest: integrationApprovalDigest(authorization("b", SHA_B, "merge-push")),
  }]);
});

test("a later dependency wave waits for all prior-wave integration", () => {
  const sprint = plan([
    "- [ ] A {id: a} {deps: none} {disposition: pr}",
    "- [ ] Merge C {id: c} {deps: none} {disposition: merge-local}",
    "- [ ] B {id: b} {deps: a} {disposition: pr}",
  ]);
  const result = reconcileSprintProgress(sprint, {
    integrationTargets: integrationTarget("c"),
    receipts: [
      receipt("impl-a", "a", "implementation"),
      receipt("review-a", "a", "review"),
      { ...receipt("impl-c", "c", "implementation"), candidateSha: SHA_A },
      { ...receipt("review-c", "c", "review"), candidateSha: SHA_A },
    ],
  });

  assert.deepEqual(result.actions, [{
    type: "approval", phase: "integration", wave: 1,
    authorization: authorization("c", SHA_A, "merge-local"),
    digest: integrationApprovalDigest(authorization("c", SHA_A, "merge-local")),
  }]);
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
    assert.deepEqual(result.actions, [{ type: "dispatch", itemId: "a", phase: "review", wave: 1, candidateSha: SHA_A }]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("sprint-reconcile CLI reads recovery policy from trusted environment, not mailbox JSON", async () => {
  const dir = await mkdtemp(join(tmpdir(), "muster-sprint-recovery-policy-"));
  try {
    const input = join(dir, "progress.json");
    await writeFile(input, JSON.stringify({
      plan: plan(["- [ ] A {id: a} {deps: none} {disposition: pr}"]),
      recovery: { noProgressLimit: 1 },
      receipts: [
        { ...receipt("impl-a-1", "a", "implementation"), candidateSha: SHA_A },
        { ...receipt("review-a-1", "a", "review", "failed"), candidateSha: SHA_A, progressFingerprint: FINDING_A },
        { ...receipt("impl-a-2", "a", "implementation", "completed", 2), candidateSha: SHA_A },
        { ...receipt("review-a-2", "a", "review", "failed", 2), candidateSha: SHA_A, progressFingerprint: FINDING_A },
      ],
    }));
    const { stdout } = await pexecFile(process.execPath, [cli, "sprint-reconcile", input], {
      cwd: repoRoot,
      env: { ...process.env, MUSTER_RECOVERY_NO_PROGRESS_LIMIT: "3", MUSTER_RECOVERY_MAX_CONTINUATIONS: "10" },
    });
    const result = JSON.parse(stdout);
    assert.equal(result.next, "dispatch");
    assert.equal(result.actions[0].recovery, "repair");
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
  assert.match(impossible.errors.join(" | "), /review.*(?:implementation|stale)/i);
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
