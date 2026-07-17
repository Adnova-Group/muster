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

export function planGateCadence(waves) {
  if (!Array.isArray(waves)) throw new Error("planGateCadence: waves must be an array of waves (each an array of task ids)");

  const taskCount = waves.reduce((n, w) => n + (Array.isArray(w) ? w.length : 0), 0);
  const waveCount = waves.length;
  const hasParallelWave = waves.some((w) => Array.isArray(w) && w.length > 1);

  if (taskCount === 0) {
    return { taskCount, waveCount, specGateRounds: 0, reviewGateBatches: 0, fastPath: false, reason: "empty plan: no tasks, no gates" };
  }

  // Existing rule (plugin/commands/go.md step 4): a single-task, no-parallel-wave plan
  // skips the spec gate entirely; there is nothing for it to catch that a single review
  // pass won't.
  if (taskCount === 1 && !hasParallelWave) {
    return {
      taskCount, waveCount, specGateRounds: 0, reviewGateBatches: 1, fastPath: true,
      reason: "single trivial task: spec gate skipped (existing rule), one review-gate pass",
    };
  }

  if (taskCount <= SMALL_TASK_THRESHOLD) {
    return {
      taskCount, waveCount, specGateRounds: 1, reviewGateBatches: 1, fastPath: true,
      reason: `small plan (<=${SMALL_TASK_THRESHOLD} tasks): one spec-gate round, one batched review-gate pass across all ${waveCount} wave(s)`,
    };
  }

  // Proportional depth beyond the fast-path threshold: the spec gate still covers the
  // whole plan in a single round (unchanged), but review-gate cadence stays per-wave so
  // a growing plan keeps an independent barrier + gate per wave instead of one pass
  // silently having to cover more and more accumulated diff.
  return {
    taskCount, waveCount, specGateRounds: 1, reviewGateBatches: waveCount, fastPath: false,
    reason: `plan above the fast-path threshold (${SMALL_TASK_THRESHOLD} tasks): depth scales with wave count (${waveCount})`,
  };
}
