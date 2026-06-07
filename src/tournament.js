// Pick the highest-scoring PASSING candidate. None passing -> escalate.
export function pickWinner(candidates) {
  const ranking = candidates
    .map(c => ({ id: c.id, total: c.total, passing: !!c.passing }))
    .sort((a, b) => b.total - a.total || String(a.id).localeCompare(String(b.id)));
  const passing = ranking.filter(c => c.passing);
  if (passing.length === 0) return { winner: null, escalate: true, ranking };
  return { winner: passing[0].id, escalate: false, ranking };
}
