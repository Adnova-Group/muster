#!/usr/bin/env node
// speed-tuning item, criteria 1 + 4: bare `/muster:plan` token budget + plan-to-manifest
// wall-clock latency, on a fast-path-eligible 1-task outcome.
//
// Method (recorded honestly, per this item's brief pragmatics -- same discipline as
// eval/perf/replay-fast-path.mjs and eval/perf/replay-3task.mjs before it):
//   1. REAL, live measurement: plugin/commands/plan.md's own byte size (read off disk right
//      now), and the actual stdout byte length + actual wall-clock cost of every real `muster`
//      CLI call the fast-path-eligible flow makes, in order -- scope, assess, fast-path
//      (score), detect, capabilities --roles-only, fast-path --capabilities (build the
//      manifest), memory read, manifest validate. No skill file (router/SKILL.md) loads at
//      all on this branch -- the whole point of criterion 1's fast path.
//   2. MODELED, clearly-labeled constant: a small per-call "narration" token cost (the
//      model's own one-line status between tool calls) this offline harness cannot observe
//      (no live LLM session backs the token totals here) -- the same "named projection, not
//      dressed up as a measurement" stance the rest of this eval suite already takes.
//   3. src/plan-token-budget.js's projectPlanTokenBudget()/totalLatencyMs() combine both into
//      a token total and a wall-clock total, pinned by test/plan-token-budget.test.js with
//      fixed inputs so the arithmetic itself is asserted by the green suite.
//
// Usage: node eval/perf/replay-plan-budget.mjs
import { readFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { projectPlanTokenBudget, totalLatencyMs } from "../../src/plan-token-budget.js";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..");
const cli = join(repoRoot, "src", "cli.js");

const TARGET_TOKENS = 15_000; // criterion 1
const TARGET_LATENCY_MS = 60_000; // criterion 4
const NARRATION_TOKENS_PER_CALL = 40; // modeled: one status line between tool calls

const OUTCOME = "Fix the flaky login test";

const scratch = mkdtempSync(join(tmpdir(), "muster-plan-budget-"));
const memoryDir = join(scratch, "memory");
const capsFile = join(scratch, "capabilities.json");
const manifestFile = join(scratch, "manifest.json");

function timedCall(label, args) {
  const start = process.hrtime.bigint();
  const stdout = execFileSync(process.execPath, [cli, ...args], { cwd: repoRoot, encoding: "utf8" });
  const ms = Number(process.hrtime.bigint() - start) / 1e6;
  return { label, chars: stdout.length, ms, stdout };
}

console.log("speed-tuning replay: bare /muster:plan on a fast-path-eligible 1-task outcome\n");
console.log(`Outcome under test: "${OUTCOME}"\n`);

console.log("Step 1 -- REAL command-prompt size (this checkout, right now):");
const planMdChars = readFileSync(join(repoRoot, "plugin", "commands", "plan.md"), "utf8").length;
console.log(`  plugin/commands/plan.md: ${planMdChars} chars (loaded once when /muster:plan is invoked)`);

console.log("\nStep 2 -- REAL CLI-call sequence (fast-path-eligible branch only; router/SKILL.md never loads):");
const calls = [];
calls.push(timedCall("scope", ["scope", OUTCOME]));
calls.push(timedCall("assess", ["assess", OUTCOME]));
calls.push(timedCall("fast-path (score)", ["fast-path", OUTCOME]));
calls.push(timedCall("detect", ["detect", repoRoot]));
const capsResult = timedCall("capabilities --roles-only", ["capabilities", "--roles-only"]);
writeFileSync(capsFile, capsResult.stdout);
calls.push(capsResult);
const manifestResult = timedCall("fast-path --capabilities (build manifest)", ["fast-path", OUTCOME, "--capabilities", capsFile]);
calls.push(manifestResult);
const manifestObj = JSON.parse(manifestResult.stdout).manifest;
writeFileSync(manifestFile, JSON.stringify(manifestObj));
calls.push(timedCall("memory read", ["memory", "read", memoryDir, OUTCOME]));
calls.push(timedCall("manifest validate", ["manifest", "validate", manifestFile]));

for (const c of calls) console.log(`  ${c.label.padEnd(42)} ${String(c.chars).padStart(7)} chars  ${c.ms.toFixed(1).padStart(8)}ms`);

console.log("\nStep 3 -- modeled constant (documented, not measured):");
console.log(`  narration tokens per CLI call (a one-line status the model prints between calls): ${NARRATION_TOKENS_PER_CALL}`);

console.log("\nStep 4 -- token + latency projection (src/plan-token-budget.js):");
const budget = projectPlanTokenBudget({
  commandPromptChars: planMdChars,
  cliOutputsChars: calls.map((c) => c.chars),
  narrationTokensPerCall: NARRATION_TOKENS_PER_CALL,
});
const latencyMs = totalLatencyMs(calls.map((c) => c.ms));
console.log(`  command-prompt tokens: ${budget.commandPromptTokens.toFixed(0)}`);
console.log(`  CLI-output tokens (${budget.callCount} real calls): ${budget.cliOutputTokens.toFixed(0)}`);
console.log(`  modeled narration tokens: ${budget.narrationTokens.toFixed(0)}`);
console.log(`  TOTAL tokens: ${budget.totalTokens.toFixed(0)}`);
console.log(`  TOTAL plan-to-manifest wall-clock: ${latencyMs.toFixed(1)}ms`);

const tokensPass = budget.totalTokens <= TARGET_TOKENS;
const latencyPass = latencyMs <= TARGET_LATENCY_MS;
console.log(`\n  ${tokensPass ? "PASS" : "MISS"} -- criterion 1 asks for <=${TARGET_TOKENS} total tokens; measured ${budget.totalTokens.toFixed(0)}`);
console.log(`  ${latencyPass ? "PASS" : "MISS"} -- criterion 4 asks for <=${TARGET_LATENCY_MS}ms wall-clock; measured ${latencyMs.toFixed(1)}ms`);

console.log("\nCaveat (honest method, not fabricated): step 1's command-prompt size and step 2's CLI-call");
console.log("byte counts + wall-clock timings are REAL measurements of this checkout, taken right now (no");
console.log("skill file loads at all on this branch -- the router skill is skipped entirely, criterion 1's");
console.log("whole point). Step 3's narration-tokens-per-call constant is a documented MODEL -- no live LLM");
console.log("session backs the token totals above, so the model's own reasoning/narration tokens between");
console.log("tool calls cannot be measured in this offline harness. The wall-clock figure measures the");
console.log("deterministic CLI-call portion of the cycle only, not the model's own turn latency between");
console.log("calls -- a real invocation's wall-clock includes both.");

rmSync(scratch, { recursive: true, force: true });
process.exit(tokensPass && latencyPass ? 0 : 1);
