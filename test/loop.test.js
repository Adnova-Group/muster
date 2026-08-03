import { test } from "node:test";
import assert from "node:assert/strict";
import {
  loopState,
  TASK_MAX_ITERATIONS,
  progressAwareState,
  reviewGateState,
  REVIEW_GATE_MAX_ITERATIONS,
  REVIEW_GATE_MAX_TOTAL_ITERATIONS,
  specGateRecoveryState,
  dispatchRetryState,
  DISPATCH_MAX_ATTEMPTS,
  DISPATCH_MAX_TOTAL_ATTEMPTS,
  DEFAULT_NO_PROGRESS_LIMIT,
  MAX_RECOVERY_CONTINUATIONS,
} from "../src/loop.js";

test("continues while not done and under a configured cap", () => {
  assert.deepEqual(loopState({ iteration: 0, maxIterations: 25 }), { continue: true, reason: "iterate" });
  assert.deepEqual(loopState({ iteration: 24, maxIterations: 25 }), { continue: true, reason: "iterate" });
});

test("stops when done", () => {
  assert.deepEqual(loopState({ iteration: 3, maxIterations: 25, done: true }), { continue: false, reason: "done" });
});

test("honors an explicitly configured hard cap", () => {
  assert.deepEqual(loopState({ iteration: 25, maxIterations: 25 }), { continue: false, reason: "max-iterations" });
});

// reviewGateState: 3 is the configurable default no-progress budget.
test("REVIEW_GATE_MAX_ITERATIONS is 3", () => {
  assert.equal(REVIEW_GATE_MAX_ITERATIONS, 3);
});
test("reviewGateState caps at 3 (escalates at iteration 3)", () => {
  assert.deepEqual(reviewGateState({ iteration: 2, done: false }), { continue: true, reason: "iterate" });
  assert.deepEqual(reviewGateState({ iteration: 3, done: false }), { continue: false, reason: "max-iterations" });
});
test("reviewGateState: caller can configure the no-progress budget", () => {
  assert.deepEqual(reviewGateState({ iteration: 3, done: false, maxIterations: 4 }), { continue: true, reason: "iterate" });
});
test("reviewGateState: done still short-circuits before the cap", () => {
  assert.deepEqual(reviewGateState({ iteration: 1, done: true }), { continue: false, reason: "done" });
});

// dispatchRetryState: 2 is the configurable default attempt budget.
test("DISPATCH_MAX_ATTEMPTS is 2", () => {
  assert.equal(DISPATCH_MAX_ATTEMPTS, 2);
});
test("dispatchRetryState retries before its configured attempt budget", () => {
  assert.deepEqual(dispatchRetryState({ attempt: 0 }), { retry: true, reason: "retry" });
  assert.deepEqual(dispatchRetryState({ attempt: 1 }), { retry: true, reason: "retry" });
});
test("dispatchRetryState exhausts its configured attempt budget", () => {
  assert.deepEqual(dispatchRetryState({ attempt: 2 }), { retry: false, reason: "attempts-exhausted" });
  assert.deepEqual(dispatchRetryState({ attempt: 3 }), { retry: false, reason: "attempts-exhausted" });
});
test("dispatchRetryState success short-circuits the configured budget", () => {
  assert.deepEqual(dispatchRetryState({ attempt: 1, succeeded: true }), { retry: false, reason: "succeeded" });
});

test("the generic loop has no arbitrary default iteration stop", () => {
  assert.deepEqual(loopState({ iteration: 25 }), { continue: true, reason: "iterate" });
  assert.deepEqual(loopState({ iteration: 250 }), { continue: true, reason: "iterate" });
});

test("progress-aware recovery stops after a configurable identical-outcome streak", () => {
  assert.equal(DEFAULT_NO_PROGRESS_LIMIT, 2);
  assert.deepEqual(progressAwareState({ outcomes: ["same", "same"] }), {
    continue: false, reason: "no-progress", noProgressCount: 2,
  });
  assert.deepEqual(progressAwareState({ outcomes: ["same", "same"], noProgressLimit: 3 }), {
    continue: true, reason: "progress", noProgressCount: 2,
  });
});

test("changing review outcomes keep recovery alive beyond three rounds", () => {
  assert.deepEqual(reviewGateState({ outcomes: ["commit:a", "commit:b", "commit:c", "commit:d"] }), {
    continue: true, reason: "progress", noProgressCount: 1,
  });
});

test("review recovery terminates on a repeated identical finding", () => {
  assert.deepEqual(reviewGateState({ outcomes: ["blocker:x", "blocker:x"] }), {
    continue: false, reason: "no-progress", noProgressCount: 2,
  });
});

test("reviewGateState completion short-circuits recovery", () => {
  assert.deepEqual(reviewGateState({ outcomes: ["blocker:x"], done: true }), {
    continue: false, reason: "done", noProgressCount: 0,
  });
});

test("dispatch retry continues while failure fingerprints change", () => {
  assert.deepEqual(dispatchRetryState({ outcomes: ["timeout", "provider-fallback", "replanned"] }), {
    retry: true, reason: "progress", noProgressCount: 1,
  });
});

test("dispatch retry stops deterministically when the outcome repeats", () => {
  assert.deepEqual(dispatchRetryState({ outcomes: ["timeout", "timeout"] }), {
    retry: false, reason: "no-progress", noProgressCount: 2,
  });
});

test("dispatchRetryState success short-circuits recovery", () => {
  assert.deepEqual(dispatchRetryState({ outcomes: ["timeout"], succeeded: true }), {
    retry: false, reason: "succeeded", noProgressCount: 0,
  });
});

test("approval, HUMAN-HOLD, and external impossibility are truthful terminal states", () => {
  for (const terminalReason of ["approval", "human-hold", "external-impossibility"]) {
    assert.deepEqual(progressAwareState({ outcomes: ["progress"], terminalReason }), {
      continue: false, reason: terminalReason, noProgressCount: 0,
    });
  }
});

test("recovery has a configurable but non-waivable runaway backstop", () => {
  assert.equal(MAX_RECOVERY_CONTINUATIONS, 100);
  assert.throws(() => progressAwareState({ outcomes: ["a"], maxContinuations: 101 }), /1 to 100/);
  assert.deepEqual(progressAwareState({ outcomes: ["a", "b", "c"], maxContinuations: 3 }), {
    continue: false, reason: "max-continuations", noProgressCount: 1,
  });
});

const SAFETY_FINDINGS = [
  { severity: "blocker", code: "target-identity", note: "target identity is unbound" },
  { severity: "blocker", code: "backup-restoration", note: "backup restoration proof is absent" },
  { severity: "blocker", code: "schema-normalization", note: "schema normalization scope is incomplete" },
  { severity: "blocker", code: "protected-sql-provenance", note: "protected SQL provenance is missing" },
  { severity: "blocker", code: "mutation-allowlist", note: "mutation allowlist is not bound" },
];
const EVIDENCE_DIGEST = "e".repeat(64);
const SPEC_A = "a".repeat(64);
const SPEC_B = "b".repeat(64);
const SPEC_C = "c".repeat(64);
const SPEC_D = "d".repeat(64);

test("changed spec candidates preserve repeated safety findings and continue beyond the old round cap", () => {
  const rounds = [SPEC_A, SPEC_B, SPEC_C, SPEC_D].map((candidateFingerprint) => ({
    candidateFingerprint,
    findings: SAFETY_FINDINGS,
    verdict: "FAIL",
    reviewer: "independent-reviewer",
    evidenceDigest: EVIDENCE_DIGEST,
  }));
  assert.deepEqual(specGateRecoveryState({ rounds }), {
    continue: true,
    reason: "progress",
    noProgressCount: 1,
    action: {
      type: "correction-replan",
      invalidateCandidate: SPEC_D,
      findings: SAFETY_FINDINGS,
      requireMaterialChange: true,
      next: "independent-spec-review",
    },
  });
});

test("byte-identical spec candidates stop deterministically without waiving safety findings", () => {
  const rounds = [SPEC_A, SPEC_A].map((candidateFingerprint) => ({
    candidateFingerprint,
    findings: SAFETY_FINDINGS,
    verdict: "FAIL",
    reviewer: "independent-reviewer",
    evidenceDigest: EVIDENCE_DIGEST,
  }));
  assert.deepEqual(specGateRecoveryState({ rounds }), {
    continue: false,
    reason: "no-progress",
    noProgressCount: 2,
    findings: SAFETY_FINDINGS,
  });
});

test("spec completion requires explicit independent PASS evidence bound to the candidate", () => {
  assert.throws(() => specGateRecoveryState({ rounds: [{
    candidateFingerprint: SPEC_A,
    findings: [],
    verdict: "FAIL",
    reviewer: "independent-reviewer",
    evidenceDigest: EVIDENCE_DIGEST,
  }] }), /verdict-consistent/);
  assert.deepEqual(specGateRecoveryState({ rounds: [{
    candidateFingerprint: SPEC_A,
    findings: [],
    verdict: "PASS",
    reviewer: "independent-reviewer",
    evidenceDigest: EVIDENCE_DIGEST,
  }] }), { continue: false, reason: "done", noProgressCount: 0, findings: [] });
});

test("a rejected spec candidate cannot be resurrected by a later PASS or caller done flag", () => {
  const fail = {
    candidateFingerprint: SPEC_A,
    findings: SAFETY_FINDINGS,
    verdict: "FAIL",
    reviewer: "independent-reviewer",
    evidenceDigest: EVIDENCE_DIGEST,
  };
  const pass = { ...fail, findings: [], verdict: "PASS" };
  assert.deepEqual(specGateRecoveryState({ rounds: [fail, pass] }), {
    continue: false, reason: "no-progress", noProgressCount: 2,
    findings: SAFETY_FINDINGS, evidenceDigest: EVIDENCE_DIGEST,
  });
  assert.throws(() => specGateRecoveryState({ rounds: [fail], done: true }), /explicit independent PASS/);
});

test("empty spec history produces a defined initial independent review action", () => {
  assert.deepEqual(specGateRecoveryState(), {
    continue: true,
    reason: "initial",
    noProgressCount: 0,
    action: { type: "independent-spec-review" },
  });
});

test("reviewGateState allows four monotonically improving fix passes", () => {
  const progress = [0, 1, 2, 3];
  for (let iteration = 1; iteration < progress.length; iteration++) {
    assert.deepEqual(reviewGateState({
      iteration,
      progress: progress[iteration],
      previousProgress: progress[iteration - 1],
    }), { continue: true, reason: "progress" });
  }
  assert.deepEqual(reviewGateState({ iteration: 4, done: true }), { continue: false, reason: "done" });
});

test("reviewGateState stops repeated identical no-progress findings deterministically", () => {
  assert.deepEqual(reviewGateState({
    iteration: 3,
    progress: 1,
    previousProgress: 1,
  }), { continue: false, reason: "max-iterations" });
});

test("reviewGateState exhausts an explicit fix budget", () => {
  assert.deepEqual(reviewGateState({ iteration: 4, maxIterations: 4 }), { continue: false, reason: "max-iterations" });
});

test("dispatchRetryState permits a third transient attempt under an explicit budget", () => {
  assert.deepEqual(dispatchRetryState({
    attempt: 2,
    maxAttempts: 3,
  }), { retry: true, reason: "retry" });
  assert.deepEqual(dispatchRetryState({ attempt: 3, succeeded: true }), { retry: false, reason: "succeeded" });
});

test("dispatchRetryState stops repeated identical failures at its configured budget", () => {
  assert.deepEqual(dispatchRetryState({
    attempt: 3,
    maxAttempts: 3,
    progress: 0,
    previousProgress: 0,
  }), { retry: false, reason: "attempts-exhausted" });
});

test("progress must be strictly monotonic; flat, regressing, and non-finite scores cannot extend a budget", () => {
  for (const [progress, previousProgress] of [[2, 2], [1, 2], [NaN, 2], [3, Infinity]]) {
    assert.deepEqual(reviewGateState({ iteration: 3, progress, previousProgress }), {
      continue: false,
      reason: "max-iterations",
    });
  }
});

test("loopState lets a cohesive 26-step worker complete under an explicit task budget", () => {
  assert.deepEqual(loopState({ iteration: 25, maxIterations: 26 }), { continue: true, reason: "iterate" });
  assert.deepEqual(loopState({ iteration: 26, maxIterations: 26, done: true }), { continue: false, reason: "done" });
});

test("invalid configured budgets fail closed before progress can extend them", () => {
  for (const maxIterations of [NaN, Infinity, 0, -1, 1.5, "3", TASK_MAX_ITERATIONS + 1]) {
    assert.deepEqual(loopState({ iteration: 0, maxIterations }), {
      continue: false,
      reason: "invalid-max-iterations",
    });
  }

  for (const maxIterations of [NaN, Infinity, 0, -1, 1.5, "3", REVIEW_GATE_MAX_TOTAL_ITERATIONS + 1]) {
    assert.deepEqual(reviewGateState({
      iteration: Number.MAX_SAFE_INTEGER,
      maxIterations,
      progress: 2,
      previousProgress: 1,
    }), { continue: false, reason: "invalid-max-iterations" });
  }

  for (const maxAttempts of [NaN, Infinity, 0, -1, 1.5, "3", DISPATCH_MAX_TOTAL_ATTEMPTS + 1]) {
    assert.deepEqual(dispatchRetryState({
      attempt: Number.MAX_SAFE_INTEGER,
      maxAttempts,
      progress: 2,
      previousProgress: 1,
    }), { retry: false, reason: "invalid-max-attempts" });
  }
});

test("progress cannot bypass the absolute review and dispatch ceilings", () => {
  assert.deepEqual(reviewGateState({
    iteration: REVIEW_GATE_MAX_TOTAL_ITERATIONS,
    progress: 2,
    previousProgress: 1,
  }), { continue: false, reason: "max-total-iterations" });
  assert.deepEqual(dispatchRetryState({
    attempt: DISPATCH_MAX_TOTAL_ATTEMPTS,
    progress: 2,
    previousProgress: 1,
  }), { retry: false, reason: "max-total-attempts" });
});

test("fingerprint-based review recovery honors configured and absolute budgets", () => {
  assert.deepEqual(reviewGateState({
    outcomes: ["a", "b", "c", "d"],
    maxIterations: 4,
  }), { continue: false, reason: "max-iterations", noProgressCount: 1 });
  assert.deepEqual(reviewGateState({
    outcomes: Array.from({ length: REVIEW_GATE_MAX_TOTAL_ITERATIONS }, (_, index) => `review-${index}`),
    maxContinuations: REVIEW_GATE_MAX_TOTAL_ITERATIONS,
  }), { continue: false, reason: "max-total-iterations", noProgressCount: 1 });
  assert.deepEqual(reviewGateState({
    outcomes: ["a"],
    maxContinuations: REVIEW_GATE_MAX_TOTAL_ITERATIONS + 1,
  }), { continue: false, reason: "invalid-max-iterations" });
});

test("fingerprint-based dispatch recovery honors configured and absolute budgets", () => {
  assert.deepEqual(dispatchRetryState({
    outcomes: ["a", "b", "c"],
    maxAttempts: 3,
  }), { retry: false, reason: "attempts-exhausted", noProgressCount: 1 });
  assert.deepEqual(dispatchRetryState({
    outcomes: Array.from({ length: DISPATCH_MAX_TOTAL_ATTEMPTS }, (_, index) => `dispatch-${index}`),
    maxContinuations: DISPATCH_MAX_TOTAL_ATTEMPTS,
  }), { retry: false, reason: "max-total-attempts", noProgressCount: 1 });
  assert.deepEqual(dispatchRetryState({
    outcomes: ["a"],
    maxContinuations: DISPATCH_MAX_TOTAL_ATTEMPTS + 1,
  }), { retry: false, reason: "invalid-max-attempts" });
});
