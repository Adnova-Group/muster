import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
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
    if (plan.mechanism === "protected-wave-resume") assert.equal(plan.receiptRequired, true);
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
    cwd: "/w", baseSha: "a".repeat(40), codexVersion: "0.145.0", roleProfilePath: "/profiles/muster-runner.toml",
    roleProfile: {
      id: "muster-runner", model: "gpt-5.6-sol", reasoningEffort: "medium",
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
  assert.throws(() => fingerprintCodexRoleProfile({ id: "muster-runner" }), /model is required/);
  const text = [
    'name = "muster-runner"',
    'model = "gpt-5.6-sol"',
    'model_reasoning_effort = "medium"',
    'sandbox_mode = "workspace-write"',
    'developer_instructions = "Implement and verify."'
  ].join("\n");
  assert.deepEqual(resolveCodexRoleProfile(text), {
    id: "muster-runner",
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

test("10-case production benchmark clears the median uncached-input and time-to-fix bars", () => {
  const evidence = fixture("benchmark-evidence.json");
  assert.match(evidence.harness, /real Codex.*production runCodexWave.*runCodexWaveContinuation/);
  assert.match(evidence.command, /benchmark-codex-fix-loop\.mjs/);
  assert.match(evidence.codexVersion, /^codex-cli /);
  assert.match(evidence.productionPath.initial, /runCodexWave/);
  assert.match(evidence.productionPath.continued, /runCodexWaveContinuation/);
  assert.ok(evidence.cases.every(entry =>
    entry.fixtureSha256 &&
    entry.baseline?.fresh?.passed === true &&
    entry.baseline?.resumed?.passed === true &&
    entry.baseline.fresh.outputSha256 &&
    entry.baseline.resumed.outputSha256 &&
    entry.seed.receiptId &&
    entry.seed.threadIdSha256 === entry.continued.threadIdSha256 &&
    entry.seed.stdoutSha256 &&
    entry.fresh.stdoutSha256 &&
    entry.continued.stdoutSha256 &&
    entry.fresh.type === "turn.completed" &&
    entry.continued.type === "turn.completed" &&
    entry.fresh.verification.passed &&
    entry.continued.verification.passed
  ));
  const result = benchmarkCodexFixLoops(evidence.cases);
  assert.equal(result.caseCount, 10);
  assert.ok(result.medianUncachedInputTokenReductionPct >= 25, JSON.stringify(result));
  assert.ok(result.medianTotalInputTokenReductionPct > 0, JSON.stringify(result));
  assert.ok(result.medianTimeToFixReductionPct >= 20, JSON.stringify(result));
  assert.deepEqual(evidence.summary, result);
});

// Retirement fence (2026-08-04): each benchmark execution spawns ~20 live Codex sessions and
// burned real subscription quota when automation re-ran it against a HEAD-bound freshness rule.
// The adoption evidence above is banked; the script must refuse to run unless a human opts in
// explicitly for THIS benchmark via its per-gate environment variable.
test("benchmark script refuses to run without the explicit paid-benchmark opt-in", () => {
  const script = new URL("../scripts/benchmark-codex-fix-loop.mjs", import.meta.url).pathname;
  const { MUSTER_RUN_PAID_BENCHMARK: _drop, ...env } = process.env;
  const result = spawnSync(process.execPath, [script, "--output", "/nonexistent/never-written.json"], {
    encoding: "utf8", env,
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /MUSTER_RUN_PAID_BENCHMARK=codex-fix-loop/);
  assert.match(result.stderr, /live Codex sessions|paid/i);
  assert.doesNotMatch(result.stderr, /--output <path> is required/);
});
