// Deterministic prioritization scorers. Code does the math; the model only
// supplies the factor estimates. No LLM calls — given the same items, same ranking.
//
// Four models, each a pure ranking over the same item shape `{ name, ...factors }`:
//   rice     = (reach * impact * confidence) / effort
//   ice      = impact * confidence * ease
//   wsjf     = costOfDelay / jobSize
//   weighted = sum over criteria of (weight * score)   (Aha-style scorecard)
//
// Every model fails loud on non-finite, non-positive, or zero-denominator inputs.

function requirePositiveFinite(value, factor, fn, name) {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0)
    throw new Error(`${fn}: "${name}" ${factor} must be a positive finite number, got ${value}`);
}

function requireNonNegativeFinite(value, factor, fn, name) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0)
    throw new Error(`${fn}: "${name}" ${factor} must be a non-negative finite number, got ${value}`);
}

// Shared scaffold every model reuses: validate the item array + names, compute
// each raw score via `rawScore(item, name)`, round to 2 decimals, then sort
// score-desc with an ascending-name tie-break and assign 1-based ranks. This is
// the deterministic total order; only the per-model `rawScore` differs.
function scoreAndRank(items, fn, rawScore) {
  if (!Array.isArray(items))
    throw new Error(`${fn}: items must be an array, got ${typeof items}`);

  const scored = items.map((item, i) => {
    const name = item?.name;
    if (typeof name !== "string" || !name.trim())
      throw new Error(`${fn}: item at index ${i} must have a non-empty string "name"`);

    const raw = rawScore(item, name);
    const score = Math.round(raw * 100) / 100;
    return { ...item, score };
  });

  // score desc, tie-break name ascending. Deterministic total order.
  scored.sort((a, b) =>
    b.score - a.score
    || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

  return scored.map((item, i) => ({ ...item, rank: i + 1 }));
}

// RICE = (reach * impact * confidence) / effort.
//   reach      = units (users/events) per period, a positive count
//   impact     = per-unit effect (0.25–3 RICE convention, or 1–10)
//   confidence = certainty, a 0–1 fraction OR a 1–100 percent
//   effort     = person-time to deliver, must be > 0
export function prioritizeRICE(items) {
  return scoreAndRank(items, "prioritizeRICE", (item, name) => {
    requirePositiveFinite(item.reach, "reach", "prioritizeRICE", name);
    requirePositiveFinite(item.impact, "impact", "prioritizeRICE", name);
    requirePositiveFinite(item.confidence, "confidence", "prioritizeRICE", name);
    // Explicit divide-by-zero guard, separate message from the positive-factor check.
    if (typeof item.effort !== "number" || !Number.isFinite(item.effort) || item.effort <= 0)
      throw new Error(`prioritizeRICE: "${name}" effort must be > 0, got ${item.effort}`);
    return (item.reach * item.impact * item.confidence) / item.effort;
  });
}

// ICE = impact * confidence * ease. Each factor a positive score (commonly 1–10).
export function prioritizeICE(items) {
  return scoreAndRank(items, "prioritizeICE", (item, name) => {
    requirePositiveFinite(item.impact, "impact", "prioritizeICE", name);
    requirePositiveFinite(item.confidence, "confidence", "prioritizeICE", name);
    requirePositiveFinite(item.ease, "ease", "prioritizeICE", name);
    return item.impact * item.confidence * item.ease;
  });
}

// WSJF = costOfDelay / jobSize (SAFe). Higher cost-of-delay per unit of job size ranks first.
export function prioritizeWSJF(items) {
  return scoreAndRank(items, "prioritizeWSJF", (item, name) => {
    requirePositiveFinite(item.costOfDelay, "costOfDelay", "prioritizeWSJF", name);
    // Explicit divide-by-zero guard, separate message from the positive-factor check.
    if (typeof item.jobSize !== "number" || !Number.isFinite(item.jobSize) || item.jobSize <= 0)
      throw new Error(`prioritizeWSJF: "${name}" jobSize must be > 0, got ${item.jobSize}`);
    return item.costOfDelay / item.jobSize;
  });
}

// Weighted scorecard (Aha-style) = sum over criteria of (weight * score).
//   item.criteria = [{ weight, score }, ...]   weight > 0, score >= 0 (0 is a valid "no value here")
export function prioritizeWeighted(items) {
  return scoreAndRank(items, "prioritizeWeighted", (item, name) => {
    const criteria = item?.criteria;
    if (!Array.isArray(criteria) || criteria.length === 0)
      throw new Error(`prioritizeWeighted: "${name}" must have a non-empty "criteria" array`);
    return criteria.reduce((sum, c, j) => {
      requirePositiveFinite(c?.weight, `criteria[${j}].weight`, "prioritizeWeighted", name);
      requireNonNegativeFinite(c?.score, `criteria[${j}].score`, "prioritizeWeighted", name);
      return sum + c.weight * c.score;
    }, 0);
  });
}

// Dispatch by model name. Adding a model here is the only wiring callers need.
const MODELS = {
  rice: prioritizeRICE,
  ice: prioritizeICE,
  wsjf: prioritizeWSJF,
  weighted: prioritizeWeighted,
};

export function prioritize(items, model = "rice") {
  const scorer = MODELS[model];
  if (!scorer)
    throw new Error(`unsupported model: ${model} (supported: ${Object.keys(MODELS).join(", ")})`);
  return scorer(items);
}
