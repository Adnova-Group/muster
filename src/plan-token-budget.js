// speed-tuning item, criteria 1 + 4: bare `/muster:plan` token budget + plan-to-manifest
// wall-clock latency, for a fast-path-eligible 1-task outcome.
//
// Pure combining arithmetic only (mirrors src/token-projection.js's split: this module is
// asserted by a unit test with fixed inputs, the REAL fs.readFileSync + real CLI-call
// measurement lives in eval/perf/replay-plan-budget.mjs). What is REAL vs MODELED, and why:
//
//   - `commandPromptChars` -- REAL: plugin/commands/plan.md's own byte size, read off disk.
//     Loaded once when `/muster:plan` is invoked (the command's own system-style prompt).
//   - `cliOutputsChars` -- REAL: the actual stdout byte length of every `muster` CLI call
//     the fast-path-eligible flow makes (scope, assess, fast-path score, detect,
//     capabilities --roles-only, fast-path --capabilities, memory read, manifest validate),
//     executed by the eval script and measured, never hardcoded.
//   - `narrationTokensPerCall` -- MODELED: the model's own one-line "running X..." narration
//     between tool calls that this offline harness cannot observe (no live LLM session backs
//     it) -- a small, documented, clearly-labeled constant, the same "named projection, not
//     dressed up as a measurement" stance docs/performance-pass.md and
//     docs/weight-reduction.md already took for their own model-call estimates.
//
// No skill file is loaded at all on the fast-path-eligible branch (the router skill is
// skipped entirely, criterion 1's whole point) -- this module therefore takes no
// `skillChars` parameter; a caller wanting the NOT-eligible comparison figure (router/
// SKILL.md loaded once) computes that separately, the same way
// src/token-projection.js's before/after split works.
import { estimateTokens, DEFAULT_CHARS_PER_TOKEN } from "./token-projection.js";

function assertNonNegativeFinite(value, label, fnName) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error(`${fnName}: ${label} must be a non-negative finite number, got ${value}`);
  }
}

export function projectPlanTokenBudget({
  commandPromptChars = 0,
  cliOutputsChars = [],
  narrationTokensPerCall = 0,
  charsPerToken = DEFAULT_CHARS_PER_TOKEN,
} = {}) {
  assertNonNegativeFinite(commandPromptChars, "commandPromptChars", "projectPlanTokenBudget");
  if (!Array.isArray(cliOutputsChars)) throw new Error("projectPlanTokenBudget: cliOutputsChars must be an array");
  cliOutputsChars.forEach((c, i) => assertNonNegativeFinite(c, `cliOutputsChars[${i}]`, "projectPlanTokenBudget"));
  assertNonNegativeFinite(narrationTokensPerCall, "narrationTokensPerCall", "projectPlanTokenBudget");

  const commandPromptTokens = estimateTokens(commandPromptChars, charsPerToken);
  const cliOutputTokens = cliOutputsChars.reduce((sum, c) => sum + estimateTokens(c, charsPerToken), 0);
  const callCount = cliOutputsChars.length;
  const narrationTokens = narrationTokensPerCall * callCount;
  const totalTokens = commandPromptTokens + cliOutputTokens + narrationTokens;

  return { commandPromptTokens, cliOutputTokens, narrationTokens, callCount, totalTokens };
}

// Sums an array of REAL per-call wall-clock millisecond measurements (the eval script times
// each CLI invocation with process.hrtime.bigint()) into the total plan-to-manifest latency.
// Pure summation, kept here (not inlined in the eval script) so it is asserted by the same
// unit test as the token arithmetic above.
export function totalLatencyMs(callMs) {
  if (!Array.isArray(callMs)) throw new Error("totalLatencyMs: callMs must be an array");
  callMs.forEach((ms, i) => assertNonNegativeFinite(ms, `callMs[${i}]`, "totalLatencyMs"));
  return callMs.reduce((sum, ms) => sum + ms, 0);
}
