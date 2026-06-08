import { test } from "node:test";
import assert from "node:assert/strict";
import { loopState } from "../src/loop.js";

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
