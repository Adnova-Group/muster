import { test } from "node:test";
import assert from "node:assert/strict";
import {
  planGateCadence,
  SMALL_TASK_THRESHOLD,
  reviewerCountForDiff,
  DEFAULT_REVIEW_DIFF_THRESHOLD,
  reviewerReasoningForCount,
  REVIEWER_REASONING,
} from "../src/gate-cadence.js";

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

// ── weight-reduction item, criterion 2: review gates scale with diff size ──────────────
// A wave's (or, under fastPath, the cumulative batched) diff decides reviewer COUNT
// independently of the taskCount-driven batching above: a diff under the threshold gets
// ONE reviewer, not the default two (`code-review` + `security-review`, review-gate/
// SKILL.md step 1). This is a per-wave-fresh decision (diff size isn't known at plan time
// the way taskCount is), never captured/reused across waves the way capabilities/
// gate-cadence's own taskCount fields are.

test("reviewerCountForDiff: non-negative finite changedLines required", () => {
  assert.throws(() => reviewerCountForDiff(-1), /changedLines must be a non-negative finite number/i);
  assert.throws(() => reviewerCountForDiff(NaN), /changedLines must be a non-negative finite number/i);
  assert.throws(() => reviewerCountForDiff("200"), /changedLines must be a non-negative finite number/i);
  assert.throws(() => reviewerCountForDiff(Infinity), /changedLines must be a non-negative finite number/i);
});

test("reviewerCountForDiff: threshold option validated the same way", () => {
  assert.throws(() => reviewerCountForDiff(10, { threshold: -1 }), /threshold must be a non-negative finite number/i);
  assert.throws(() => reviewerCountForDiff(10, { threshold: NaN }), /threshold must be a non-negative finite number/i);
});

test(`reviewerCountForDiff: a diff under the default ${DEFAULT_REVIEW_DIFF_THRESHOLD}-line threshold gets ONE reviewer`, () => {
  assert.equal(reviewerCountForDiff(0), 1);
  assert.equal(reviewerCountForDiff(1), 1);
  assert.equal(reviewerCountForDiff(DEFAULT_REVIEW_DIFF_THRESHOLD - 1), 1);
});

test("reviewerCountForDiff: a diff at or over the threshold gets TWO reviewers (unchanged default)", () => {
  assert.equal(reviewerCountForDiff(DEFAULT_REVIEW_DIFF_THRESHOLD), 2);
  assert.equal(reviewerCountForDiff(DEFAULT_REVIEW_DIFF_THRESHOLD + 1), 2);
  assert.equal(reviewerCountForDiff(5000), 2);
});

test("reviewerCountForDiff: threshold is configurable (e.g. MUSTER_REVIEW_DIFF_THRESHOLD wiring in cli.js)", () => {
  assert.equal(reviewerCountForDiff(50, { threshold: 40 }), 2, "50 lines clears a 40-line threshold -> 2 reviewers");
  assert.equal(reviewerCountForDiff(30, { threshold: 40 }), 1, "30 lines stays under a 40-line threshold -> 1 reviewer");
});

test("planGateCadence: without changedLines, reviewerCount is omitted (backward compatible)", () => {
  const r = planGateCadence([["t1"]]);
  assert.equal("reviewerCount" in r, false);
});

test("planGateCadence: changedLines under threshold folds reviewerCount:1 into the same result, no separate call needed", () => {
  const r = planGateCadence([["t1"]], { changedLines: 50 });
  assert.equal(r.reviewerCount, 1);
  assert.equal(r.fastPath, true, "task-count fast path and diff-size reviewer scaling are independent axes");
});

test("planGateCadence: changedLines at/over threshold folds reviewerCount:2 in, even for a fastPath-eligible small plan", () => {
  const r = planGateCadence([["t1"], ["t2"], ["t3"]], { changedLines: 500 });
  assert.equal(r.reviewerCount, 2);
  assert.equal(r.fastPath, true, "a big diff on a small task count still batches to 1 review PASS, just with 2 reviewers in it");
});

test("planGateCadence: reviewDiffThreshold option overrides the default for the folded-in reviewerCount", () => {
  const r = planGateCadence([["t1"]], { changedLines: 50, reviewDiffThreshold: 40 });
  assert.equal(r.reviewerCount, 2, "50 lines clears a custom 40-line threshold");
});

test("unchanged-multiwave proof (criterion 5): a real multi-task/multi-wave outcome with a diff at the default threshold still gets full depth (proportional reviewGateBatches, NOT the fast path) and 2 reviewers, unchanged from the pre-weight-reduction baseline", () => {
  const waves = [["t1", "t2"], ["t3", "t4"], ["t5", "t6"], ["t7", "t8"], ["t9", "t10"]];
  const r = planGateCadence(waves, { changedLines: 1200 });
  assert.equal(r.taskCount, 10);
  assert.equal(r.waveCount, 5);
  assert.equal(r.fastPath, false, "a genuinely large multi-task plan never falls into the small-task fast path");
  assert.equal(r.specGateRounds, 1, "spec gate still runs (unchanged)");
  assert.equal(r.reviewGateBatches, 5, "review-gate cadence stays proportional to wave count (unchanged)");
  assert.equal(r.reviewerCount, 2, "a diff over the threshold still gets both reviewers (unchanged) — no gate weakens for real multi-task work");
});

// ── fast-path-token-gap item, lever 2: a sub-threshold diff's single reviewer also requests a
// cheaper reasoning-effort tier, not just fewer reviewers (see codex/agents.manifest.json's
// own DeepSWE-evidence rationale: "Sol/medium for routine implementation, and Sol/high for
// hard judgment" -- a single reviewer under the diff-size threshold is exactly the "routine,
// well-scoped" class medium effort is evidenced to suffice for). This changes ONLY how much
// reasoning budget the reviewer is asked to spend, never which checks it runs.

test("reviewerReasoningForCount: rejects anything other than 1 or 2", () => {
  assert.throws(() => reviewerReasoningForCount(0), /reviewerCount must be 1 or 2/i);
  assert.throws(() => reviewerReasoningForCount(3), /reviewerCount must be 1 or 2/i);
  assert.throws(() => reviewerReasoningForCount("1"), /reviewerCount must be 1 or 2/i);
});

test("reviewerReasoningForCount: 1 reviewer (sub-threshold diff) -> medium; 2 reviewers (unchanged) -> high", () => {
  assert.equal(reviewerReasoningForCount(1), "medium");
  assert.equal(reviewerReasoningForCount(2), "high");
  assert.deepEqual(REVIEWER_REASONING, { full: "high", fastPath: "medium" }, "sanity: known canonical reasoning tiers");
});

test("planGateCadence: reviewerReasoning is folded in alongside reviewerCount, omitted when changedLines is absent", () => {
  const withoutChangedLines = planGateCadence([["t1"]]);
  assert.equal("reviewerReasoning" in withoutChangedLines, false);

  const underThreshold = planGateCadence([["t1"]], { changedLines: 50 });
  assert.equal(underThreshold.reviewerCount, 1);
  assert.equal(underThreshold.reviewerReasoning, "medium");

  const atThreshold = planGateCadence([["t1"], ["t2"], ["t3"]], { changedLines: 500 });
  assert.equal(atThreshold.reviewerCount, 2);
  assert.equal(atThreshold.reviewerReasoning, "high", "at/over the threshold keeps the unchanged high-effort reviewer");
});
