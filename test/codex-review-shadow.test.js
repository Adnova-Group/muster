import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildCodexReviewShadowCall,
  parseCodexReviewJsonl,
  scoreCodexReviewShadow,
  validateShadowVerdict,
} from "../src/codex-review-shadow.js";

const cleanVerdict = {
  verdict: "BLOCKED",
  findings: [{
    severity: "blocker",
    summary: "Unsafe manifest read is swallowed",
    details: "The catch path hides the no-follow reader failure.",
    path: "src/doctor.js",
    line: 42,
  }],
};
const completeUsage = {
  inputTokens: 80,
  cachedInputTokens: 0,
  outputTokens: 20,
  totalTokens: 100,
  uncachedTokens: 100,
};

test("validateShadowVerdict accepts the committed schema shape and rejects drift", () => {
  assert.deepEqual(validateShadowVerdict(cleanVerdict), { ok: true, errors: [] });
  const bad = structuredClone(cleanVerdict);
  bad.findings[0].severity = "critical";
  delete bad.findings[0].summary;
  bad.unexpected = true;
  bad.findings[0].unexpected = true;
  bad.findings.push(...Array.from({ length: 5 }, () => structuredClone(cleanVerdict.findings[0])));
  const result = validateShadowVerdict(bad);
  assert.equal(result.ok, false);
  assert.match(result.errors.join("\n"), /severity/);
  assert.match(result.errors.join("\n"), /summary/);
  assert.match(result.errors.join("\n"), /unexpected/);
  assert.match(result.errors.join("\n"), /at most 5/);
});

test("parseCodexReviewJsonl extracts the final structured verdict and measured usage", () => {
  const stdout = [
    JSON.stringify({ type: "thread.started", thread_id: "t-1" }),
    JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: JSON.stringify(cleanVerdict) } }),
    JSON.stringify({ type: "turn.completed", usage: { input_tokens: 120, cached_input_tokens: 20, output_tokens: 30 } }),
  ].join("\n");

  assert.deepEqual(parseCodexReviewJsonl(stdout), {
    verdict: cleanVerdict,
    usage: {
      inputTokens: 120,
      cachedInputTokens: 20,
      outputTokens: 30,
      totalTokens: 150,
      uncachedTokens: 130,
    },
    rawAgentMessage: JSON.stringify(cleanVerdict),
    diagnosticEvents: [
      JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: JSON.stringify(cleanVerdict) } }),
      JSON.stringify({ type: "turn.completed", usage: { input_tokens: 120, cached_input_tokens: 20, output_tokens: 30 } }),
    ],
  });
});

test("parseCodexReviewJsonl preserves terminal failures and rejects partial usage", () => {
  const completed = JSON.stringify({
    type: "turn.completed",
    usage: { output_tokens: 1 },
  });
  const failed = JSON.stringify({
    type: "turn.failed",
    error: { message: "review failed" },
  });

  const result = parseCodexReviewJsonl(`${completed}\n${failed}\n`);
  assert.equal(result.usage, undefined);
  assert.deepEqual(result.diagnosticEvents, [completed, failed]);
});

test("buildCodexReviewShadowCall uses exec review with JSONL and schema but no adoption flags", () => {
  const call = buildCodexReviewShadowCall({
    commit: "abc123",
    schemaPath: "/tmp/verdict.schema.json",
    lastMessagePath: "/tmp/last.json",
    model: "gpt-5.6-terra",
  });
  assert.equal(call.command, "codex");
  assert.deepEqual(call.argv, [
    "exec", "review", "--json", "--output-schema", "/tmp/verdict.schema.json",
    "--output-last-message", "/tmp/last.json", "--model", "gpt-5.6-terra",
    "--commit", "abc123", "--ephemeral", "--ignore-user-config", "--strict-config",
  ]);
});

test("scoreCodexReviewShadow requires every known blocker, every schema-valid run, and <=25% token consumption", () => {
  const seeds = [
    { id: "a", knownBlocker: { paths: ["src/doctor.js"], terms: ["unsafe", "manifest"] }, currentReviewTokens: 800 },
    { id: "b", knownBlocker: { paths: ["src/config.js"], terms: ["config", "cap"] }, currentReviewTokens: 800 },
  ];
  const seedRuns = [
    { id: "a", schemaValid: true, verdict: cleanVerdict, usage: completeUsage },
    {
      id: "b",
      schemaValid: true,
      verdict: {
        verdict: "BLOCKED",
        findings: [{ severity: "blocker", summary: "Config cap is too small", details: "Regression", path: "src/config.js" }],
      },
      usage: completeUsage,
    },
  ];
  const corpus = Array.from({ length: 10 }, (_, index) => ({
    ...seeds[index % seeds.length],
    id: `case-${index}`,
  }));
  const runs = Array.from({ length: 10 }, (_, index) => ({
    ...seedRuns[index % seedRuns.length],
    id: `case-${index}`,
  }));

  const result = scoreCodexReviewShadow(corpus, runs);
  assert.equal(result.blockerRecallPct, 100);
  assert.equal(result.schemaValidPct, 100);
  assert.equal(result.tokenConsumptionPct, 12.5);
  assert.equal(result.acceptancePassed, true);

  runs[1].verdict = { ...runs[1].verdict, findings: [] };
  const miss = scoreCodexReviewShadow(corpus, runs);
  assert.equal(miss.blockerRecallPct, 90);
  assert.equal(miss.acceptancePassed, false);
});

test("scoreCodexReviewShadow fails closed on missing usage and non-blocking findings", () => {
  const corpus = Array.from({ length: 10 }, (_, index) => ({
    id: `case-${index}`,
    knownBlocker: { paths: ["src/doctor.js"], terms: ["unsafe"] },
    currentReviewTokens: 1000,
  }));
  const runs = corpus.map(({ id }) => ({
    id,
    schemaValid: true,
    verdict: {
      verdict: "PASS",
      findings: [{
        severity: "nit",
        summary: "Unsafe wording",
        details: "This is not a blocking defect.",
        path: "src/doctor.js",
      }],
    },
    usage: completeUsage,
  }));

  const nonBlockers = scoreCodexReviewShadow(corpus, runs);
  assert.equal(nonBlockers.blockerRecallPct, 0);
  assert.equal(nonBlockers.acceptancePassed, false);

  for (const run of runs) {
    run.verdict.verdict = "BLOCKED";
    run.verdict.findings[0].severity = "blocker";
  }
  delete runs[0].usage;
  const missingUsage = scoreCodexReviewShadow(corpus, runs);
  assert.equal(missingUsage.usageValidPct, 90);
  assert.equal(missingUsage.acceptancePassed, false);

  runs[0].usage = { outputTokens: 1, totalTokens: 1 };
  const partialUsage = scoreCodexReviewShadow(corpus, runs);
  assert.equal(partialUsage.usageValidPct, 90);
  assert.equal(partialUsage.acceptancePassed, false);
});
