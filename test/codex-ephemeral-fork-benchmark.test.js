import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  UNKNOWN,
  evaluateAdoption,
  paginateAll,
  percentile,
  scoreModelResult,
  summarizeModelPairs,
  summarizeFixtureCases
} from "../eval/codex-ephemeral-fork-benchmark.mjs";

const fixtureUrl = new URL("../eval/fixtures/codex-ephemeral-fork-cases.json", import.meta.url);
const cases = JSON.parse(await readFile(fixtureUrl, "utf8"));
const resultUrl = new URL("../eval/results/codex-ephemeral-fork-benchmark.json", import.meta.url);

test("fixture matrix has at least 10 cases and covers all three requested lanes", () => {
  assert.ok(cases.length >= 10);
  assert.deepEqual(
    [...new Set(cases.map(item => item.lane))].sort(),
    ["read-only-review", "spec-gate", "tournament"]
  );
  assert.ok(cases.every(item => item.material && typeof item.material === "object"));
});

test("fixture summary refuses to invent model correctness or history measurements", () => {
  const summary = summarizeFixtureCases(cases);
  assert.equal(summary.caseCount, 12);
  assert.equal(summary.ephemeralFork.correctness, UNKNOWN);
  assert.equal(summary.freshContext.correctness, UNKNOWN);
  assert.equal(summary.ephemeralFork.historyPollutionTurns, UNKNOWN);
  assert.equal(summary.freshContext.historyPollutionTurns, UNKNOWN);
  assert.equal(summary.ephemeralFork.inputTokens, UNKNOWN);
  assert.equal(summary.freshContext.inputTokens, UNKNOWN);
});

test("paginateAll follows opaque cursors to exhaustion without inventing a page cap", async () => {
  const seen = [];
  const pages = {
    null: { data: ["a", "b"], nextCursor: "opaque-1" },
    "opaque-1": { data: ["c"], nextCursor: "opaque-2" },
    "opaque-2": { data: ["d"], nextCursor: null }
  };
  const result = await paginateAll(async cursor => {
    seen.push(cursor);
    return pages[String(cursor)];
  });
  assert.deepEqual(seen, [null, "opaque-1", "opaque-2"]);
  assert.deepEqual(result, ["a", "b", "c", "d"]);
});

test("adoption fails closed when model wall time or token metrics are UNKNOWN", () => {
  const decision = evaluateAdoption({
    caseCount: 12,
    fixtureCorrectnessDelta: UNKNOWN,
    historyPollutionDeltaTurns: UNKNOWN,
    modelWallTimeReductionPct: UNKNOWN,
    modelInputTokenReductionPct: UNKNOWN,
    ephemeralPersistenceLeaks: 0
  });
  assert.equal(decision.decision, "REJECT");
  assert.match(decision.failed.join("\n"), /UNKNOWN/);
});

test("adoption requires every threshold to pass", () => {
  const decision = evaluateAdoption({
    caseCount: 12,
    fixtureCorrectnessDelta: 0,
    historyPollutionDeltaTurns: 0,
    modelWallTimeReductionPct: 20,
    modelInputTokenReductionPct: 15,
    ephemeralPersistenceLeaks: 0
  });
  assert.equal(decision.decision, "ADOPT");
  assert.deepEqual(decision.failed, []);
});

test("adoption enforces the published minimum-case threshold", () => {
  const decision = evaluateAdoption({
    caseCount: 9,
    fixtureCorrectnessDelta: 0,
    historyPollutionDeltaTurns: 0,
    modelWallTimeReductionPct: 20,
    modelInputTokenReductionPct: 15,
    ephemeralPersistenceLeaks: 0
  });
  assert.equal(decision.decision, "REJECT");
  assert.match(decision.failed.join("\n"), /representative case count/);
});

test("percentile uses nearest-rank values for benchmark p50 and p95", () => {
  assert.equal(percentile([9, 1, 5, 3, 7], 50), 5);
  assert.equal(percentile(Array.from({ length: 20 }, (_, index) => index + 1), 95), 19);
  assert.throws(() => percentile([], 50), /non-empty/);
});

test("model scoring is exact and separately records inherited-history visibility", () => {
  assert.deepEqual(
    scoreModelResult({ answer: "PASS", historySentinelSeen: true }, "PASS"),
    { correct: true, historySentinelSeen: true }
  );
  assert.deepEqual(
    scoreModelResult({ answer: "pass", historySentinelSeen: false }, "PASS"),
    { correct: false, historySentinelSeen: false }
  );
  assert.throws(
    () => scoreModelResult({ answer: "PASS", historySentinelSeen: "yes" }, "PASS"),
    /historySentinelSeen/
  );
});

test("paired model summary reports p50/p95 time and input tokens without dropping case receipts", () => {
  const pairs = Array.from({ length: 12 }, (_, index) => ({
    id: `case-${index + 1}`,
    expected: "PASS",
    ephemeralFork: {
      wallTimeMs: index + 1,
      inputTokens: 100 + index,
      correct: true,
      historySentinelSeen: true,
      inheritedHistoryTurns: 1
    },
    freshContext: {
      wallTimeMs: 20 + index,
      inputTokens: 80 + index,
      correct: index !== 0,
      historySentinelSeen: false,
      inheritedHistoryTurns: 0
    }
  }));
  const summary = summarizeModelPairs(pairs);
  assert.equal(summary.caseCount, 12);
  assert.deepEqual(summary.ephemeralFork.wallTimeMs, { p50: 6, p95: 12 });
  assert.deepEqual(summary.ephemeralFork.inputTokens, { p50: 105, p95: 111 });
  assert.equal(summary.ephemeralFork.correctness, 1);
  assert.equal(summary.freshContext.correctness, 11 / 12);
  assert.equal(summary.ephemeralFork.historyPollutionTurns, 12);
  assert.equal(summary.freshContext.historyPollutionTurns, 0);
});

test("checked-in benchmark contains complete real-model receipts and zero persistence leaks", async () => {
  const result = JSON.parse(await readFile(resultUrl, "utf8"));
  assert.equal(result.schema, "muster-codex-ephemeral-fork-benchmark/v2");
  assert.match(result.modelWork.codexVersion, /^codex-cli 0\.146\.0$/);
  assert.equal(typeof result.modelWork.model, "string");
  assert.equal(result.modelWork.effort, "low");
  assert.equal(result.modelWork.pairs.length, 12);
  for (const pair of result.modelWork.pairs) {
    for (const lane of ["ephemeralFork", "freshContext"]) {
      assert.equal(typeof pair[lane].wallTimeMs, "number");
      assert.equal(typeof pair[lane].inputTokens, "number");
      assert.equal(typeof pair[lane].correct, "boolean");
      assert.equal(typeof pair[lane].historySentinelSeen, "boolean");
      assert.equal(typeof pair[lane].inheritedHistoryTurns, "number");
    }
  }
  for (const lane of ["ephemeralFork", "freshContext"]) {
    assert.equal(typeof result.modelWork.summary[lane].wallTimeMs.p50, "number");
    assert.equal(typeof result.modelWork.summary[lane].wallTimeMs.p95, "number");
    assert.equal(typeof result.modelWork.summary[lane].inputTokens.p50, "number");
    assert.equal(typeof result.modelWork.summary[lane].inputTokens.p95, "number");
  }
  assert.equal(result.modelWork.ephemeralPersistenceLeaks, 0);
  assert.equal(result.productionDependencyAdded, false);
});
