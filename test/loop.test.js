import { test } from "node:test";
import assert from "node:assert/strict";
import {
  loopState,
  progressAwareState,
  reviewGateState,
  specGateRecoveryState,
  dispatchRetryState,
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
