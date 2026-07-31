import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  UNKNOWN,
  evaluateAdoption,
  paginateAll,
  summarizeFixtureCases
} from "../eval/codex-ephemeral-fork-benchmark.mjs";

const fixtureUrl = new URL("../eval/fixtures/codex-ephemeral-fork-cases.json", import.meta.url);
const cases = JSON.parse(await readFile(fixtureUrl, "utf8"));

test("fixture matrix has at least 10 cases and covers all three requested lanes", () => {
  assert.ok(cases.length >= 10);
  assert.deepEqual(
    [...new Set(cases.map(item => item.lane))].sort(),
    ["read-only-review", "spec-gate", "tournament"]
  );
});

test("fixture summary reports correctness and history pollution per lane", () => {
  const summary = summarizeFixtureCases(cases);
  assert.equal(summary.caseCount, 12);
  assert.equal(summary.ephemeralFork.correctness, 1);
  assert.equal(summary.freshContext.correctness, 1);
  assert.equal(summary.ephemeralFork.historyPollutionTurns, 5);
  assert.equal(summary.freshContext.historyPollutionTurns, 0);
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
    fixtureCorrectnessDelta: 0,
    historyPollutionDeltaTurns: 4,
    modelWallTimeReductionPct: UNKNOWN,
    modelInputTokenReductionPct: UNKNOWN,
    ephemeralPersistenceLeaks: 0
  });
  assert.equal(decision.decision, "REJECT");
  assert.match(decision.failed.join("\n"), /UNKNOWN/);
});

test("adoption requires every threshold to pass", () => {
  const decision = evaluateAdoption({
    fixtureCorrectnessDelta: 0,
    historyPollutionDeltaTurns: 0,
    modelWallTimeReductionPct: 20,
    modelInputTokenReductionPct: 15,
    ephemeralPersistenceLeaks: 0
  });
  assert.equal(decision.decision, "ADOPT");
  assert.deepEqual(decision.failed, []);
});
