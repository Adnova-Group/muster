import { test } from "node:test";
import assert from "node:assert/strict";
import {
  loopState,
  TASK_MAX_ITERATIONS,
  reviewGateState,
  REVIEW_GATE_MAX_ITERATIONS,
  REVIEW_GATE_MAX_TOTAL_ITERATIONS,
  dispatchRetryState,
  DISPATCH_MAX_ATTEMPTS,
  DISPATCH_MAX_TOTAL_ATTEMPTS,
} from "../src/loop.js";

test("continues while not done and under the cap", () => {
  assert.deepEqual(loopState({ iteration: 0, maxIterations: 25, done: false }), { continue: true, reason: "iterate" });
  assert.deepEqual(loopState({ iteration: 24, maxIterations: 25, done: false }), { continue: true, reason: "iterate" });
});
test("stops when done (the completion promise is genuinely true)", () => {
  assert.deepEqual(loopState({ iteration: 3, maxIterations: 25, done: true }), { continue: false, reason: "done" });
});
test("stops at the cap (escalate, do not loop forever)", () => {
  assert.deepEqual(loopState({ iteration: 25, maxIterations: 25, done: false }), { continue: false, reason: "max-iterations" });
});
test("defaults: maxIterations 25, done false", () => {
  assert.equal(loopState({ iteration: 0 }).continue, true);
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
// B-C8: boundary — attempt 0 (first invocation, before any attempt has been made)
test("dispatchRetryState({attempt:0}) retries (boundary: below DISPATCH_MAX_ATTEMPTS)", () => {
  assert.deepEqual(dispatchRetryState({ attempt: 0 }), { retry: true, reason: "retry" });
});
test("dispatchRetryState retries on first failure (attempt 1, not succeeded)", () => {
  assert.deepEqual(dispatchRetryState({ attempt: 1 }), { retry: true, reason: "retry" });
});
test("dispatchRetryState exhausted at attempt >= DISPATCH_MAX_ATTEMPTS", () => {
  assert.deepEqual(dispatchRetryState({ attempt: 2 }), { retry: false, reason: "attempts-exhausted" });
  assert.deepEqual(dispatchRetryState({ attempt: 3 }), { retry: false, reason: "attempts-exhausted" });
});
test("dispatchRetryState: succeeded short-circuits before the cap", () => {
  assert.deepEqual(dispatchRetryState({ attempt: 1, succeeded: true }), { retry: false, reason: "succeeded" });
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
