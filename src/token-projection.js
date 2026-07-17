// weight-reduction item, criterion 3: wave-overhead token budget.
//
// Pure before/after TOKEN projection for the fast path (criterion 1) + diff-scaled
// reviewer count (criterion 2) on the SAME small task, combined. This mirrors
// src/perf-projection.js's discipline exactly: the arithmetic here is pure (no live model
// calls, no timers), asserted by a deterministic unit test (test/token-projection.test.js)
// so the reported percentage is pinned by the green suite, not just narrated in a doc. The
// REAL, live-measured half — the actual byte size of router/SKILL.md and
// review-gate/SKILL.md, read off disk right now — lives in
// eval/perf/replay-fast-path.mjs, which calls this module with those real numbers.
//
// What this models, and why each constant is what it is:
//
//   - `routerSkillChars`/`reviewSkillChars` — REAL, measured (fs.readFileSync(...).length
//     in the eval script, never hardcoded): the router SKILL.md / review-gate SKILL.md
//     file sizes. A fast-path run never loads router/SKILL.md at all (crew assembly is
//     skipped entirely); a full-pipeline run's router dispatch loads it once, and EACH
//     reviewer dispatch (review-gate/SKILL.md's step 2, one Agent-tool dispatch per
//     reviewer) independently loads review-gate/SKILL.md into its own fresh context.
//   - `diffThresholdLines`/`assumedCharsPerLine` — the diff a reviewer reads. Pinned to
//     `DEFAULT_REVIEW_DIFF_THRESHOLD` (criterion 2) so the model stays linked to the same
//     real threshold, not an unrelated made-up diff size; `assumedCharsPerLine` (default
//     40 in the eval script) is a documented, ballpark average code-line length, not a
//     measurement.
//   - `outputTokensPerReviewer`/`outputTokensPerRouter` — MODELED constants (documented,
//     not measured) for the findings list / manifest JSON each dispatch produces — the
//     same "named projection, not dressed up as a measurement" stance
//     docs/performance-pass.md already took for its own model-call reduction estimate.
//   - `reviewerCountBefore`/`reviewerCountAfter` — REAL, grounded counts: 2 (the
//     review-gate's existing default, `code-review` + `security-review`) before this
//     item's criterion-2 lever, 1 (below the diff-size threshold) after.
//
// The router is fully skipped in the "after" case by construction (criterion 1's whole
// point) — this module does not take a reviewerCount-style toggle for the router, since
// the fast path is binary: crew assembly either runs once (before) or not at all (after).
//
// fast-path-token-gap item (closing criterion 3's own named gap): `reviewSkillCharsAfter`/
// `outputTokensPerReviewerAfter` let the AFTER side model a DIFFERENT brief size / output-
// token cost than the before side, for the two levers that item adds -- a lighter reviewer
// brief (`plugin/skills/review-gate/fast-path-brief.md`, real/measured) and a cheaper
// reasoning-effort tier (`src/gate-cadence.js`'s `reviewerReasoningForCount`, MODELED to
// produce a shorter output here — documented, not measured, same posture as
// `outputTokensPerReviewer` itself). Both default to the base before-side values, so every
// pre-fast-path-token-gap call site is untouched.
export const DEFAULT_CHARS_PER_TOKEN = 4; // commonly-cited rough English-text approximation

export function estimateTokens(charCount, charsPerToken = DEFAULT_CHARS_PER_TOKEN) {
  if (typeof charCount !== "number" || !Number.isFinite(charCount) || charCount < 0) {
    throw new Error(`estimateTokens: charCount must be a non-negative finite number, got ${charCount}`);
  }
  if (typeof charsPerToken !== "number" || !Number.isFinite(charsPerToken) || charsPerToken <= 0) {
    throw new Error(`estimateTokens: charsPerToken must be a positive finite number, got ${charsPerToken}`);
  }
  return charCount / charsPerToken;
}

export function projectFastPathTokenReduction({
  routerSkillChars = 0,
  reviewSkillChars = 0,
  diffThresholdLines = 0,
  assumedCharsPerLine = 0,
  reviewerCountBefore = 0,
  reviewerCountAfter = 0,
  outputTokensPerReviewer = 0,
  outputTokensPerRouter = 0,
  charsPerToken = DEFAULT_CHARS_PER_TOKEN,
  // fast-path-token-gap item: the two levers (a lighter reviewer brief, a cheaper reasoning
  // tier) act ONLY on the "after" (fast-path, reviewerCount:1) dispatch -- the "before" (full
  // pipeline, reviewerCount:2) dispatch is unchanged, still the full brief at the unchanged
  // output-token constant. Both default to the base `reviewSkillChars`/`outputTokensPerReviewer`
  // so every pre-existing call site (a caller that models a single, shared brief/output cost
  // for both sides, same as before this item) is untouched.
  reviewSkillCharsAfter = reviewSkillChars,
  outputTokensPerReviewerAfter = outputTokensPerReviewer,
} = {}) {
  const routerSkillTokens = estimateTokens(routerSkillChars, charsPerToken);
  const reviewSkillTokens = estimateTokens(reviewSkillChars, charsPerToken);
  const reviewSkillTokensAfter = estimateTokens(reviewSkillCharsAfter, charsPerToken);
  const diffTokens = diffThresholdLines === 0 ? 0 : estimateTokens(diffThresholdLines * assumedCharsPerLine, charsPerToken);
  const perReviewerDispatchTokens = reviewSkillTokens + diffTokens + outputTokensPerReviewer;
  const perReviewerDispatchTokensAfter = reviewSkillTokensAfter + diffTokens + outputTokensPerReviewerAfter;
  const routerTokens = routerSkillTokens + outputTokensPerRouter;

  const beforeTokens = routerTokens + reviewerCountBefore * perReviewerDispatchTokens;
  const afterTokens = reviewerCountAfter * perReviewerDispatchTokensAfter; // router fully skipped
  const reductionTokens = beforeTokens - afterTokens;
  const reductionPct = beforeTokens === 0 ? 0 : (reductionTokens / beforeTokens) * 100;
  const consumptionPct = beforeTokens === 0 ? 0 : (afterTokens / beforeTokens) * 100;

  return {
    routerSkillTokens, reviewSkillTokens, reviewSkillTokensAfter, diffTokens,
    perReviewerDispatchTokens, perReviewerDispatchTokensAfter, routerTokens,
    beforeTokens, afterTokens, reductionTokens, reductionPct, consumptionPct,
  };
}
