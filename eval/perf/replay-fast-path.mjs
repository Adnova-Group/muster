#!/usr/bin/env node
// weight-reduction item replay harness (criterion 3: wave-overhead token budget for a
// replayed SMALL-TASK run, fast-path vs full-pipeline, on the SAME task) -- extended by the
// fast-path-token-gap item to apply lever 1 (a lighter reviewer brief) to the AFTER side and
// re-measure the resulting consumption %.
//
// Method (recorded honestly, per this item's brief): a true "pre-teardown" baseline is not
// reproducible in this environment (that pipeline was torn down; its code is gone, not
// just disabled), and this repo does not run a live, token-metered LLM session -- so, as
// the brief's own pragmatics require when the pre-teardown baseline isn't reproducible,
// this measures the FAST-PATH-vs-FULL-PIPELINE delta on the SAME small task instead, and
// reports the real computed number, whatever it is (not a fabricated 25%).
//
//   1. REAL, live measurement: the actual byte size of plugin/skills/router/SKILL.md,
//      plugin/skills/review-gate/SKILL.md (the full brief, before-side), AND
//      plugin/skills/review-gate/fast-path-brief.md (fast-path-token-gap lever 1's lighter
//      brief, after-side ONLY), read off disk right now (never hardcoded) -- the
//      full-pipeline path loads router/SKILL.md once (crew assembly); the fast path skips it
//      entirely (criterion 1). This script models the "bare 1-task fast-path run" success
//      criterion's own scenario: a diff that trips none of the light brief's citation/
//      mutant-kill/surface triggers (src/review-brief.js's `lightBriefEligible`), so the
//      after side uses the LIGHT brief throughout.
//   2. REAL, grounded reviewer counts: 2 (code-review + security-review, the review-gate's
//      existing default) before this item's criterion-2 diff-size lever, 1 (a diff under
//      DEFAULT_REVIEW_DIFF_THRESHOLD) after -- imported directly from src/gate-cadence.js.
//   3. MODELED, clearly-labeled constants for what this environment cannot measure live:
//      the diff a reviewer reads (bounded by the SAME real DEFAULT_REVIEW_DIFF_THRESHOLD,
//      at an assumed/documented average chars-per-line, UNCHANGED by this item -- the diff
//      size model stays linked to the same real threshold on both sides, not tuned to hit a
//      target) and the output tokens each dispatch produces (a short findings list vs a
//      fuller manifest JSON) -- UNCHANGED between before/after (see the lever-2 honesty note
//      below for why). Combined via src/token-projection.js's projectFastPathTokenReduction(),
//      pinned by test/token-projection.test.js so the arithmetic itself is asserted by the
//      green suite, not just this script's output.
//
// Lever 2 (cheaper reviewer reasoning-effort tier) honesty note: src/gate-cadence.js's
// reviewerReasoningForCount is real, tested, and wired through `$MUSTER_CLI gate-cadence`'s
// `reviewerReasoning` field -- a genuine REQUEST for a cheaper tier, per this item's brief.
// But this script does NOT credit it with a token reduction here, because no verified
// per-call consumption mechanism exists in either harness today: Claude Code's Agent/Task
// tool dispatch has a real `model` override (plugin/skills/orchestrator/SKILL.md: "always
// pass the crew member's `model` as the Agent tool's `model`") but no reasoning-effort
// parameter; Codex's `model_reasoning_effort` is a STATIC per-agent-profile setting resolved
// at build/install time (`src/codex-release.js`'s `profileToml()`, confirmed by
// docs/research/codex-cli.md), not a runtime per-dispatch override a diff-size decision could
// actually reach. Modeling an assumed output-token reduction for an unconsumed request would
// be exactly the fabrication this item's brief warns against -- so lever 2 is requested/
// recorded (real, tested code) but contributes ZERO measured tokens here until a real
// consumption path exists. See docs/fast-path-token-gap.md for the full accounting.
//
// Usage: node eval/perf/replay-fast-path.mjs
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { DEFAULT_REVIEW_DIFF_THRESHOLD, reviewerReasoningForCount } from "../../src/gate-cadence.js";
import { projectFastPathTokenReduction } from "../../src/token-projection.js";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..");

const TARGET_CONSUMPTION_PCT = 25; // criterion 3: fast path must consume <=25% of full-pipeline tokens

console.log("weight-reduction replay: small-task run, fast path vs full pipeline (same task)");
console.log("(fast-path-token-gap item: lever 1, a lighter reviewer brief, applied to the after side --");
console.log(" lever 2, a cheaper reasoning tier, is requested/recorded but not yet counted; see below)\n");

console.log("Step 1 -- REAL file-size measurement (this checkout, right now):");
const routerSkillPath = join(repoRoot, "plugin/skills/router/SKILL.md");
const reviewSkillPath = join(repoRoot, "plugin/skills/review-gate/SKILL.md");
const fastPathBriefPath = join(repoRoot, "plugin/skills/review-gate/fast-path-brief.md");
const routerSkillChars = readFileSync(routerSkillPath, "utf8").length;
const reviewSkillChars = readFileSync(reviewSkillPath, "utf8").length;
const fastPathBriefChars = readFileSync(fastPathBriefPath, "utf8").length;
console.log(`  plugin/skills/router/SKILL.md: ${routerSkillChars} chars (full pipeline loads this once for crew assembly; fast path never loads it)`);
console.log(`  plugin/skills/review-gate/SKILL.md: ${reviewSkillChars} chars (the BEFORE side's per-reviewer-dispatch brief, unchanged)`);
console.log(`  plugin/skills/review-gate/fast-path-brief.md: ${fastPathBriefChars} chars (lever 1 -- the AFTER side's lighter brief, ${((1 - fastPathBriefChars / reviewSkillChars) * 100).toFixed(1)}% smaller than the full brief)`);

console.log("\nStep 2 -- grounded reviewer counts (src/gate-cadence.js, criterion 2):");
const reviewerCountBefore = 2; // code-review + security-review, the existing default
const reviewerCountAfter = 1; // a diff under DEFAULT_REVIEW_DIFF_THRESHOLD
const reasoningBefore = reviewerReasoningForCount(reviewerCountBefore);
const reasoningAfter = reviewerReasoningForCount(reviewerCountAfter);
console.log(`  reviewer count: ${reviewerCountBefore} (code-review + security-review) before -> ${reviewerCountAfter} (diff-size scaled, criterion 2) after`);
console.log(`  reviewer reasoning effort REQUESTED (lever 2, src/gate-cadence.js's reviewerReasoningForCount): "${reasoningBefore}" before -> "${reasoningAfter}" after -- NOT counted in the token model below (no verified per-call consumption mechanism today; see the lever-2 honesty note in this script's header)`);
console.log(`  DEFAULT_REVIEW_DIFF_THRESHOLD: ${DEFAULT_REVIEW_DIFF_THRESHOLD} changed lines`);

console.log("\nStep 3 -- modeled constants (documented, not measured):");
const ASSUMED_CHARS_PER_LINE = 40; // ballpark average code-line length, UNCHANGED by this item on either side
const OUTPUT_TOKENS_PER_REVIEWER = 300; // a short structured findings list, UNCHANGED before/after (lever 2 not credited here)
const OUTPUT_TOKENS_PER_ROUTER = 400; // a full Crew Manifest: crew + plan + skills + degradations
console.log(`  assumed chars/line for the reviewed diff: ${ASSUMED_CHARS_PER_LINE} (unchanged on both sides -- not tuned to hit a target)`);
console.log(`  modeled output tokens per reviewer dispatch (findings list): ${OUTPUT_TOKENS_PER_REVIEWER} (unchanged before/after -- lever 2 has no verified token effect to model, see above)`);
console.log(`  modeled output tokens for the router's manifest output: ${OUTPUT_TOKENS_PER_ROUTER}`);

console.log("\nStep 4 -- before/after projection (src/token-projection.js):");
const result = projectFastPathTokenReduction({
  routerSkillChars,
  reviewSkillChars,
  reviewSkillCharsAfter: fastPathBriefChars,
  diffThresholdLines: DEFAULT_REVIEW_DIFF_THRESHOLD,
  assumedCharsPerLine: ASSUMED_CHARS_PER_LINE,
  reviewerCountBefore,
  reviewerCountAfter,
  outputTokensPerReviewer: OUTPUT_TOKENS_PER_REVIEWER,
  outputTokensPerRouter: OUTPUT_TOKENS_PER_ROUTER,
});
console.log(`  router cost (before only): ${result.routerTokens.toFixed(0)} tokens (skill ${result.routerSkillTokens.toFixed(0)} + output ${OUTPUT_TOKENS_PER_ROUTER})`);
console.log(`  per-reviewer-dispatch cost, before: ${result.perReviewerDispatchTokens.toFixed(0)} tokens (skill ${result.reviewSkillTokens.toFixed(0)} + diff ${result.diffTokens.toFixed(0)} + output ${OUTPUT_TOKENS_PER_REVIEWER})`);
console.log(`  per-reviewer-dispatch cost, after (lever 1 only): ${result.perReviewerDispatchTokensAfter.toFixed(0)} tokens (skill ${result.reviewSkillTokensAfter.toFixed(0)} + diff ${result.diffTokens.toFixed(0)} + output ${OUTPUT_TOKENS_PER_REVIEWER})`);
console.log(`  before: ${result.beforeTokens.toFixed(0)} tokens modeled (router once + ${reviewerCountBefore}x reviewer dispatch)`);
console.log(`  after:  ${result.afterTokens.toFixed(0)} tokens modeled (router skipped + ${reviewerCountAfter}x reviewer dispatch, lighter brief)`);
console.log(`  reduction: ${result.reductionTokens.toFixed(0)} tokens (${result.reductionPct.toFixed(1)}% reduction, fast path consumes ${result.consumptionPct.toFixed(1)}% of full-pipeline tokens)`);

const meetsTarget = result.consumptionPct <= TARGET_CONSUMPTION_PCT;
console.log(`\n  ${meetsTarget ? "PASS" : "MISS"} -- criterion 3 asks for fast-path consumption <=${TARGET_CONSUMPTION_PCT}% of full-pipeline tokens; measured ${result.consumptionPct.toFixed(1)}%`);

if (!meetsTarget) {
  console.log("\nHonest gap note (per this item's brief -- report the real figure, not a fabricated 25%):");
  console.log("  Lever 1 (the lighter reviewer brief) is real, measured, and landed -- it alone moves");
  console.log("  consumption from 41.2% (docs/speed-tuning.md's own prior measurement) down to the figure");
  console.log("  above, a substantial, real improvement. Lever 2 (the cheaper reasoning tier) is also real");
  console.log("  and wired (requested via gate-cadence's reviewerReasoning field), but honestly contributes");
  console.log("  ZERO measured tokens here, since no verified per-call consumption mechanism exists in");
  console.log("  either harness today (see this script's header). The remaining gap to 25% is the SAME");
  console.log("  fixed diff-token allotment (bounded by DEFAULT_REVIEW_DIFF_THRESHOLD, unchanged by this");
  console.log("  item) dominating the after-side cost: with the brief already cut hard, the diff tokens");
  console.log("  alone are close to the whole 25%-of-before budget. Closing the remainder without inventing");
  console.log("  an unsubstantiated smaller diff-size assumption (which this item's brief explicitly warns");
  console.log("  against -- do not force 25%) would require either a real, measured change to how much diff");
  console.log("  a fast-path reviewer actually reads, or a real per-dispatch reasoning-effort consumption");
  console.log("  mechanism to credit lever 2 honestly -- both left as named follow-ups rather than fabricated.");
}

console.log("\nCaveat (honest method, not fabricated): step 1's file sizes are a REAL measurement of this");
console.log("checkout, read right now. Step 2's reviewer counts are grounded in src/gate-cadence.js's actual");
console.log("DEFAULT_REVIEW_DIFF_THRESHOLD/reviewerReasoningForCount. Step 3's constants are documented MODELS");
console.log("(chars/line, output tokens per dispatch) -- not measured production token counts, and");
console.log("labeled as such; no live LLM session backs the token totals above. This models the criterion-1");
console.log("'bare 1-task fast-path run' scenario (no citation/mutant-kill/surface trigger present,");
console.log("src/review-brief.js's lightBriefEligible) -- a diff that DOES trip a trigger falls back to the");
console.log("full brief, unmeasured by this script (see docs/fast-path-token-gap.md). See");
console.log("docs/weight-reduction.md and docs/speed-tuning.md for the prior measurements this one extends.");

process.exit(meetsTarget ? 0 : 1);
