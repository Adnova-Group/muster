import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  UNKNOWN,
  evaluateAdoption,
  parseFeatureList,
  runBenchmark,
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
  assert.ok(cases.every(item =>
    item.id && item.task && item.sourceCommit === "248f556c790ff1b9765c053c89a7d7e1669a4419" &&
    typeof item.expected?.value === "string"
  ));
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
  assert.equal(summary.codeModeIncorrect, UNKNOWN);
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

test("adoption rejects fast measurements when neither lane matches the pinned gold answer", () => {
  const wrong = cases.map(item => ({
    id: item.id,
    codeMode: { latencyMs: 1, inputTokens: 1, correct: false },
    currentPath: { latencyMs: 100, inputTokens: 100, correct: false }
  }));
  const decision = evaluateAdoption(summarizePairs(cases, wrong));
  assert.equal(decision.decision, "REJECT");
  assert.match(decision.failed.join("\n"), /gold-case correctness/);
});

test("unsupported host ignores the execution path and records UNKNOWN metrics", async () => {
  const result = await runBenchmark({
    outPath: null,
    probe: async () => ({
      version: "codex-cli test",
      features: {
        code_mode: { stage: "under development", enabled: false },
        code_mode_host: { stage: "stable", enabled: true }
      },
      models: [{ slug: "test-model", toolMode: "code_mode_only" }]
    })
  });
  assert.equal(result.protocol.pairedCasesExecuted, 0);
  assert.deepEqual(result.pairs, []);
  assert.equal(result.summary.codeMode.latencyMs.p50, UNKNOWN);
  assert.equal(result.summary.currentPath.inputTokens.p95, UNKNOWN);
  assert.equal(result.adoption.decision, "REJECT");
});

test("code_mode_only model fails closed because it cannot provide a direct-tool control", async () => {
  let executions = 0;
  const result = await runBenchmark({
    outPath: null,
    probe: async () => ({
      version: "codex-cli test",
      features: {
        code_mode: { stage: "stable", enabled: true },
        code_mode_host: { stage: "stable", enabled: true }
      },
      models: [{ slug: "test-model", toolMode: "code_mode_only" }]
    }),
    executeCase: async () => {
      executions++;
      return { latencyMs: 1, inputTokens: 1, correct: true };
    }
  });
  assert.equal(executions, 0);
  assert.equal(result.environment.stableCodeModeAvailable, false);
  assert.equal(result.protocol.status, "UNSUPPORTED_HOST");
  assert.match(result.protocol.unsupportedReasons.join("\n"), /code_mode_only/);
  assert.equal(result.summary.completedPairs, 0);
  assert.equal(result.adoption.decision, "REJECT");
});

test("externally claimed mode measurements are not accepted without host attestation", async () => {
  let executions = 0;
  const result = await runBenchmark({
    outPath: null,
    probe: async () => ({
      version: "codex-cli test",
      features: {
        code_mode: { stage: "stable", enabled: true },
        code_mode_host: { stage: "stable", enabled: true }
      },
      models: [{ slug: "test-model", toolMode: "code_mode" }]
    }),
    executeCase: async ({ mode }) => {
      executions++;
      return {
        latencyMs: mode === "codeMode" ? 1 : 100,
        inputTokens: 1,
        correct: true,
        provenance: { effectiveToolMode: "code_mode" }
      };
    }
  });
  assert.equal(executions, 0);
  assert.equal(result.protocol.status, "UNSUPPORTED_HOST");
  assert.equal(result.protocol.pairedCasesExecuted, 0);
  assert.deepEqual(result.pairs, []);
  assert.equal(result.summary.completedPairs, 0);
  assert.equal(result.adoption.decision, "REJECT");
  assert.match(result.protocol.modeIdentity.reason, /do not attest/);
});

test("stable switchable metadata still fails closed without effective-mode attestation", async () => {
  const calls = [];
  const result = await runBenchmark({
    outPath: null,
    probe: async () => ({
      version: "codex-cli test",
      features: {
        code_mode: { stage: "stable", enabled: true },
        code_mode_host: { stage: "stable", enabled: true }
      },
      models: [{ slug: "test-model", toolMode: "code_mode" }]
    }),
    executeCase: async ({ benchmarkCase, mode }) => {
      calls.push(`${benchmarkCase.id}:${mode}`);
      return {
        latencyMs: mode === "codeMode" ? 70 : 100,
        inputTokens: 100,
        correct: true,
        provenance: {
          sourceCommit: benchmarkCase.sourceCommit,
          eventStreamSha256: "test",
          effectiveToolMode: mode === "codeMode" ? "code_mode" : "direct_tools"
        }
      };
    }
  });
  assert.equal(calls.length, 0);
  assert.equal(result.environment.stableCodeModeAvailable, true);
  assert.equal(result.environment.comparisonAvailable, false);
  assert.equal(result.protocol.status, "UNSUPPORTED_HOST");
  assert.equal(result.pairs.length, 0);
  assert.equal(result.summary.completedPairs, 0);
  assert.equal(result.adoption.decision, "REJECT");
  assert.equal(result.protocol.modeIdentity.status, "UNAVAILABLE");
});

test("decision record retains fallback and excludes Code Mode from orchestration", () => {
  assert.match(decisionDoc, /REJECT production adoption/);
  assert.match(decisionDoc, /Retain Muster's current crew-member tool-call path/);
  assert.match(decisionDoc, /never become the wave-orchestration mechanism/);
  assert.match(decisionDoc, /at least 20% lower median latency/);
});
