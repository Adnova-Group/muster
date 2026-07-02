import { test } from "node:test";
import assert from "node:assert/strict";
import { loopState, reviewGateState, REVIEW_GATE_MAX_ITERATIONS, dispatchRetryState, DISPATCH_MAX_ATTEMPTS } from "../src/loop.js";

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

// reviewGateState: the cap (3) IS the contract — these tests encode that.
test("REVIEW_GATE_MAX_ITERATIONS is 3", () => {
  assert.equal(REVIEW_GATE_MAX_ITERATIONS, 3);
});
test("reviewGateState caps at 3 (escalates at iteration 3)", () => {
  assert.deepEqual(reviewGateState({ iteration: 2, done: false }), { continue: true, reason: "iterate" });
  assert.deepEqual(reviewGateState({ iteration: 3, done: false }), { continue: false, reason: "max-iterations" });
});
test("reviewGateState: caller cannot override the cap upward", () => {
  // maxIterations: 99 must be silently dropped — cap is fixed at 3
  assert.deepEqual(reviewGateState({ iteration: 3, done: false, maxIterations: 99 }), { continue: false, reason: "max-iterations" });
});
test("reviewGateState: done still short-circuits before the cap", () => {
  assert.deepEqual(reviewGateState({ iteration: 1, done: true }), { continue: false, reason: "done" });
});

// dispatchRetryState: cap (2) IS the contract — these tests encode that.
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
