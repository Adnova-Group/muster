import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  UNKNOWN,
  evaluateAdoption,
  parseFeatureList,
  summarizePairs
} from "../eval/codex-code-mode-inner-loop-benchmark.mjs";

const fixtureUrl = new URL("../eval/fixtures/codex-code-mode-inner-loop-cases.json", import.meta.url);
const cases = JSON.parse(await readFile(fixtureUrl, "utf8"));
const decisionDoc = await readFile(
  new URL("../docs/codex-code-mode-inner-loop-benchmark.md", import.meta.url),
  "utf8"
);

test("fixture matrix has at least 10 paired investigator/evidence cases", () => {
  assert.ok(cases.length >= 10);
  assert.deepEqual([...new Set(cases.map(item => item.lane))].sort(), ["evidence", "investigator"]);
  assert.ok(cases.every(item => item.id && item.task && item.expected));
});

test("feature parser distinguishes stable Code Mode from its stable host", () => {
  const features = parseFeatureList([
    "code_mode                            under development  false",
    "code_mode_host                       stable             true"
  ].join("\n"));
  assert.deepEqual(features.code_mode, { stage: "under development", enabled: false });
  assert.deepEqual(features.code_mode_host, { stage: "stable", enabled: true });
});

test("unavailable stable Code Mode records no fabricated paired measurements", () => {
  const summary = summarizePairs(cases, []);
  assert.equal(summary.completedPairs, 0);
  assert.equal(summary.codeMode.latencyMs.p50, UNKNOWN);
  assert.equal(summary.currentPath.inputTokens.p95, UNKNOWN);
  assert.equal(summary.correctnessRegressions, UNKNOWN);
});

test("paired summary records p50/p95 and rejects a correctness regression", () => {
  const pairs = cases.map((item, index) => ({
    id: item.id,
    codeMode: { latencyMs: 40 + index, inputTokens: 80 + index, correct: index !== 0 },
    currentPath: { latencyMs: 100 + index, inputTokens: 100 + index, correct: true }
  }));
  const summary = summarizePairs(cases, pairs);
  assert.equal(summary.completedPairs, 10);
  assert.equal(summary.codeMode.latencyMs.p50, 44.5);
  assert.equal(summary.currentPath.latencyMs.p95, 108.55);
  assert.equal(summary.correctnessRegressions, 1);
  assert.equal(evaluateAdoption(summary).decision, "REJECT");
});

test("adoption requires 10 pairs, zero regressions, and 20% median improvement in either metric", () => {
  const passing = cases.map((item, index) => ({
    id: item.id,
    codeMode: { latencyMs: 75 + index, inputTokens: 99 + index, correct: true },
    currentPath: { latencyMs: 100 + index, inputTokens: 100 + index, correct: true }
  }));
  const decision = evaluateAdoption(summarizePairs(cases, passing));
  assert.equal(decision.decision, "ADOPT");
  assert.equal(decision.metrics.medianLatencyReductionPct >= 20, true);
  assert.equal(decision.metrics.medianInputTokenReductionPct >= 20, false);
});

test("adoption fails closed when paired metrics are unavailable", () => {
  const decision = evaluateAdoption(summarizePairs(cases, []));
  assert.equal(decision.decision, "REJECT");
  assert.match(decision.failed.join("\n"), /10 completed pairs/);
  assert.match(decision.failed.join("\n"), /UNKNOWN/);
});

test("decision record retains fallback and excludes Code Mode from orchestration", () => {
  assert.match(decisionDoc, /REJECT production adoption/);
  assert.match(decisionDoc, /Retain Muster's current crew-member tool-call path/);
  assert.match(decisionDoc, /never become the wave-orchestration mechanism/);
  assert.match(decisionDoc, /at least 20% lower median latency/);
});
