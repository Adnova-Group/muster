import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  benchmarkCodexFixLoops,
  createCodexFixLoopBinding,
  planCodexFixContinuation
} from "../src/codex-fix-loop.js";
import { repoRoot, selectedPluginRoot } from "../test-support/codex-helpers.js";

const fixtureDir = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "codex-fix-loop");
const fixture = name => JSON.parse(readFileSync(join(fixtureDir, name), "utf8"));

for (const name of ["spawn-agent.json", "exec-process.json"]) {
  test(`state-isolation fixture: ${name}`, () => {
    const input = fixture(name);
    const binding = createCodexFixLoopBinding(input.binding);
    const plan = planCodexFixContinuation({ binding, current: input.current, reviewState: input.reviewState });
    assert.equal(plan.mechanism, input.expectedMechanism);
    assert.equal(plan.target, input.expectedTarget);
    assert.deepEqual(plan.blockers, input.reviewState.currentBlockers);
    assert.doesNotMatch(JSON.stringify(plan), /resume --last|--last/);
    assert.doesNotMatch(plan.message, /Crew Manifest|prior transcript|success criteria/i);
  });
}

test("state-isolation fixture: isolation-mismatches.json", () => {
  const input = fixture("isolation-mismatches.json");
  const binding = createCodexFixLoopBinding(input.binding);
  for (const mismatch of input.mismatches) {
    const current = {
      cwd: input.binding.cwd,
      baseSha: input.binding.baseSha,
      codexVersion: input.binding.codexVersion,
      roleProfile: input.binding.roleProfile,
      [mismatch.field]: mismatch.value
    };
    assert.throws(
      () => planCodexFixContinuation({ binding, current, reviewState: input.reviewState }),
      new RegExp(`${mismatch.field} mismatch`)
    );
  }
});

test("continuation requires blocker deltas and exact retained identity", () => {
  const common = {
    cwd: "/w", baseSha: "a".repeat(40), codexVersion: "0.145.0",
    roleProfile: { id: "muster-builder", model: "gpt-5.6-sol", reasoning: "medium", sandbox: "workspace-write" }
  };
  assert.throws(() => createCodexFixLoopBinding({ lane: "spawn_agent", ...common }), /workerId/);
  assert.throws(() => createCodexFixLoopBinding({ lane: "exec-process", ...common }), /threadId/);
  const binding = createCodexFixLoopBinding({ lane: "spawn_agent", workerId: "/root/w", ...common });
  assert.throws(
    () => planCodexFixContinuation({ binding, current: common, reviewState: { sentBlockers: ["old"], currentBlockers: ["old"] } }),
    /new blocker delta/
  );
});

test("CLI persists a binding receipt and plans continuation from retained review state", () => {
  const input = fixture("spawn-agent.json");
  const temp = mkdtempSync(join(tmpdir(), "muster-fix-loop-"));
  const dispatch = join(temp, "dispatch.json");
  const receipt = join(temp, "receipt.json");
  const current = join(temp, "current.json");
  const review = join(temp, "review.json");
  writeFileSync(dispatch, JSON.stringify(input.binding));
  writeFileSync(current, JSON.stringify(input.current));
  writeFileSync(review, JSON.stringify(input.reviewState));
  const bundledCli = join(selectedPluginRoot, "runtime", "muster.mjs");
  execFileSync(process.execPath, [bundledCli, "fix-loop-bind", dispatch, receipt], { cwd: repoRoot });
  const result = JSON.parse(execFileSync(
    process.execPath,
    [bundledCli, "fix-loop-continue", receipt, current, review],
    { cwd: repoRoot, encoding: "utf8" }
  ));
  assert.equal(result.mechanism, "followup_task");
  assert.equal(result.target, input.expectedTarget);
});

test("10-case benchmark clears the median token and time-to-fix bars", () => {
  const evidence = fixture("benchmark-evidence.json");
  assert.match(evidence.harness, /fresh-dispatch vs retained-thread/);
  assert.match(evidence.command, /benchmark-codex-fix-loop\.mjs/);
  assert.ok(evidence.cases.every(entry => entry.payloadSha256 && entry.fresh.type === "turn.completed"));
  const result = benchmarkCodexFixLoops(evidence.cases);
  assert.equal(result.caseCount, 10);
  assert.ok(result.medianInputTokenReductionPct >= 25, JSON.stringify(result));
  assert.ok(result.medianTimeToFixReductionPct >= 20, JSON.stringify(result));
});
