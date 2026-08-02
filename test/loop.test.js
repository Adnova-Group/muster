import { test } from "node:test";
import assert from "node:assert/strict";
import {
  loopState,
  progressAwareState,
  reviewGateState,
  specGateRecoveryState,
  dispatchRetryState,
  DEFAULT_NO_PROGRESS_LIMIT,
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

const SAFETY_FINDINGS = [
  { severity: "blocker", code: "target-identity", note: "target identity is unbound" },
  { severity: "blocker", code: "backup-restoration", note: "backup restoration proof is absent" },
  { severity: "blocker", code: "schema-normalization", note: "schema normalization scope is incomplete" },
  { severity: "blocker", code: "protected-sql-provenance", note: "protected SQL provenance is missing" },
  { severity: "blocker", code: "mutation-allowlist", note: "mutation allowlist is not bound" },
];

test("changed spec candidates preserve repeated safety findings and continue beyond the old round cap", () => {
  const rounds = ["candidate:a", "candidate:b", "candidate:c", "candidate:d"].map((candidateFingerprint) => ({
    candidateFingerprint,
    findings: SAFETY_FINDINGS,
  }));
  assert.deepEqual(specGateRecoveryState({ rounds }), {
    continue: true,
    reason: "progress",
    noProgressCount: 1,
    action: {
      type: "correction-replan",
      invalidateCandidate: "candidate:d",
      findings: SAFETY_FINDINGS,
      requireMaterialChange: true,
      next: "independent-spec-review",
    },
  });
});

test("byte-identical spec candidates stop deterministically without waiving safety findings", () => {
  const rounds = ["candidate:a", "candidate:a"].map((candidateFingerprint) => ({
    candidateFingerprint,
    findings: SAFETY_FINDINGS,
  }));
  assert.deepEqual(specGateRecoveryState({ rounds }), {
    continue: false,
    reason: "no-progress",
    noProgressCount: 2,
    findings: SAFETY_FINDINGS,
  });
});
