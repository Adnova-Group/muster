import { test } from "node:test";
import assert from "node:assert/strict";
import { projectPlanTokenBudget, totalLatencyMs } from "../src/plan-token-budget.js";

// speed-tuning item, criteria 1 + 4. Pure arithmetic only -- the REAL fs.readFileSync +
// real CLI-call measurement lives in eval/perf/replay-plan-budget.mjs; this module is the
// deterministic combining function, pinned by fixed inputs so the reported total is
// asserted by the green suite, not just narrated in a doc (same discipline as
// src/token-projection.js/test/token-projection.test.js).

test("projectPlanTokenBudget: sums the command prompt, every CLI call's output, and modeled narration", () => {
  const r = projectPlanTokenBudget({
    commandPromptChars: 400, // 100 tokens
    cliOutputsChars: [40, 80, 120], // 10 + 20 + 30 = 60 tokens
    narrationTokensPerCall: 5, // 3 calls * 5 = 15 tokens
  });
  assert.equal(r.commandPromptTokens, 100);
  assert.equal(r.cliOutputTokens, 60);
  assert.equal(r.callCount, 3);
  assert.equal(r.narrationTokens, 15);
  assert.equal(r.totalTokens, 175);
});

test("projectPlanTokenBudget: defaults to zero for every field when called with no args", () => {
  const r = projectPlanTokenBudget();
  assert.deepEqual(r, { commandPromptTokens: 0, cliOutputTokens: 0, narrationTokens: 0, callCount: 0, totalTokens: 0 });
});

test("projectPlanTokenBudget: charsPerToken is overridable and applies to both the prompt and CLI outputs", () => {
  const r = projectPlanTokenBudget({ commandPromptChars: 800, cliOutputsChars: [800], charsPerToken: 8 });
  assert.equal(r.commandPromptTokens, 100);
  assert.equal(r.cliOutputTokens, 100);
});

test("projectPlanTokenBudget: rejects a negative/non-finite commandPromptChars or narrationTokensPerCall", () => {
  assert.throws(() => projectPlanTokenBudget({ commandPromptChars: -1 }), /commandPromptChars must be a non-negative finite number/i);
  assert.throws(() => projectPlanTokenBudget({ narrationTokensPerCall: NaN }), /narrationTokensPerCall must be a non-negative finite number/i);
});

test("projectPlanTokenBudget: rejects a non-array cliOutputsChars or a negative entry inside it", () => {
  assert.throws(() => projectPlanTokenBudget({ cliOutputsChars: "nope" }), /cliOutputsChars must be an array/i);
  assert.throws(() => projectPlanTokenBudget({ cliOutputsChars: [10, -1] }), /cliOutputsChars\[1\] must be a non-negative finite number/i);
});

test("totalLatencyMs: sums an array of real per-call millisecond measurements", () => {
  assert.equal(totalLatencyMs([12.5, 30, 7.5]), 50);
  assert.equal(totalLatencyMs([]), 0);
});

test("totalLatencyMs: rejects a non-array input or a negative/non-finite entry", () => {
  assert.throws(() => totalLatencyMs("nope"), /callMs must be an array/i);
  assert.throws(() => totalLatencyMs([10, -1]), /callMs\[1\] must be a non-negative finite number/i);
});
