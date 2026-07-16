import { test } from "node:test";
import assert from "node:assert/strict";
import { planGateCadence, SMALL_TASK_THRESHOLD } from "../src/gate-cadence.js";

test("non-array input throws", () => {
  assert.throws(() => planGateCadence(null), /waves must be an array/i);
  assert.throws(() => planGateCadence("nope"), /waves must be an array/i);
});

test("no tasks: zero gate rounds either way", () => {
  const r = planGateCadence([]);
  assert.equal(r.taskCount, 0);
  assert.equal(r.specGateRounds, 0);
  assert.equal(r.reviewGateBatches, 0);
  assert.equal(r.fastPath, false);
});

test("single trivial task, no parallel wave: spec gate skipped entirely (existing rule), one review pass", () => {
  const r = planGateCadence([["t1"]]);
  assert.equal(r.taskCount, 1);
  assert.equal(r.waveCount, 1);
  assert.equal(r.specGateRounds, 0);
  assert.equal(r.reviewGateBatches, 1);
  assert.equal(r.fastPath, true);
});

test("3-task plan across 3 sequential waves: no more than 1 spec-gate round, review batched into 1 pass", () => {
  const r = planGateCadence([["t1"], ["t2"], ["t3"]]);
  assert.equal(r.taskCount, 3);
  assert.equal(r.waveCount, 3);
  assert.ok(r.specGateRounds <= 1, "spec-gate rounds must not exceed 1 for a 3-task run");
  assert.equal(r.reviewGateBatches, 1, "small plans batch the per-wave review gate into a single pass");
  assert.equal(r.fastPath, true);
});

test("3-task plan in one parallel wave: same fast-path outcome as the sequential shape", () => {
  const r = planGateCadence([["t1", "t2", "t3"]]);
  assert.equal(r.taskCount, 3);
  assert.equal(r.waveCount, 1);
  assert.equal(r.specGateRounds, 1);
  assert.equal(r.reviewGateBatches, 1);
  assert.equal(r.fastPath, true);
});

test(`plans at exactly the ${SMALL_TASK_THRESHOLD}-task threshold still qualify for the fast path`, () => {
  const waves = Array.from({ length: SMALL_TASK_THRESHOLD }, (_, i) => [`t${i + 1}`]);
  const r = planGateCadence(waves);
  assert.equal(r.taskCount, SMALL_TASK_THRESHOLD);
  assert.equal(r.fastPath, true);
  assert.equal(r.reviewGateBatches, 1);
});

test("a plan one task above the threshold does NOT qualify for the fast path", () => {
  const waves = Array.from({ length: SMALL_TASK_THRESHOLD + 1 }, (_, i) => [`t${i + 1}`]);
  const r = planGateCadence(waves);
  assert.equal(r.taskCount, SMALL_TASK_THRESHOLD + 1);
  assert.equal(r.fastPath, false);
});

test("10-task plan across 5 waves: depth scales with wave count, not forced to 1 (gates stay full-strength)", () => {
  const r = planGateCadence([["t1", "t2"], ["t3", "t4"], ["t5", "t6"], ["t7", "t8"], ["t9", "t10"]]);
  assert.equal(r.taskCount, 10);
  assert.equal(r.waveCount, 5);
  assert.equal(r.specGateRounds, 1);
  assert.equal(r.reviewGateBatches, 5, "large plans keep one review-gate pass per wave — depth proportional to task count");
  assert.equal(r.fastPath, false);
});

test("reviewGateBatches never exceeds waveCount", () => {
  const r = planGateCadence([["t1", "t2"], ["t3", "t4"], ["t5", "t6"], ["t7", "t8"]]);
  assert.ok(r.reviewGateBatches <= r.waveCount);
});

test("every result carries a human-readable reason string (glass-box)", () => {
  for (const waves of [[], [["t1"]], [["t1"], ["t2"], ["t3"]], [["t1", "t2"], ["t3", "t4"], ["t5", "t6"], ["t7", "t8"], ["t9", "t10"]]]) {
    const r = planGateCadence(waves);
    assert.equal(typeof r.reason, "string");
    assert.ok(r.reason.length > 0);
  }
});
