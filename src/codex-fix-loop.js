function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
}

function reduction(before, after) {
  return before === 0 ? 0 : ((before - after) / before) * 100;
}

export function benchmarkCodexFixLoops(cases = []) {
  if (!Array.isArray(cases) || cases.length === 0) {
    throw new Error("benchmarkCodexFixLoops: at least one case is required");
  }
  const measured = cases.map((entry, index) => {
    if (entry?.fresh?.type !== "turn.completed" || entry?.continued?.type !== "turn.completed") {
      throw new Error(`benchmarkCodexFixLoops: case ${index + 1} requires fresh and continued turn.completed evidence`);
    }
    const seedInputTokens = entry.seed?.usage?.input_tokens;
    const seedCachedInputTokens = entry.seed?.usage?.cached_input_tokens ?? 0;
    const continuedTotalInputTokens = entry.continued.usage?.input_tokens - seedInputTokens;
    const continuedCachedInputTokens = (entry.continued.usage?.cached_input_tokens ?? 0) - seedCachedInputTokens;
    return {
      freshInputTokens: entry.fresh.usage?.input_tokens,
      continuedInputTokens: continuedTotalInputTokens,
      freshUncachedInputTokens: entry.fresh.usage?.input_tokens - (entry.fresh.usage?.cached_input_tokens ?? 0),
      continuedUncachedInputTokens: continuedTotalInputTokens - continuedCachedInputTokens,
      freshTimeMs: entry.fresh.wallTimeMs,
      continuedTimeMs: entry.continued.wallTimeMs
    };
  });
  const fields = [
    "freshInputTokens", "continuedInputTokens", "freshUncachedInputTokens",
    "continuedUncachedInputTokens", "freshTimeMs", "continuedTimeMs"
  ];
  for (const [index, entry] of measured.entries()) {
    for (const field of fields) {
      if (!Number.isFinite(entry[field]) || entry[field] < 0) {
        throw new Error(`benchmarkCodexFixLoops: case ${index + 1} ${field} must be a non-negative number`);
      }
    }
  }
  const medianFreshInputTokens = median(measured.map(entry => entry.freshInputTokens));
  const medianContinuedInputTokens = median(measured.map(entry => entry.continuedInputTokens));
  const medianFreshTimeMs = median(measured.map(entry => entry.freshTimeMs));
  const medianContinuedTimeMs = median(measured.map(entry => entry.continuedTimeMs));
  const medianFreshUncachedInputTokens = median(measured.map(entry => entry.freshUncachedInputTokens));
  const medianContinuedUncachedInputTokens = median(measured.map(entry => entry.continuedUncachedInputTokens));
  return {
    caseCount: cases.length,
    medianFreshInputTokens,
    medianContinuedInputTokens,
    medianTotalInputTokenReductionPct: reduction(medianFreshInputTokens, medianContinuedInputTokens),
    medianFreshUncachedInputTokens,
    medianContinuedUncachedInputTokens,
    medianUncachedInputTokenReductionPct: reduction(medianFreshUncachedInputTokens, medianContinuedUncachedInputTokens),
    medianFreshTimeMs,
    medianContinuedTimeMs,
    medianTimeToFixReductionPct: reduction(medianFreshTimeMs, medianContinuedTimeMs)
  };
}
