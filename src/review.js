// Adversarial gate: ANY blocker (from any reviewer) blocks. Not majority.
//
// A reviewer entry normally carries `findings: [{severity, note}, ...]`, tallied into
// `counts`/`blockers` exactly as before — entries without `status` (below) are fully
// backward compatible with the pre-exhaustion contract.
//
// A reviewer entry may additionally (or instead) carry a top-level `status` naming the
// WORKER's own failure to ever deliver a verdict — "exhausted" (killed/ran out of budget
// mid-review) or "absent" (never dispatched or never responded). This is orthogonal to
// the finding-severity vocabulary below: a killed reviewer produced no real verdict, so
// its `findings` — even if a caller stuffed synthetic FAIL/blocker-shaped noise into them
// (the exact live-incident shape this closes: 2026-07-19 Codex dogfood, a budget-killed
// reviewer's synthetic strings were silently skipped by the severity parser below and the
// gate wrongly answered blocked:false) — are never parsed into counts/blockers. Instead
// the tally is forced blocked with a NAMED reason in `blockedReasons`, kept distinct from
// `blockers` (reserved for real severity:"blocker" findings from a reviewer who actually
// verdicted). A missing/killed required reviewer is therefore never a silent skip, and
// never counted as if it cast a real PASS or FAIL vote — exhaustion always overrides
// silence. An unrecognized `status` value is not gate vocabulary: it is ignored, exactly
// like an unrecognized `severity` below, and the entry's `findings` (if any) are parsed
// normally — forward-compatible with a future status this gate doesn't know yet.
//
// Quorum: this gate has no majority/quorum computation to begin with (see "Not majority"
// above) — there is no N-of-M passing threshold an exhausted/absent entry could be
// miscounted toward. It contributes zero findings to `counts` and is excluded from
// `blockers`; the only way it can be observed is via `blockedReasons`/`exhausted`, which
// forces `blocked: true` rather than the gate quietly declaring quorum with one fewer
// voter. If a quorum threshold is ever added to this gate, an exhausted/absent entry MUST
// keep being excluded from both the numerator (it cast no vote) and the denominator (it
// is not an eligible voter) — never counted as present.
const WORKER_ABSENCE_STATUSES = new Set(["exhausted", "absent"]);

export function tallyReview(verdicts) {
  const counts = { blocker: 0, risk: 0, nit: 0 };
  const blockers = [];
  const blockedReasons = [];
  const exhausted = [];
  for (const v of verdicts) {
    if (WORKER_ABSENCE_STATUSES.has(v.status)) {
      exhausted.push({ reviewer: v.reviewer, status: v.status });
      blockedReasons.push(`reviewer ${v.reviewer} ${v.status} before verdict`);
      continue; // no verdict was ever produced -- findings (if any) are not real signal
    }
    for (const f of (v.findings || [])) {
      // Only the known severities (blocker/risk/nit) are counted. Any other
      // severity (e.g. "critical") is intentionally skipped — unknown values
      // are not part of the gate's vocabulary and must not affect counts or
      // the pass/block verdict.
      if (counts[f.severity] !== undefined) counts[f.severity] += 1;
      if (f.severity === "blocker") blockers.push({ reviewer: v.reviewer, note: f.note });
    }
  }
  return {
    blocked: blockers.length > 0 || blockedReasons.length > 0,
    blockers,
    counts,
    blockedReasons,
    exhausted
  };
}
