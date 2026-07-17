import { test } from "node:test";
import assert from "node:assert/strict";
import { estimateTokens, projectFastPathTokenReduction, DEFAULT_CHARS_PER_TOKEN } from "../src/token-projection.js";

// weight-reduction item, criterion 3: wave-overhead token budget. Pure arithmetic only,
// same discipline as src/perf-projection.js -- the REAL, live-measured half (router/
// review-gate SKILL.md file sizes, read off disk right now) lives in
// eval/perf/replay-fast-path.mjs; this module is the deterministic combining function,
// pinned by a unit test so the reported percentage is asserted by the green suite, not
// just narrated in a doc. See docs/weight-reduction.md for the honest method writeup and
// the actually-measured result (which may not clear the 25%-of-full-pipeline target -- if
// it doesn't, that is reported as a real, non-fabricated number, per the item's brief).

test("estimateTokens: divides chars by charsPerToken, default 4", () => {
  assert.equal(estimateTokens(400), 100);
  assert.equal(estimateTokens(400, 8), 50);
});

test("estimateTokens: rejects a negative/non-finite charCount or a non-positive charsPerToken", () => {
  assert.throws(() => estimateTokens(-1), /charCount must be a non-negative finite number/i);
  assert.throws(() => estimateTokens(NaN), /charCount must be a non-negative finite number/i);
  assert.throws(() => estimateTokens(100, 0), /charsPerToken must be a positive finite number/i);
  assert.throws(() => estimateTokens(100, -4), /charsPerToken must be a positive finite number/i);
});

test("DEFAULT_CHARS_PER_TOKEN is the commonly-cited ~4 chars/token English-text approximation", () => {
  assert.equal(DEFAULT_CHARS_PER_TOKEN, 4);
});

test("projectFastPathTokenReduction: before includes the router-skip cost once plus N reviewer dispatches; after is router-free with M reviewer dispatches", () => {
  const r = projectFastPathTokenReduction({
    routerSkillChars: 4000,
    reviewSkillChars: 4000,
    diffThresholdLines: 200,
    assumedCharsPerLine: 40,
    reviewerCountBefore: 2,
    reviewerCountAfter: 1,
    outputTokensPerReviewer: 300,
    outputTokensPerRouter: 400,
  });
  // routerSkillTokens = 4000/4 = 1000; routerTokens = 1000 + 400 = 1400
  assert.equal(r.routerSkillTokens, 1000);
  assert.equal(r.routerTokens, 1400);
  // reviewSkillTokens = 1000; diffTokens = (200*40)/4 = 2000; perReviewerDispatchTokens = 1000+2000+300 = 3300
  assert.equal(r.reviewSkillTokens, 1000);
  assert.equal(r.diffTokens, 2000);
  assert.equal(r.perReviewerDispatchTokens, 3300);
  // beforeTokens = 1400 + 2*3300 = 8000; afterTokens = 1*3300 = 3300
  assert.equal(r.beforeTokens, 8000);
  assert.equal(r.afterTokens, 3300);
  assert.equal(r.reductionTokens, 4700);
  assert.ok(Math.abs(r.reductionPct - 58.75) < 0.001);
  assert.ok(Math.abs(r.consumptionPct - 41.25) < 0.001);
});

test("projectFastPathTokenReduction: identical reviewer counts before/after yield zero reduction (router-skip is the only lever left)", () => {
  const r = projectFastPathTokenReduction({
    routerSkillChars: 0,
    reviewSkillChars: 1000,
    diffThresholdLines: 100,
    assumedCharsPerLine: 10,
    reviewerCountBefore: 2,
    reviewerCountAfter: 2,
    outputTokensPerReviewer: 0,
    outputTokensPerRouter: 0,
  });
  assert.equal(r.routerTokens, 0, "zero router-skill chars and zero router output -> zero router cost either way");
  assert.equal(r.reductionTokens, 0);
  assert.equal(r.reductionPct, 0);
});

test("projectFastPathTokenReduction: reductionPct + consumptionPct sum to 100", () => {
  const r = projectFastPathTokenReduction({
    routerSkillChars: 7923,
    reviewSkillChars: 9261,
    diffThresholdLines: 200,
    assumedCharsPerLine: 40,
    reviewerCountBefore: 2,
    reviewerCountAfter: 1,
    outputTokensPerReviewer: 300,
    outputTokensPerRouter: 400,
  });
  assert.ok(Math.abs(r.reductionPct + r.consumptionPct - 100) < 1e-9);
});

test("projectFastPathTokenReduction: zero before-tokens is a defined no-op (no division by zero)", () => {
  const r = projectFastPathTokenReduction({
    routerSkillChars: 0, reviewSkillChars: 0, diffThresholdLines: 0, assumedCharsPerLine: 1,
    reviewerCountBefore: 0, reviewerCountAfter: 0, outputTokensPerReviewer: 0, outputTokensPerRouter: 0,
  });
  assert.equal(r.beforeTokens, 0);
  assert.equal(r.afterTokens, 0);
  assert.equal(r.reductionPct, 0);
  assert.equal(r.consumptionPct, 0);
});

// ── fast-path-token-gap item: lever 1 (lighter reviewer brief) + lever 2 (cheaper reasoning
// tier) each act ONLY on the "after" (fast-path, reviewerCount:1) side -- the "before" (full
// pipeline, reviewerCount:2) dispatch is unchanged, still the full review-gate/SKILL.md brief
// at the unchanged output-token constant. `reviewSkillCharsAfter`/`outputTokensPerReviewerAfter`
// are OPTIONAL and default to the base `reviewSkillChars`/`outputTokensPerReviewer` -- so every
// existing call site (and test above) that doesn't pass them behaves byte-identically to
// before this item, and only eval/perf/replay-fast-path.mjs's updated call opts into the
// asymmetric before/after modeling.

test("projectFastPathTokenReduction: reviewSkillCharsAfter/outputTokensPerReviewerAfter default to the base before-side values (backward compatible)", () => {
  const withDefaults = projectFastPathTokenReduction({
    routerSkillChars: 4000, reviewSkillChars: 4000, diffThresholdLines: 200, assumedCharsPerLine: 40,
    reviewerCountBefore: 2, reviewerCountAfter: 1, outputTokensPerReviewer: 300, outputTokensPerRouter: 400,
  });
  const withExplicitSameValues = projectFastPathTokenReduction({
    routerSkillChars: 4000, reviewSkillChars: 4000, diffThresholdLines: 200, assumedCharsPerLine: 40,
    reviewerCountBefore: 2, reviewerCountAfter: 1, outputTokensPerReviewer: 300, outputTokensPerRouter: 400,
    reviewSkillCharsAfter: 4000, outputTokensPerReviewerAfter: 300,
  });
  assert.deepEqual(withDefaults, withExplicitSameValues);
});

test("projectFastPathTokenReduction: a smaller reviewSkillCharsAfter (lighter brief) only shrinks the AFTER side, before is untouched", () => {
  const r = projectFastPathTokenReduction({
    routerSkillChars: 4000, reviewSkillChars: 4000, diffThresholdLines: 200, assumedCharsPerLine: 40,
    reviewerCountBefore: 2, reviewerCountAfter: 1, outputTokensPerReviewer: 300, outputTokensPerRouter: 400,
    reviewSkillCharsAfter: 2000, // half the full brief's size
  });
  // before side unaffected: reviewSkillTokens/perReviewerDispatchTokens/beforeTokens read the
  // BASE (full-brief) reviewSkillChars, exactly as the no-lever test above.
  assert.equal(r.reviewSkillTokens, 1000);
  assert.equal(r.perReviewerDispatchTokens, 3300);
  assert.equal(r.beforeTokens, 8000);
  // after side uses the lighter brief: reviewSkillTokensAfter = 2000/4 = 500;
  // perReviewerDispatchTokensAfter = 500 + 2000(diff) + 300(output) = 2800; afterTokens = 1*2800.
  assert.equal(r.reviewSkillTokensAfter, 500);
  assert.equal(r.perReviewerDispatchTokensAfter, 2800);
  assert.equal(r.afterTokens, 2800);
  assert.ok(r.consumptionPct < 41.25, "a lighter after-side brief must lower consumptionPct vs the no-lever baseline");
});

test("projectFastPathTokenReduction: a smaller outputTokensPerReviewerAfter (cheaper reasoning tier) further shrinks ONLY the after side", () => {
  const r = projectFastPathTokenReduction({
    routerSkillChars: 4000, reviewSkillChars: 4000, diffThresholdLines: 200, assumedCharsPerLine: 40,
    reviewerCountBefore: 2, reviewerCountAfter: 1, outputTokensPerReviewer: 300, outputTokensPerRouter: 400,
    reviewSkillCharsAfter: 2000, outputTokensPerReviewerAfter: 180, // both levers combined
  });
  assert.equal(r.beforeTokens, 8000, "before side (full pipeline, unchanged) is untouched by either lever");
  // perReviewerDispatchTokensAfter = 500(skill) + 2000(diff) + 180(output) = 2680
  assert.equal(r.perReviewerDispatchTokensAfter, 2680);
  assert.equal(r.afterTokens, 2680);
});
