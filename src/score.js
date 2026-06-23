// Optional judge-calibration (microsoft/LLM-Rubric idea): different judge models drift on the same
// rubric, so raw 0–3 ratings aren't comparable across providers. `calibrateScores` applies a
// per-criterion additive offset and clamps back into [min,max]. The offsets are EMPIRICAL — they must
// be measured against human labels per judge model; until then the table is empty and this is a
// deterministic no-op (identity), so calibration never silently distorts an un-calibrated run.
export function calibrateScores(scores, offsets = {}, { min = 0, max = 3 } = {}) {
  const out = {};
  for (const [c, v] of Object.entries(scores || {})) {
    if (typeof v !== "number" || !Number.isFinite(v))
      throw new Error(`calibrateScores: score for "${c}" must be a finite number, got ${v}`);
    const off = offsets[c] || 0;
    out[c] = Math.max(min, Math.min(max, v + off));
  }
  return out;
}

// Book-genesis floor principle: weakest dimension must clear `floor` AND total must clear `pass_total`.
export function scoreArtifact(scores, gate = {}) {
  const entries = Object.entries(scores || {});
  for (const [c, v] of entries) {
    if (typeof v !== "number" || !Number.isFinite(v))
      throw new Error(`scoreArtifact: score for "${c}" must be a finite number, got ${v}`);
  }
  const total = entries.reduce((s, [, v]) => s + v, 0);
  let weakest = { criterion: null, value: entries.length ? Infinity : 0 };
  // Strict `<` means ties are broken by insertion order: the first criterion
  // with the lowest score wins and stays `weakest` (later equal values don't
  // replace it). Deterministic given Object.entries' insertion-order iteration.
  for (const [c, v] of entries) if (v < weakest.value) weakest = { criterion: c, value: v };
  const passing = entries.length > 0 && weakest.value >= (gate.floor ?? 0) && total >= (gate.pass_total ?? 0);
  return { total, weakest, passing };
}
