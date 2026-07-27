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
  fingerprintCodexRoleProfile,
  planCodexFixContinuation,
  resolveCodexRoleProfile
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
      roleProfilePath: input.binding.roleProfilePath,
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
    cwd: "/w", baseSha: "a".repeat(40), codexVersion: "0.145.0", roleProfilePath: "/profiles/muster-builder.toml",
    roleProfile: {
      id: "muster-builder", model: "gpt-5.6-sol", reasoningEffort: "medium",
      sandboxMode: "workspace-write", developerInstructions: "Implement and verify."
    }
  };
  assert.throws(
    () => createCodexFixLoopBinding({ lane: "spawn_agent", workerId: "/root/w", ...common, cwd: "relative/worktree" }),
    /cwd must be an absolute normalized path/
  );
  assert.throws(() => createCodexFixLoopBinding({ lane: "spawn_agent", ...common }), /workerId/);
  assert.throws(() => createCodexFixLoopBinding({ lane: "exec-process", ...common }), /threadId/);
  const binding = createCodexFixLoopBinding({ lane: "spawn_agent", workerId: "/root/w", ...common });
  assert.throws(
    () => planCodexFixContinuation({
      binding: { ...binding, workerId: "" },
      current: common,
      reviewState: { sentBlockers: [], currentBlockers: ["new"] }
    }),
    /workerId is required/
  );
  assert.throws(
    () => planCodexFixContinuation({ binding, current: common, reviewState: { sentBlockers: ["old"], currentBlockers: ["old"] } }),
    /new blocker delta/
  );
});

test("authoritative role profile requires every execution-affecting field", () => {
  assert.throws(() => fingerprintCodexRoleProfile({ id: "muster-builder" }), /model is required/);
  const text = [
    'name = "muster-builder"',
    'model = "gpt-5.6-sol"',
    'model_reasoning_effort = "medium"',
    'sandbox_mode = "workspace-write"',
    'developer_instructions = "Implement and verify."'
  ].join("\n");
  assert.deepEqual(resolveCodexRoleProfile(text), {
    id: "muster-builder",
    model: "gpt-5.6-sol",
    reasoningEffort: "medium",
    sandboxMode: "workspace-write",
    developerInstructions: "Implement and verify."
  });
  assert.throws(
    () => resolveCodexRoleProfile(text.replace(/^sandbox_mode.*\n/m, "")),
    /sandbox_mode must be a generated TOML basic string/
  );
});

test("CLI persists a binding receipt and plans continuation from retained review state", () => {
  const input = fixture("spawn-agent.json");
  const temp = mkdtempSync(join(tmpdir(), "muster-fix-loop-"));
  const dispatch = join(temp, "dispatch.json");
  const receipt = join(temp, "receipt.json");
  const current = join(temp, "current.json");
  const review = join(temp, "review.json");
  const profile = join(temp, "muster-builder.toml");
  writeFileSync(profile, [
    'name = "muster-builder"',
    'model = "gpt-5.6-sol"',
    'model_reasoning_effort = "medium"',
    'sandbox_mode = "workspace-write"',
    'developer_instructions = "Implement the assigned slice and verify it."',
    ""
  ].join("\n"));
  const { roleProfile: _dispatchProfile, ...dispatchContext } = input.binding;
  const { roleProfile: _currentProfile, ...currentContext } = input.current;
  writeFileSync(dispatch, JSON.stringify({ ...dispatchContext, roleProfilePath: profile }));
  writeFileSync(current, JSON.stringify({ ...currentContext, roleProfilePath: profile }));
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
  assert.match(evidence.harness, /real Codex fresh-dispatch vs exact-thread-id resume/);
  assert.match(evidence.command, /benchmark-codex-fix-loop\.mjs/);
  assert.match(evidence.codexVersion, /^codex-cli /);
  assert.ok(evidence.cases.every(entry =>
    entry.fixtureSha256 &&
    entry.seed.threadId &&
    entry.fresh.type === "turn.completed" &&
    entry.continued.type === "turn.completed" &&
    entry.fresh.verification.passed &&
    entry.continued.verification.passed
  ));
  const result = benchmarkCodexFixLoops(evidence.cases);
  assert.equal(result.caseCount, 10);
  assert.ok(result.medianInputTokenReductionPct >= 25, JSON.stringify(result));
  assert.ok(result.medianTimeToFixReductionPct >= 20, JSON.stringify(result));
});
