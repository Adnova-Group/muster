const SEVERITIES = new Set(["blocker", "risk", "nit"]);
const VERDICTS = new Set(["PASS", "BLOCKED"]);
const VERDICT_FIELDS = new Set(["verdict", "findings"]);
const FINDING_FIELDS = new Set(["severity", "summary", "details", "path", "line"]);

export function validateShadowVerdict(value) {
  const errors = [];
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, errors: ["verdict must be an object"] };
  }
  for (const field of Object.keys(value)) {
    if (!VERDICT_FIELDS.has(field)) errors.push(`unexpected verdict field: ${field}`);
  }
  if (!VERDICTS.has(value.verdict)) errors.push("verdict must be PASS or BLOCKED");
  if (!Array.isArray(value.findings)) {
    errors.push("findings must be an array");
  } else {
    if (value.findings.length > 5) errors.push("findings must contain at most 5 items");
    value.findings.forEach((finding, index) => {
      if (!finding || typeof finding !== "object" || Array.isArray(finding)) {
        errors.push(`findings[${index}] must be an object`);
        return;
      }
      for (const field of Object.keys(finding)) {
        if (!FINDING_FIELDS.has(field)) errors.push(`findings[${index}] has unexpected field: ${field}`);
      }
      if (!SEVERITIES.has(finding.severity)) {
        errors.push(`findings[${index}].severity must be blocker, risk, or nit`);
      }
      for (const field of ["summary", "details", "path"]) {
        if (typeof finding[field] !== "string" || !finding[field].trim()) {
          errors.push(`findings[${index}].${field} must be a non-empty string`);
        }
      }
      if (finding.line !== undefined && (!Number.isInteger(finding.line) || finding.line < 1)) {
        errors.push(`findings[${index}].line must be a positive integer`);
      }
    });
  }
  return { ok: errors.length === 0, errors };
}

export function parseCodexReviewJsonl(stdout) {
  let verdict;
  let usage;
  let rawAgentMessage;
  const diagnosticEvents = [];
  for (const line of String(stdout ?? "").split(/\r?\n/)) {
    if (!line.trim()) continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (event?.type === "item.completed" && event.item?.type === "agent_message") {
      rawAgentMessage = event.item.text;
      diagnosticEvents.push(line);
      try {
        verdict = JSON.parse(event.item.text);
      } catch {
        // The schema-validation result below reports a missing structured verdict.
      }
    }
    if (event?.type === "turn.completed" || event?.type === "turn.failed") {
      diagnosticEvents.push(line);
      const raw = event.usage;
      if (
        event.type === "turn.completed"
        && raw && typeof raw === "object"
        && ["input_tokens", "cached_input_tokens", "output_tokens"].every(field => (
          Object.hasOwn(raw, field)
          && Number.isFinite(raw[field])
          && Number.isInteger(raw[field])
          && raw[field] >= 0
        ))
        && raw.cached_input_tokens <= raw.input_tokens
      ) {
        const inputTokens = raw.input_tokens;
        const cachedInputTokens = raw.cached_input_tokens;
        const outputTokens = raw.output_tokens;
        usage = {
          inputTokens,
          cachedInputTokens,
          outputTokens,
          totalTokens: inputTokens + outputTokens,
          uncachedTokens: inputTokens - cachedInputTokens + outputTokens,
        };
      }
    }
  }
  return { verdict, usage, rawAgentMessage, diagnosticEvents };
}

export function buildCodexReviewShadowCall({
  commit,
  schemaPath,
  lastMessagePath,
  model,
} = {}) {
  if (typeof commit !== "string" || !commit.trim()) throw new Error("commit is required");
  if (typeof schemaPath !== "string" || !schemaPath.trim()) throw new Error("schemaPath is required");
  const argv = ["exec", "review", "--json", "--output-schema", schemaPath];
  if (lastMessagePath) argv.push("--output-last-message", lastMessagePath);
  if (model) argv.push("--model", model);
  argv.push(
    "--commit", commit,
    "--ephemeral",
    "--ignore-user-config",
    "--strict-config",
  );
  return { command: "codex", argv };
}

function findingMatches(blocker, finding) {
  const expectedPaths = blocker.paths ?? [];
  const pathMatches = expectedPaths.length === 0 || expectedPaths.some(path => finding.path === path);
  const haystack = `${finding.summary ?? ""} ${finding.details ?? ""}`.toLowerCase();
  const terms = blocker.terms ?? [];
  const termsMatch = terms.length === 0 || terms.some(term => haystack.includes(String(term).toLowerCase()));
  return pathMatches && termsMatch;
}

export function scoreCodexReviewShadow(corpus, runs) {
  const byId = new Map(runs.map(run => [run.id, run]));
  let blockerHits = 0;
  let schemaHits = 0;
  let usageHits = 0;
  let nativeTokens = 0;
  let currentReviewTokens = 0;
  const cases = corpus.map(entry => {
    const run = byId.get(entry.id);
    const schemaValid = Boolean(run?.schemaValid);
    const usage = run?.usage;
    const usageFields = [
      "inputTokens", "cachedInputTokens", "outputTokens", "totalTokens", "uncachedTokens",
    ];
    const usageValid = Boolean(
      usage
      && usageFields.every(field => (
        Object.hasOwn(usage, field)
        && Number.isFinite(usage[field])
        && Number.isInteger(usage[field])
        && usage[field] >= 0
      ))
      && usage.cachedInputTokens <= usage.inputTokens
      && usage.totalTokens === usage.inputTokens + usage.outputTokens
      && usage.uncachedTokens === usage.inputTokens - usage.cachedInputTokens + usage.outputTokens
      && usage.totalTokens > 0,
    );
    const blockerHit = Boolean(
      schemaValid
      && run.verdict?.verdict === "BLOCKED"
      && run.verdict.findings?.some(finding => (
        finding.severity === "blocker"
        && findingMatches(entry.knownBlocker, finding)
      )),
    );
    if (schemaValid) schemaHits += 1;
    if (usageValid) usageHits += 1;
    if (blockerHit) blockerHits += 1;
    if (usageValid) nativeTokens += run.usage.totalTokens;
    currentReviewTokens += Number(entry.currentReviewTokens) || 0;
    return { id: entry.id, schemaValid, usageValid, blockerHit };
  });
  const denominator = corpus.length || 1;
  const blockerRecallPct = (blockerHits / denominator) * 100;
  const schemaValidPct = (schemaHits / denominator) * 100;
  const usageValidPct = (usageHits / denominator) * 100;
  const tokenConsumptionPct = currentReviewTokens > 0
    ? (nativeTokens / currentReviewTokens) * 100
    : Number.POSITIVE_INFINITY;
  return {
    corpusSize: corpus.length,
    blockerHits,
    blockerRecallPct,
    schemaHits,
    schemaValidPct,
    usageHits,
    usageValidPct,
    nativeTokens,
    currentReviewTokens,
    tokenConsumptionPct,
    acceptancePassed: corpus.length >= 10
      && blockerRecallPct === 100
      && schemaValidPct === 100
      && usageValidPct === 100
      && tokenConsumptionPct <= 25,
    cases,
  };
}
