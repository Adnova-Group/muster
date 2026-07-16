// Pure before/after wall-clock projection for one replayed run's orchestration overhead.
//
// This is intentionally arithmetic only, not a live measurement — it combines two kinds
// of grounded input a caller supplies:
//   - CLI cold-start cost (`coldStartMs` vs `warmMs`): real `time`-measured per-call
//     overhead of `npx -y @adnova-group/muster ...` vs a resolved local/vendored
//     invocation (src/cli-resolve.js). See eval/perf/replay-3task.mjs for the script that
//     produces these numbers, and docs/performance-pass.md for the recorded run output.
//   - Gate-round cost (`msPerGateRound`): a modeled wall-clock cost for one opus-tier
//     gate dispatch (spec gate or review gate) — dispatch + reasoning latency, not
//     included in the CLI-call cost above since a gate round is an LLM dispatch, not a
//     muster CLI invocation.
//
// Keeping the arithmetic here pure (no timers, no child processes) means the reduction
// claim is asserted by a deterministic, always-green unit test
// (test/perf-projection.test.js) rather than a timing-sensitive one — the wall-clock
// half of the evidence comes from actually running the eval script and pasting its real
// output, honestly labeled, per this item's criterion 4 pragmatics.
export function projectRunReduction({
  cliCallCount = 0,
  coldStartMs = 0,
  warmMs = 0,
  specGateRoundsBefore = 0,
  specGateRoundsAfter = 0,
  reviewGateRoundsBefore = 0,
  reviewGateRoundsAfter = 0,
  msPerGateRound = 0,
} = {}) {
  const beforeMs = cliCallCount * coldStartMs + (specGateRoundsBefore + reviewGateRoundsBefore) * msPerGateRound;
  const afterMs = cliCallCount * warmMs + (specGateRoundsAfter + reviewGateRoundsAfter) * msPerGateRound;
  const reductionMs = beforeMs - afterMs;
  const reductionPct = beforeMs === 0 ? 0 : (reductionMs / beforeMs) * 100;
  return { beforeMs, afterMs, reductionMs, reductionPct };
}
