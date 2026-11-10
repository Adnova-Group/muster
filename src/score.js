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
    const off = offsets[c];
    if (off !== undefined && (typeof off !== "number" || !Number.isFinite(off)))
      throw new Error(`calibrateScores: offset for "${c}" must be a finite number, got ${off}`);
    out[c] = Math.max(min, Math.min(max, v + (off || 0)));
  }
  return out;
}

// Book-genesis floor principle: weakest dimension must clear `floor` AND total must clear `pass_total`.
//
// Incomplete rubric (book-genesis-studio's Genesis Score, 5.x): a criterion the scorer could not
// assess is written as `null` ("not assessed"), never as an invented number. A `null` score, or a
// criterion named in `gate.criteria` that has no score at all, makes the rubric incomplete: it is
// listed under `incomplete` and the gate does not pass, however high the scored criteria are. The
// `incomplete` key appears only when something is missing, so complete results keep their shape.
export function scoreArtifact(scores, gate = {}) {
  const entries = Object.entries(scores || {});
  for (const [c, v] of entries) {
    if (v === null) continue;
    if (typeof v !== "number" || !Number.isFinite(v))
      throw new Error(`scoreArtifact: score for "${c}" must be a finite number, got ${v} (write null for a criterion not assessed)`);
  }
  const assessed = entries.filter(([, v]) => v !== null);
  const incomplete = entries.filter(([, v]) => v === null).map(([c]) => c);
  for (const c of Array.isArray(gate?.criteria) ? gate.criteria : [])
    if (!Object.prototype.hasOwnProperty.call(scores || {}, c)) incomplete.push(c);
  const total = assessed.reduce((s, [, v]) => s + v, 0);
  let weakest = { criterion: null, value: assessed.length ? Infinity : 0 };
  // Strict `<` means ties are broken by insertion order: the first criterion
  // with the lowest score wins and stays `weakest` (later equal values don't
  // replace it). Deterministic given Object.entries' insertion-order iteration.
  for (const [c, v] of assessed) if (v < weakest.value) weakest = { criterion: c, value: v };
  const passing = assessed.length > 0 && incomplete.length === 0
    && weakest.value >= (gate?.floor ?? 0) && total >= (gate?.pass_total ?? 0);
  return incomplete.length ? { total, weakest, passing, incomplete } : { total, weakest, passing };
}
