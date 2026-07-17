// Small-task fast path: cuts orchestration overhead for small plans by BATCHING the
// per-wave review gate into fewer passes, never by weakening any gate's own pass bar.
//
// Seed evidence (codex-teardown run): a 3-task plan that split into 3 sequential waves
// paid 3 separate opus-tier gate dispatches — one per wave — even though the whole plan
// was small enough to review as a single cumulative diff. `go.md`'s pre-execution spec
// gate was already a single, whole-plan dispatch (skippable for a single trivial task),
// so the real fixed-depth cost was the PER-WAVE review gate (`review-gate/SKILL.md` step
// 3c, invoked once per wave regardless of how small the whole plan is).
//
// This module is the deterministic, pure decision behind that fast path: given the
// dependency-ordered waves a plan compiles to (the same `waves` shape `computeWaves`
// returns — an array of arrays of task ids), decide how many spec-gate rounds and
// review-gate batches the run defaults to.
//
// Levers only — batching (fewer review-gate dispatches) and the existing dedup (spec
// gate is one whole-plan dispatch, not one per task). The reviewer tier, the pass bar,
// and the fix-loop cap (3, `REVIEW_GATE_MAX_ITERATIONS` in src/loop.js) are untouched:
// a batched pass reviews the FULL cumulative diff across every batched wave, at the same
// rigor as any single-wave pass — see docs/performance-pass.md.
export const SMALL_TASK_THRESHOLD = 3;

// weight-reduction item, criterion 2: review gates also scale with DIFF SIZE, an axis
// independent of taskCount/waveCount above. A wave (or, under fastPath, the cumulative
// batched diff) under this many changed lines gets ONE reviewer dispatched instead of the
// review-gate's default two (`code-review` + `security-review`, review-gate/SKILL.md step
// 1) — the diff is simply too small for a second adversarial pass to plausibly catch
// something the first missed. Configurable via the `MUSTER_REVIEW_DIFF_THRESHOLD` env var
// (wired in src/cli.js's `gate-cadence` command), default below.
//
// Rationale for 200: small enough that a single reviewer can hold the whole diff in
// working memory and give it genuine adversarial attention (not skim it), large enough
// that a real multi-file feature slice — not just a one-line fix — still clears it and
// gets the default two-reviewer treatment. This is diff-SIZE scoped, not task-count
// scoped: a multi-task plan whose cumulative diff happens to land under the threshold
// still only needs one reviewer for THAT diff (criterion 5 is preserved by construction —
// task count and diff size are independent axes; a genuinely large multi-task diff always
// lands at or above the threshold and keeps both reviewers, unchanged).
//
// Diff size, unlike taskCount, is not knowable at plan time (before a wave's changes
// exist) — this is necessarily a fresh per-wave/per-batch computation, never captured
// once and reused the way capabilities/gate-cadence's own taskCount fields are.
export const DEFAULT_REVIEW_DIFF_THRESHOLD = 200;

function assertNonNegativeFinite(value, label, fnName) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error(`${fnName}: ${label} must be a non-negative finite number, got ${value}`);
  }
}

// Pure diff-size -> reviewer-count decision. `threshold` defaults to
// DEFAULT_REVIEW_DIFF_THRESHOLD but is always caller-overridable (src/cli.js reads
// MUSTER_REVIEW_DIFF_THRESHOLD and passes it through) so a repo/run can tune it without a
// code change.
export function reviewerCountForDiff(changedLines, { threshold = DEFAULT_REVIEW_DIFF_THRESHOLD } = {}) {
  assertNonNegativeFinite(changedLines, "changedLines", "reviewerCountForDiff");
  assertNonNegativeFinite(threshold, "threshold", "reviewerCountForDiff");
  return changedLines < threshold ? 1 : 2;
}

// `changedLines` (and its paired `reviewDiffThreshold` override) is OPTIONAL: a caller
// planning ahead of any wave running (e.g. go.md step 4's one-shot capture, before a
// single line of diff exists) gets the existing taskCount-only decision, unchanged and
// with no `reviewerCount` key at all — never a fabricated guess at a diff size nobody has
// yet. A caller that already knows the diff (review-gate/SKILL.md step 1, dispatched
// after a wave's changes exist) passes `changedLines` and gets `reviewerCount` folded into
// the SAME result object, so one call answers both cadence questions together.
export function planGateCadence(waves, { changedLines, reviewDiffThreshold } = {}) {
  if (!Array.isArray(waves)) throw new Error("planGateCadence: waves must be an array of waves (each an array of task ids)");

  const taskCount = waves.reduce((n, w) => n + (Array.isArray(w) ? w.length : 0), 0);
  const waveCount = waves.length;
  const hasParallelWave = waves.some((w) => Array.isArray(w) && w.length > 1);

  const reviewerCountFields =
    changedLines === undefined
      ? {}
      : { reviewerCount: reviewerCountForDiff(changedLines, { threshold: reviewDiffThreshold }) };

  if (taskCount === 0) {
    return {
      taskCount, waveCount, specGateRounds: 0, reviewGateBatches: 0, fastPath: false,
      reason: "empty plan: no tasks, no gates", ...reviewerCountFields,
    };
  }

  // Existing rule (plugin/commands/go.md step 4): a single-task, no-parallel-wave plan
  // skips the spec gate entirely; there is nothing for it to catch that a single review
  // pass won't.
  if (taskCount === 1 && !hasParallelWave) {
    return {
      taskCount, waveCount, specGateRounds: 0, reviewGateBatches: 1, fastPath: true,
      reason: "single trivial task: spec gate skipped (existing rule), one review-gate pass",
      ...reviewerCountFields,
    };
  }

  if (taskCount <= SMALL_TASK_THRESHOLD) {
    return {
      taskCount, waveCount, specGateRounds: 1, reviewGateBatches: 1, fastPath: true,
      reason: `small plan (<=${SMALL_TASK_THRESHOLD} tasks): one spec-gate round, one batched review-gate pass across all ${waveCount} wave(s)`,
      ...reviewerCountFields,
    };
  }

  // Proportional depth beyond the fast-path threshold: the spec gate still covers the
  // whole plan in a single round (unchanged), but review-gate cadence stays per-wave so
  // a growing plan keeps an independent barrier + gate per wave instead of one pass
  // silently having to cover more and more accumulated diff.
  return {
    taskCount, waveCount, specGateRounds: 1, reviewGateBatches: waveCount, fastPath: false,
    reason: `plan above the fast-path threshold (${SMALL_TASK_THRESHOLD} tasks): depth scales with wave count (${waveCount})`,
    ...reviewerCountFields,
  };
}
