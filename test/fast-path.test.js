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

// --- buildFastPathManifest ---------------------------------------------------------------

test("buildFastPathManifest: throws without a non-empty outcome", () => {
  assert.throws(() => buildFastPathManifest({ outcome: "", capabilities: FAKE_CAPABILITIES }), /outcome/i);
  assert.throws(() => buildFastPathManifest({ capabilities: FAKE_CAPABILITIES }), /outcome/i);
});

test("buildFastPathManifest: throws without capabilities.roles.implement/code-review", () => {
  assert.throws(() => buildFastPathManifest({ outcome: "Fix the bug" }), /capabilities/i);
  assert.throws(() => buildFastPathManifest({ outcome: "Fix the bug", capabilities: { roles: {} } }), /implement.*code-review|code-review.*implement/i);
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
