// Book-genesis floor principle: weakest dimension must clear `floor` AND total must clear `pass_total`.
export function scoreArtifact(scores, gate = {}) {
  const entries = Object.entries(scores || {});
  const total = entries.reduce((s, [, v]) => s + v, 0);
  let weakest = { criterion: null, value: entries.length ? Infinity : 0 };
  for (const [c, v] of entries) if (v < weakest.value) weakest = { criterion: c, value: v };
  const passing = entries.length > 0 && weakest.value >= (gate.floor ?? 0) && total >= (gate.pass_total ?? 0);
  return { total, weakest, passing };
}
