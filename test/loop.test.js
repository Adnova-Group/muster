import { test } from "node:test";
import assert from "node:assert/strict";
import { loopState, reviewGateState, REVIEW_GATE_MAX_ITERATIONS } from "../src/loop.js";

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
