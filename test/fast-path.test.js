import { test } from "node:test";
import assert from "node:assert/strict";
import { scoreOutcomeForFastPath, buildFastPathManifest, FAST_PATH_MAX_WORDS } from "../src/fast-path.js";
import { validateManifest } from "../src/manifest.js";
import { computeWaves } from "../src/wave.js";
import { planGateCadence } from "../src/gate-cadence.js";

// ── weight-reduction item, criterion 1 (flagship): single-agent fast path ──────────────
// scoreOutcomeForFastPath is a deterministic, pre-router heuristic over the RAW outcome
// text (not a decomposed plan -- the router hasn't run yet at this point) that decides
// whether an outcome is small/single-task enough to skip crew assembly (the router
// SKILL.md's LLM dispatch) and the spec gate entirely. buildFastPathManifest then emits
// the minimal manifest directly from already-resolved capabilities: builder + one
// reviewer, one task -- no router dispatch needed.

const FAKE_CAPABILITIES = {
  roles: {
    implement: {
      chosen: { id: "muster-builder", source: "builtin", kind: "agent" },
      chain: [{ id: "muster-builder", source: "builtin", kind: "agent" }, { id: "inline", source: "inline", kind: "inline" }],
      recommendations: [],
      model: "sonnet",
    },
    "code-review": {
      chosen: { id: "muster-reviewer", source: "builtin", kind: "agent" },
      chain: [{ id: "muster-reviewer", source: "builtin", kind: "agent" }, { id: "inline", source: "inline", kind: "inline" }],
      recommendations: [],
      model: "sonnet",
    },
  },
};

// --- scoreOutcomeForFastPath ------------------------------------------------------------

test("scoreOutcomeForFastPath: empty/whitespace outcome is not eligible", () => {
  assert.equal(scoreOutcomeForFastPath("").eligible, false);
  assert.equal(scoreOutcomeForFastPath("   ").eligible, false);
  assert.equal(scoreOutcomeForFastPath(undefined).eligible, false);
  assert.equal(scoreOutcomeForFastPath(null).eligible, false);
});

test("scoreOutcomeForFastPath: a trivial single-deliverable outcome is eligible", () => {
  const r = scoreOutcomeForFastPath("Fix the flaky login test");
  assert.equal(r.eligible, true);
  assert.equal(typeof r.reason, "string");
  assert.ok(r.reason.length > 0);
  assert.equal(typeof r.wordCount, "number");
});

test("scoreOutcomeForFastPath: a short, concrete one-line outcome is eligible", () => {
  const r = scoreOutcomeForFastPath("Add retry to the fetch helper with tests");
  assert.equal(r.eligible, true);
});

test("scoreOutcomeForFastPath: a cross-cutting-scope outcome is NOT eligible", () => {
  for (const text of [
    "Migrate every service across the monorepo to the new logger",
    "Overhaul the entire authentication system end-to-end",
    "Refactor the whole billing module throughout the codebase",
  ]) {
    const r = scoreOutcomeForFastPath(text);
    assert.equal(r.eligible, false, `"${text}" should not be fast-path eligible`);
    assert.match(r.reason, /cross-cutting/i);
  }
});

test("scoreOutcomeForFastPath: a multi-deliverable outcome (list markers, also/and then/as well as) is NOT eligible", () => {
  for (const text of [
    "Add rate limiting and then update the README as well as the changelog",
    "1. Add retry\n2. Add logging\n3. Add tests",
    "Fix the login bug; also update the docs",
  ]) {
    const r = scoreOutcomeForFastPath(text);
    assert.equal(r.eligible, false, `"${text}" should not be fast-path eligible`);
  }
});

test("scoreOutcomeForFastPath: two independent imperative verbs joined by \"and\" is NOT eligible", () => {
  const r = scoreOutcomeForFastPath("Add rate limiting and fix the flaky login test and update the README");
  assert.equal(r.eligible, false);
});

test("scoreOutcomeForFastPath: compact multi-deliverable forms (separator + imperative clause) are NOT eligible", () => {
  for (const text of [
    "Add retry support, update the README",
    "Add retry support, then update the README",
    "Add retry support\nUpdate the README",
    "Add retry support + update the README",
    "Add retry support\n- update the README",
  ]) {
    const r = scoreOutcomeForFastPath(text);
    assert.equal(r.eligible, false, `${JSON.stringify(text)} should not be fast-path eligible`);
    assert.match(r.reason, /deliverable|task/i);
  }
});

test("scoreOutcomeForFastPath: atomic outcomes with punctuation-joined compound OBJECTS stay eligible", () => {
  // The separator gate requires an imperative CLAUSE after the comma/plus/newline --
  // a comma followed by a noun is one task with a compound object, and routing it
  // onto the heavy path is pure weight inflation (see MULTI_DELIVERABLE_RE's comment).
  for (const text of [
    "Fix the flaky, slow login test",
    "Add retry, backoff, and jitter to fetch",
    "Add retry support, tests, and documentation",
  ]) {
    const r = scoreOutcomeForFastPath(text);
    assert.equal(r.eligible, true, `${JSON.stringify(text)} is one task and must stay fast-path eligible`);
  }
});

test(`scoreOutcomeForFastPath: an outcome over ${FAST_PATH_MAX_WORDS} meaningful words is NOT eligible`, () => {
  const longOutcome = Array.from({ length: FAST_PATH_MAX_WORDS + 5 }, (_, i) => `word${i}`).join(" ");
  const r = scoreOutcomeForFastPath(longOutcome);
  assert.equal(r.eligible, false);
  assert.match(r.reason, /word/i);
});

test("scoreOutcomeForFastPath: an outcome at the word-count boundary is still eligible", () => {
  const boundaryOutcome = Array.from({ length: FAST_PATH_MAX_WORDS }, (_, i) => `distinctword${i}`).join(" ");
  const r = scoreOutcomeForFastPath(boundaryOutcome);
  assert.equal(r.eligible, true);
});

// --- audit/review-scope + multi-file disqualifiers (run-5 dogfood misfire) --------------
// A terse whole-codebase/multi-file AUDIT outcome slipped through as fast-path ELIGIBLE:
// none of the cross-cutting/multi-deliverable/chained-verb/word-count signals catch a short
// "audit src/a.js src/b.js src/c.js ..." (its verb is not in the imperative lexicon and its
// scope words are not the cross-cutting vocabulary). But an audit/review/sweep is a
// read-and-assess task ACROSS a scope -- never the single build/fix slice the fast path is
// for (builder + ONE reviewer, one task). Two independent signals now disqualify it: a
// review-scope action verb, and 2+ enumerated file paths.

test("scoreOutcomeForFastPath: the run-5 multi-file AUDIT outcome is NOT eligible", () => {
  const r = scoreOutcomeForFastPath("audit src/a.js src/b.js src/c.js for security and coverage");
  assert.equal(r.eligible, false, "a multi-file audit outcome must never take the builder-only fast path");
  assert.match(r.reason, /audit|review|scope|file/i);
});

test("scoreOutcomeForFastPath: leading audit/review/sweep-scope outcomes are NOT eligible", () => {
  for (const text of [
    "audit src/a.js src/b.js src/c.js for security and coverage",
    "review src/auth.js src/db.js src/api.js for error handling",
    "sweep the repo for unused exports",
    "audit the payments module for security and tech-debt issues",
    "re-audit the auth module after the last remediation",
  ]) {
    const r = scoreOutcomeForFastPath(text);
    assert.equal(r.eligible, false, `${JSON.stringify(text)} is a review-scope task, never a single fast-path slice`);
    assert.match(r.reason, /audit|review|sweep|file/i);
  }
});

test("scoreOutcomeForFastPath: an outcome enumerating 2+ distinct file paths is NOT eligible", () => {
  // Even without a review verb, naming multiple concrete source files is a multi-file
  // shape, not one small slice.
  const r = scoreOutcomeForFastPath("tidy up imports in src/a.js and src/b.js");
  assert.equal(r.eligible, false);
  assert.match(r.reason, /file/i);
});

test("scoreOutcomeForFastPath: a single-file build/fix task stays eligible (one path is not multi-file)", () => {
  // The multi-file signal must require 2+ paths -- a genuine single-slice task that names
  // exactly one file, and uses no review-scope verb, must remain on the fast path.
  for (const text of [
    "add a retry helper to src/fetch.js",
    "refactor the getUser function in src/auth.js",
    "fix the null check in src/db.js",
  ]) {
    const r = scoreOutcomeForFastPath(text);
    assert.equal(r.eligible, true, `${JSON.stringify(text)} is a single-file slice and must stay fast-path eligible`);
  }
});

// --- false-positive guards: the disqualifiers must NOT fire on ordinary build tasks -------
// Regression pins for the shapes an earlier draft over-matched (adversarial review round 1):
// the review-scope signal is anchored to the LEADING verb, and the file-path signal requires
// an alphabetic extension and dedupes -- so review-NOUN proper nouns, a file named twice, and
// numeric fractions never disqualify a genuine single build slice.

test("scoreOutcomeForFastPath: review-noun proper nouns (code review bot, dependency review action) stay eligible", () => {
  // "code review"/"dependency review" are common CI/tooling nouns (GitHub's own
  // dependency-review-action); the governing verb here is add/wire, not a review-scope verb,
  // so these single build tasks must stay on the fast path.
  for (const text of [
    "add a code review bot config to .github/config.yml",
    "wire up the dependency review action in the CI workflow",
    "add a review step to the checkout flow",
  ]) {
    const r = scoreOutcomeForFastPath(text);
    assert.equal(r.eligible, true, `${JSON.stringify(text)} is a single build task naming a review noun, not a review action`);
  }
});

test("scoreOutcomeForFastPath: 'audit' as a feature noun (audit log) does not disqualify a build task", () => {
  // The review-scope signal is anchored to the LEADING imperative, so "add an audit log" (a
  // build task whose object happens to be an audit log) stays eligible -- the verb is "add".
  const r = scoreOutcomeForFastPath("add an audit log to the payments service");
  assert.equal(r.eligible, true);
});

test("scoreOutcomeForFastPath: the same file named twice is one distinct path, still eligible", () => {
  const r = scoreOutcomeForFastPath("add a retry helper to src/fetch.js as described in the src/fetch.js TODO");
  assert.equal(r.eligible, true, "a duplicate mention of one file is still a single-file slice");
});

test("scoreOutcomeForFastPath: numeric fractions/versions are not counted as file paths", () => {
  // "3/4.5", "7/8.2" are ratios, not paths -- the file-path signal requires an ALPHABETIC
  // extension, so this single build task stays eligible.
  const r = scoreOutcomeForFastPath("update the ratio from 3/4.5 to 7/8.2 in the pricing calc");
  assert.equal(r.eligible, true);
});

// --- buildFastPathManifest ---------------------------------------------------------------

test("buildFastPathManifest: throws without a non-empty outcome", () => {
  assert.throws(() => buildFastPathManifest({ outcome: "", capabilities: FAKE_CAPABILITIES }), /outcome/i);
  assert.throws(() => buildFastPathManifest({ capabilities: FAKE_CAPABILITIES }), /outcome/i);
});

test("buildFastPathManifest: throws without capabilities.roles.implement/code-review", () => {
  assert.throws(() => buildFastPathManifest({ outcome: "Fix the bug" }), /capabilities/i);
  assert.throws(() => buildFastPathManifest({ outcome: "Fix the bug", capabilities: { roles: {} } }), /implement.*code-review|code-review.*implement/i);
});

test("buildFastPathManifest: rejects an outcome that is not fast-path eligible", () => {
  assert.throws(
    () => buildFastPathManifest({ outcome: "Add retry support, update the README", capabilities: FAKE_CAPABILITIES }),
    /not eligible|fast.path/i
  );
});

test("buildFastPathManifest: emits a minimal builder + one-reviewer, one-task manifest that validates", () => {
  const m = buildFastPathManifest({ outcome: "Fix the flaky login test", capabilities: FAKE_CAPABILITIES });
  assert.deepEqual(validateManifest(m), { ok: true, errors: [] });
  assert.equal(m.crew.length, 2, "builder + ONE reviewer only");
  assert.equal(m.plan.length, 1, "single task");
  assert.equal(m.plan[0].mode, "single");
  assert.deepEqual(m.plan[0].deps, []);
  assert.equal(m.crew.some((c) => c.provider === "muster-builder"), true);
  assert.equal(m.crew.some((c) => c.provider === "muster-reviewer"), true);
});

test("buildFastPathManifest: successCriteria defaults to [outcome] when not supplied", () => {
  const m = buildFastPathManifest({ outcome: "Fix the flaky login test", capabilities: FAKE_CAPABILITIES });
  assert.deepEqual(m.successCriteria, ["Fix the flaky login test"]);
});

test("buildFastPathManifest: successCriteria is honored when supplied", () => {
  const m = buildFastPathManifest({
    outcome: "Fix the flaky login test",
    successCriteria: ["test passes 20/20 runs"],
    capabilities: FAKE_CAPABILITIES,
  });
  assert.deepEqual(m.successCriteria, ["test passes 20/20 runs"]);
});

test("buildFastPathManifest: mergeDisposition defaults to 'ask' and is overridable", () => {
  const m1 = buildFastPathManifest({ outcome: "Fix the flaky login test", capabilities: FAKE_CAPABILITIES });
  assert.equal(m1.mergeDisposition, "ask");
  const m2 = buildFastPathManifest({ outcome: "Fix the flaky login test", capabilities: FAKE_CAPABILITIES, mergeDisposition: "pr" });
  assert.equal(m2.mergeDisposition, "pr");
});

// --- routed example (criterion 1's own verification bar) --------------------------------

test("routed example: a trivial outcome scores eligible, its fast-path manifest validates, and gate-cadence still skips the spec gate (existing rule composes cleanly)", () => {
  const outcome = "Fix the flaky login test";
  const score = scoreOutcomeForFastPath(outcome);
  assert.equal(score.eligible, true);

  const manifest = buildFastPathManifest({ outcome, capabilities: FAKE_CAPABILITIES });
  assert.deepEqual(validateManifest(manifest), { ok: true, errors: [] });

  const waves = computeWaves(manifest.plan.map((p, i) => ({ ...p, id: p.id || `t${i + 1}` }))).map((w) => w.map((t) => t.id));
  const cadence = planGateCadence(waves);
  assert.equal(cadence.specGateRounds, 0, "the existing single-trivial-task rule still applies -- no new spec-gate lever needed");
  assert.equal(cadence.reviewGateBatches, 1);
});

test("routed example: a complex/multi-task outcome scores NOT eligible -- the full crew (router dispatch) is required", () => {
  const outcome = "Add rate limiting, migrate the auth module to the new session store, and update every affected test suite across the repo";
  const score = scoreOutcomeForFastPath(outcome);
  assert.equal(score.eligible, false, "a genuinely multi-task/cross-cutting outcome must never take the fast path (criterion 5)");
});
