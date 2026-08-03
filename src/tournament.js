import { compareStringsForEnvironment } from "./locale-order.js";

// Pick the highest-scoring PASSING candidate. None passing -> escalate.
export function pickWinner(candidates, { environment = process.env } = {}) {
  // Guard: malformed input returns a clean escalation shape, no throw.
  if (!Array.isArray(candidates)) return { winner: null, escalate: true, ranking: [] };

  const ranking = candidates
    .map(c => ({ id: c.id, total: c.total, passing: !!c.passing }))
    .sort((a, b) => b.total - a.total || compareStringsForEnvironment(a.id, b.id, environment));
  const passing = ranking.filter(c => c.passing);
  if (passing.length === 0) return { winner: null, escalate: true, ranking };
  return { winner: passing[0].id, escalate: false, ranking };
}
