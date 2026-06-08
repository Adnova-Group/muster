// Deterministic RICE prioritization scorer. Code does the math; the model only
// supplies the factor estimates. No LLM calls — given the same items, same ranking.
//
// Expected factor ranges (the math is scale-agnostic — any positive finite number works):
//   reach      = how many units (users/events) per period, a positive count
//   impact     = per-unit effect, e.g. 0.25–3 (RICE convention) or 1–10
//   confidence = certainty, either a 0–1 fraction OR a 1–100 percent
//   effort     = person-time to deliver (person-weeks/-months), must be > 0
//
// RICE score = (reach * impact * confidence) / effort.

function requirePositiveFinite(value, factor, name) {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0)
    throw new Error(`prioritizeRICE: "${name}" ${factor} must be a positive finite number, got ${value}`);
}

export function prioritizeRICE(items) {
  if (!Array.isArray(items))
    throw new Error(`prioritizeRICE: items must be an array, got ${typeof items}`);

  const scored = items.map((item, i) => {
    const name = item?.name;
    if (typeof name !== "string" || !name.trim())
      throw new Error(`prioritizeRICE: item at index ${i} must have a non-empty string "name"`);

    requirePositiveFinite(item.reach, "reach", name);
    requirePositiveFinite(item.impact, "impact", name);
    requirePositiveFinite(item.confidence, "confidence", name);
    // Explicit divide-by-zero guard, separate message from the positive-factor check.
    if (typeof item.effort !== "number" || !Number.isFinite(item.effort) || item.effort <= 0)
      throw new Error(`prioritizeRICE: "${name}" effort must be > 0, got ${item.effort}`);

    const raw = (item.reach * item.impact * item.confidence) / item.effort;
    const score = Math.round(raw * 100) / 100;
    return { ...item, score };
  });

  // score desc, tie-break name ascending. Deterministic total order.
  scored.sort((a, b) =>
    b.score - a.score
    || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

  return scored.map((item, i) => ({ ...item, rank: i + 1 }));
}

// Dispatch shape so ice/wsjf/weighted can be added later without touching callers.
export function prioritize(items, model = "rice") {
  if (model === "rice") return prioritizeRICE(items);
  throw new Error("unsupported model: " + model + " (supported: rice)");
}
