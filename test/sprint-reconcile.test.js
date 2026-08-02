import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { createHash, createHmac, generateKeyPairSync, sign } from "node:crypto";
import { once } from "node:events";
import { startSprintEvidenceBroker } from "../mcp/evidence-broker.mjs";
import {
  buildSprintReceipt,
  computeSprintWaves,
  integrationApprovalDigest,
  lifecycleReceiptDigest,
  reconcileSprintProgress as reconcileSprintProgressRaw,
} from "../src/sprint-waves.js";

const pexecFile = promisify(execFile);
const repoRoot = new URL("../", import.meta.url).pathname;
const cli = join(repoRoot, "src", "cli.js");
const callbackCli = join(repoRoot, "scripts", "sprint-evidence-callback.mjs");
const receiptKeys = generateKeyPairSync("ed25519");
const approvalKeys = generateKeyPairSync("ed25519");
const receiptPrivateKey = receiptKeys.privateKey.export({ type: "pkcs8", format: "pem" });
const receiptPublicKey = receiptKeys.publicKey.export({ type: "spki", format: "pem" });
const approvalPrivateKey = approvalKeys.privateKey.export({ type: "pkcs8", format: "pem" });
const approvalPublicKey = approvalKeys.publicKey.export({ type: "spki", format: "pem" });

function plan(lines) {
  return computeSprintWaves(lines.join("\n"));
}

function receipt(id, itemId, phase, status = "completed", attempt = 1) {
  return {
    id, itemId, phase, status, attempt,
    ...(["implementation", "review"].includes(phase) ? { candidateSha: SHA_A } : {}),
    ...(phase === "review" ? { implementationAttempt: attempt } : {}),
  };
}

function flight(itemId, phase, attempt = 1) {
  return {
    itemId, phase, attempt,
    ...(["review", "integration"].includes(phase) ? { candidateSha: SHA_A } : {}),
    ...(phase === "review" ? { implementationAttempt: attempt } : {}),
  };
}

const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);
const FINDING_A = "1".repeat(64);
const BASE_SHA = "c".repeat(40);
const APPROVAL_TOKEN = "trusted-harness-evidence";
const VERIFY_APPROVAL = { verifyApproval: (value) => value.evidence === APPROVAL_TOKEN };
const RECEIPT_TOKEN = "trusted-parent-receipt";
const RUN_ID = "run-self-healing-test";

function signedReceipt(value) {
  const unsigned = { ...value };
  delete unsigned.evidence;
  return { ...unsigned, evidence: createHmac("sha256", RECEIPT_TOKEN).update(lifecycleReceiptDigest(unsigned)).digest("hex") };
}

function signedCliProgress(progress, privateKey = receiptPrivateKey) {
  return {
    ...progress,
    receipts: (progress.receipts ?? []).map((value) => {
      const unsigned = { ...value };
      delete unsigned.evidence;
      return {
        ...unsigned,
        evidence: sign(null, Buffer.from(lifecycleReceiptDigest(unsigned), "hex"), privateKey).toString("base64"),
      };
    }),
  };
}

function reconcileSprintProgress(sprint, progress = {}, options = {}) {
  return reconcileSprintProgressRaw(sprint, {
    ...progress,
    receipts: (progress.receipts ?? []).map(signedReceipt),
    ...(progress.approvals?.length ? { runId: progress.runId ?? RUN_ID } : {}),
  }, {
    verifyReceipt: (receipt, digest) => receipt.evidence
      === createHmac("sha256", RECEIPT_TOKEN).update(digest).digest("hex"),
    trustedRunId: RUN_ID,
    ...options,
  });
}

function integrationTarget(itemId) {
  return { [itemId]: { workBranch: `work/${itemId}`, baseBranch: "main", baseHeadSha: BASE_SHA } };
}

function authorization(itemId, candidateSha, operation) {
  return { itemId, workBranch: `work/${itemId}`, workHeadSha: candidateSha, baseBranch: "main", baseHeadSha: BASE_SHA, operation };
}

function approval(itemId, candidateSha, operation) {
  const value = {
    ...authorization(itemId, candidateSha, operation), approvedBy: "human-reviewer",
    approvedAt: new Date().toISOString(), runId: RUN_ID, nonce: `nonce-${itemId}-${candidateSha}`,
    evidence: APPROVAL_TOKEN,
  };
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
  assert.deepEqual(result.actions, [{ type: "dispatch", itemId: "a", phase: "review", wave: 1, candidateSha: SHA_A, implementationAttempt: 1 }]);
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
    { type: "dispatch", itemId: "a", phase: "review", wave: 1, candidateSha: SHA_A, implementationAttempt: 1 },
    { type: "dispatch", itemId: "b", phase: "review", wave: 1, candidateSha: SHA_A, implementationAttempt: 1 },
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
  assert.deepEqual(result.actions, [{ type: "dispatch", itemId: "a", phase: "review", wave: 1, attempt: 2, candidateSha: SHA_B, implementationAttempt: 2 }]);
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

test("unchanged repair detection binds to the reviewed implementation generation, not review attempt", () => {
  const sprint = plan(["- [ ] A {id: a} {deps: none} {disposition: pr}"]);
  const result = reconcileSprintProgress(sprint, { receipts: [
    { ...receipt("impl-a-1", "a", "implementation"), candidateSha: SHA_A },
    { ...receipt("review-a-10", "a", "review", "failed", 10), candidateSha: SHA_A, implementationAttempt: 1, progressFingerprint: FINDING_A },
    { ...receipt("impl-a-2", "a", "implementation", "completed", 2), candidateSha: SHA_A },
  ] });
  assert.equal(result.next, "blocked");
  assert.equal(result.terminalReason, "no-progress");
});

test("review completion must name an existing current implementation generation", () => {
  const sprint = plan(["- [ ] A {id: a} {deps: none} {disposition: pr}"]);
  const stale = reconcileSprintProgress(sprint, { receipts: [
    { ...receipt("impl-a-1", "a", "implementation"), candidateSha: SHA_A },
    { ...receipt("impl-a-2", "a", "implementation", "completed", 2), candidateSha: SHA_A },
    { ...receipt("review-a", "a", "review"), candidateSha: SHA_A, implementationAttempt: 1 },
  ] });
  assert.equal(stale.items.a.state, "review_ready");
  assert.notEqual(stale.next, "terminal");

  const future = reconcileSprintProgress(sprint, { receipts: [
    { ...receipt("impl-a", "a", "implementation"), candidateSha: SHA_A },
    { ...receipt("review-a", "a", "review"), candidateSha: SHA_A, implementationAttempt: 99 },
  ] });
  assert.equal(future.next, "invalid");
  assert.match(future.errors.join(" "), /exact implementation generation/);
});

test("trusted receipt construction verifies worktree HEAD and computes findings evidence", () => {
  const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoRoot, encoding: "utf8" }).trim();
  const built = buildSprintReceipt({
    id: "review-a", itemId: "a", phase: "review", status: "failed", candidateSha: head,
    findings: [{ code: "unsafe" }], worktreePath: repoRoot, implementationAttempt: 1,
    signReceipt: () => RECEIPT_TOKEN,
  });
  assert.equal(built.candidateSha, head);
  assert.match(built.progressFingerprint, /^[0-9a-f]{64}$/);
  assert.throws(() => buildSprintReceipt({
    id: "review-a", itemId: "a", phase: "review", candidateSha: SHA_A,
    worktreePath: repoRoot, signReceipt: () => RECEIPT_TOKEN,
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
  }, VERIFY_APPROVAL);
  assert.equal(result.items.a.state, "review_ready");
  assert.deepEqual(result.actions, [{
    type: "dispatch", itemId: "a", phase: "review", wave: 1, attempt: 2,
    candidateSha: SHA_B, implementationAttempt: 2,
  }]);
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

test("stale signed approval cannot authorize a changed current target in flight or completion", () => {
  const sprint = plan(["- [ ] A {id: a} {deps: none} {disposition: merge-local}"]);
  const approved = approval("a", SHA_A, "merge-local");
  const changedTargets = { a: { workBranch: "work/a", baseBranch: "release", baseHeadSha: SHA_B } };
  const baseProgress = {
    integrationTargets: changedTargets, approvals: [approved],
    receipts: [
      { ...receipt("impl-a", "a", "implementation"), candidateSha: SHA_A },
      { ...receipt("review-a", "a", "review"), candidateSha: SHA_A },
    ],
  };
  const flightResult = reconcileSprintProgress(sprint, {
    ...baseProgress,
    inFlight: [{ ...flight("a", "integration"), approvalDigest: approved.digest }],
  }, VERIFY_APPROVAL);
  assert.equal(flightResult.next, "invalid");
  assert.match(flightResult.errors.join(" "), /trusted approval/);

  const completion = reconcileSprintProgress(sprint, {
    ...baseProgress,
    receipts: [...baseProgress.receipts, {
      ...receipt("integrate-a", "a", "integration"), candidateSha: SHA_A, approvalDigest: approved.digest,
    }],
  }, VERIFY_APPROVAL);
  assert.equal(completion.next, "invalid");
  assert.match(completion.errors.join(" "), /exact-head approval/);
});

test("approval freshness, canonical identity encoding, and receipt provenance fail closed", () => {
  const sprint = plan(["- [ ] A {id: a} {deps: none} {disposition: merge-local}"]);
  const old = approval("a", SHA_A, "merge-local");
  old.approvedAt = "2000-01-01T00:00:00.000Z";
  old.digest = integrationApprovalDigest(old);
  const expired = reconcileSprintProgress(sprint, {
    receipts: [], integrationTargets: integrationTarget("a"), approvals: [old], runId: RUN_ID,
  }, VERIFY_APPROVAL);
  assert.equal(expired.next, "invalid");

  const historical = reconcileSprintProgress(sprint, {
    integrationTargets: integrationTarget("a"), approvals: [old], runId: RUN_ID,
    receipts: [
      { ...receipt("impl-a", "a", "implementation"), candidateSha: SHA_A },
      { ...receipt("review-a", "a", "review"), candidateSha: SHA_A },
      { ...receipt("integrate-a", "a", "integration"), candidateSha: SHA_A, approvalDigest: old.digest },
    ],
  }, VERIFY_APPROVAL);
  assert.equal(historical.next, "terminal");

  assert.throws(() => integrationApprovalDigest({
    ...authorization("a", SHA_A, "merge-local"), approvedBy: "a\0b", approvedAt: new Date().toISOString(),
    runId: RUN_ID, nonce: "nonce",
  }), /control characters/);

  const forged = reconcileSprintProgressRaw(
    plan(["- [ ] A {id: a} {deps: none} {disposition: pr}"]),
    { receipts: [receipt("impl-a", "a", "implementation"), receipt("review-a", "a", "review")] },
  );
  assert.equal(forged.next, "invalid");
  assert.match(forged.errors.join(" "), /trusted parent evidence/);
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

test("every review and integration outcome requires candidate binding", () => {
  const sprint = plan(["- [ ] A {id: a} {deps: none} {disposition: merge-push}"]);
  for (const phase of ["review", "integration"]) {
    const unbound = receipt(`failed-${phase}`, "a", phase, "failed");
    delete unbound.candidateSha;
    const result = reconcileSprintProgress(sprint, {
      receipts: [{ ...unbound, terminalReason: "external-impossibility" }],
    });
    assert.equal(result.next, "invalid");
    assert.match(result.errors.join(" "), /candidateSha/);
  }
});

test("conflicting duplicate flights and unauthorized integration flights fail closed", () => {
  const sprint = plan(["- [ ] A {id: a} {deps: none} {disposition: merge-local}"]);
  for (const inFlight of [[
    { ...flight("a", "review"), candidateSha: SHA_A },
    { ...flight("a", "review"), candidateSha: SHA_B },
  ], [
    { ...flight("a", "review"), candidateSha: SHA_B },
    { ...flight("a", "review"), candidateSha: SHA_A },
  ]]) {
    const result = reconcileSprintProgress(sprint, { inFlight });
    assert.equal(result.next, "invalid");
    assert.match(result.errors.join(" "), /conflicting identity/);
  }
  const unauthorized = reconcileSprintProgress(sprint, {
    receipts: [
      { ...receipt("impl-a", "a", "implementation"), candidateSha: SHA_A },
      { ...receipt("review-a", "a", "review"), candidateSha: SHA_A },
    ],
    inFlight: [{ ...flight("a", "integration"), approvalDigest: "2".repeat(64) }],
  });
  assert.equal(unauthorized.next, "invalid");
  assert.match(unauthorized.errors.join(" "), /trusted approval/);
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
  }, VERIFY_APPROVAL);
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
  }, VERIFY_APPROVAL);
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
    await writeFile(input, JSON.stringify(signedCliProgress({
      plan: plan(["- [ ] A {id: a} {deps: none} {disposition: pr}"]),
      inFlight: [flight("a", "implementation")],
      receipts: [receipt("impl-a", "a", "implementation")],
    })));
    const { stdout } = await pexecFile(process.execPath, [cli, "sprint-reconcile", input], {
      cwd: repoRoot, env: { ...process.env, MUSTER_LIFECYCLE_RECEIPT_PUBLIC_KEY: receiptPublicKey },
    });
    const result = JSON.parse(stdout);

    assert.equal(result.next, "dispatch");
    assert.deepEqual(result.actions, [{ type: "dispatch", itemId: "a", phase: "review", wave: 1, candidateSha: SHA_A, implementationAttempt: 1 }]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("sprint-reconcile CLI reads recovery policy from trusted environment, not mailbox JSON", async () => {
  const dir = await mkdtemp(join(tmpdir(), "muster-sprint-recovery-policy-"));
  try {
    const input = join(dir, "progress.json");
    await writeFile(input, JSON.stringify(signedCliProgress({
      plan: plan(["- [ ] A {id: a} {deps: none} {disposition: pr}"]),
      recovery: { noProgressLimit: 1 },
      receipts: [
        { ...receipt("impl-a-1", "a", "implementation"), candidateSha: SHA_A },
        { ...receipt("review-a-1", "a", "review", "failed"), candidateSha: SHA_A, progressFingerprint: FINDING_A },
        { ...receipt("impl-a-2", "a", "implementation", "completed", 2), candidateSha: SHA_A },
        { ...receipt("review-a-2", "a", "review", "failed", 2), candidateSha: SHA_A, progressFingerprint: FINDING_A },
      ],
    })));
    const { stdout } = await pexecFile(process.execPath, [cli, "sprint-reconcile", input], {
      cwd: repoRoot,
      env: {
        ...process.env, MUSTER_RECOVERY_NO_PROGRESS_LIMIT: "3", MUSTER_RECOVERY_MAX_CONTINUATIONS: "10",
        MUSTER_LIFECYCLE_RECEIPT_PUBLIC_KEY: receiptPublicKey,
      },
    });
    const result = JSON.parse(stdout);
    assert.equal(result.next, "dispatch");
    assert.equal(result.actions[0].recovery, "repair");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("sprint-reconcile CLI round-trips exact-head approval into integration dispatch", async () => {
  const dir = await mkdtemp(join(tmpdir(), "muster-sprint-approval-"));
  try {
    const input = join(dir, "progress.json");
    const sprint = plan(["- [ ] A {id: a} {deps: none} {disposition: merge-local}"]);
    const progress = {
      plan: sprint,
      receipts: [
        { ...receipt("impl-a", "a", "implementation"), candidateSha: SHA_A },
        { ...receipt("review-a", "a", "review"), candidateSha: SHA_A },
      ],
      inFlight: [], integrationTargets: integrationTarget("a"), approvals: [],
    };
    await writeFile(input, JSON.stringify(signedCliProgress(progress)));
    const requested = JSON.parse((await pexecFile(process.execPath, [cli, "sprint-reconcile", input], {
      cwd: repoRoot, env: { ...process.env, MUSTER_LIFECYCLE_RECEIPT_PUBLIC_KEY: receiptPublicKey },
    })).stdout);
    assert.equal(requested.actions[0].type, "approval");

    const approved = approval("a", SHA_A, "merge-local");
    approved.evidence = sign(null, Buffer.from(approved.digest, "hex"), approvalPrivateKey).toString("base64");
    progress.approvals = [approved];
    progress.runId = RUN_ID;
    await writeFile(input, JSON.stringify(signedCliProgress(progress)));
    const dispatched = JSON.parse((await pexecFile(process.execPath, [cli, "sprint-reconcile", input], {
      cwd: repoRoot,
      env: {
        ...process.env, MUSTER_INTEGRATION_APPROVAL_PUBLIC_KEY: approvalPublicKey,
        MUSTER_LIFECYCLE_RECEIPT_PUBLIC_KEY: receiptPublicKey,
        MUSTER_RUN_ID: RUN_ID,
      },
    })).stdout);
    assert.deepEqual(dispatched.actions, [{
      type: "dispatch", itemId: "a", phase: "integration", wave: 1,
      candidateSha: SHA_A, approvalDigest: approved.digest,
    }]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("privileged IPC broker binds callback capabilities, assignments, and fresh approval", async () => {
  const dir = await mkdtemp(join(tmpdir(), "muster-sprint-issuers-"));
  const runnerToken = "runner-host-callback-token-012345";
  const humanToken = "human-host-callback-token-0123456";
  const integrationToken = "integration-host-callback-token";
  const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoRoot, encoding: "utf8" }).trim();
  const branch = execFileSync("git", ["symbolic-ref", "--short", "HEAD"], { cwd: repoRoot, encoding: "utf8" }).trim();
  const common = resolve(repoRoot, execFileSync("git", ["rev-parse", "--git-common-dir"], { cwd: repoRoot, encoding: "utf8" }).trim());
  const baseHeadSha = "b".repeat(40);
  const approvalTuple = {
    itemId: "a", workBranch: branch, workHeadSha: head,
    baseBranch: "main", baseHeadSha, operation: "merge-local",
  };
  const assignments = {
    runId: RUN_ID,
    callbackPrincipals: {
      [createHash("sha256").update(runnerToken).digest("hex")]: { actorId: "runner-a", purposes: ["implementation"] },
      [createHash("sha256").update(humanToken).digest("hex")]: { actorId: "human-a", purposes: ["approval"] },
      [createHash("sha256").update(integrationToken).digest("hex")]: { actorId: "integrator", purposes: ["integration"] },
    },
    items: {
      a: {
        worktreePath: repoRoot, branch, gitCommonDir: common,
        actors: { implementation: "runner-a", review: "reviewer-a", integration: "integrator", approval: "human-a" },
        integrationTarget: { baseBranch: "main", baseHeadSha, operation: "merge-local" },
        approvalActionDigest: integrationApprovalDigest(approvalTuple),
      },
    },
  };
  const socketPath = join(dir, "broker.sock");
  const broker = startSprintEvidenceBroker({
    socketPath, state: assignments, receiptPrivateKey, approvalPrivateKey, approvalPublicKey,
  });
  await once(broker, "listening");
  const callback = (kind, file, token) => pexecFile(process.execPath, [callbackCli, kind, file], {
    cwd: repoRoot,
    env: { ...process.env, MUSTER_EVIDENCE_BROKER_SOCKET: socketPath, MUSTER_EVIDENCE_CALLBACK_TOKEN: token },
  });
  try {
    const receiptFile = join(dir, "receipt.json");
    await writeFile(receiptFile, JSON.stringify({
      id: "impl-a", itemId: "a", phase: "implementation", status: "completed", candidateSha: head,
    }));
    const issuedReceipt = JSON.parse((await callback("receipt", receiptFile, runnerToken)).stdout);
    assert.match(issuedReceipt.evidence, /^[A-Za-z0-9+/]{86}==$/);

    await writeFile(receiptFile, JSON.stringify({
      id: "impl-a", itemId: "a", phase: "implementation", status: "completed", candidateSha: head,
      worktreePath: repoRoot,
    }));
    await assert.rejects(callback("receipt", receiptFile, runnerToken), /forbidden fields: worktreePath/);
    await assert.rejects(callback("receipt", receiptFile, "forged-callback-token-012345"), /broker callback authentication failed/);

    const approvalFile = join(dir, "approval.json");
    await writeFile(approvalFile, JSON.stringify(approvalTuple));
    const issuedApproval = JSON.parse((await callback("approval", approvalFile, humanToken)).stdout);
    assert.equal(issuedApproval.approvedBy, "human-a");
    assert.match(issuedApproval.evidence, /^[A-Za-z0-9+/]{86}==$/);

    await writeFile(approvalFile, JSON.stringify({ ...approvalTuple, approvedBy: "caller-asserted-human" }));
    await assert.rejects(callback("approval", approvalFile, humanToken), /forbidden fields: approvedBy/);

    const expired = { ...issuedApproval, approvedAt: new Date(Date.now() - 16 * 60 * 1000).toISOString() };
    expired.digest = integrationApprovalDigest(expired);
    expired.evidence = sign(null, Buffer.from(expired.digest, "hex"), approvalPrivateKey).toString("base64");
    await writeFile(receiptFile, JSON.stringify({
      id: "integration-a", itemId: "a", phase: "integration", status: "completed", candidateSha: head,
      approvalDigest: expired.digest, approval: expired,
    }));
    await assert.rejects(callback("receipt", receiptFile, integrationToken), /fresh exact authenticated approval/);
    await assert.rejects(pexecFile(process.execPath, [cli, "sprint-receipt-issue", receiptFile], {
      cwd: repoRoot, env: { ...process.env, MUSTER_LIFECYCLE_RECEIPT_PUBLIC_KEY: receiptPublicKey },
    }), /unknown command/);
  } finally {
    broker.close();
    await once(broker, "close");
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
