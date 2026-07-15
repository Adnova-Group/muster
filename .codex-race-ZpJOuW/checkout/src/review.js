// Adversarial gate: ANY blocker (from any reviewer) blocks. Not majority.
export function tallyReview(verdicts) {
  const counts = { blocker: 0, risk: 0, nit: 0 };
  const blockers = [];
  for (const v of verdicts) {
    for (const f of (v.findings || [])) {
      // Only the known severities (blocker/risk/nit) are counted. Any other
      // severity (e.g. "critical") is intentionally skipped — unknown values
      // are not part of the gate's vocabulary and must not affect counts or
      // the pass/block verdict.
      if (counts[f.severity] !== undefined) counts[f.severity] += 1;
      if (f.severity === "blocker") blockers.push({ reviewer: v.reviewer, note: f.note });
    }
  }
  return { blocked: blockers.length > 0, blockers, counts };
}
