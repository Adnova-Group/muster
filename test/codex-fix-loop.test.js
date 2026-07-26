import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  benchmarkCodexFixLoops,
  createCodexFixLoopBinding,
  planCodexFixContinuation
} from "../src/codex-fix-loop.js";

const fixtureDir = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "codex-fix-loop");
const fixture = name => JSON.parse(readFileSync(join(fixtureDir, name), "utf8"));

for (const name of ["spawn-agent.json", "exec-process.json"]) {
  test(`state-isolation fixture: ${name}`, () => {
    const input = fixture(name);
    const binding = createCodexFixLoopBinding(input.binding);
    const plan = planCodexFixContinuation({ binding, current: input.current, blockers: input.blockers });
    assert.equal(plan.mechanism, input.expectedMechanism);
    assert.equal(plan.target, input.expectedTarget);
    assert.deepEqual(plan.blockers, input.blockers);
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
      () => planCodexFixContinuation({ binding, current, blockers: input.blockers }),
      new RegExp(`${mismatch.field} mismatch`)
    );
  }
});

test("continuation requires blocker deltas and exact retained identity", () => {
  const common = {
    cwd: "/w", baseSha: "a".repeat(40), codexVersion: "0.145.0", roleProfile: "muster-builder"
  };
  assert.throws(() => createCodexFixLoopBinding({ lane: "spawn_agent", ...common }), /workerId/);
  assert.throws(() => createCodexFixLoopBinding({ lane: "exec-process", ...common }), /threadId/);
  const binding = createCodexFixLoopBinding({ lane: "spawn_agent", workerId: "/root/w", ...common });
  assert.throws(() => planCodexFixContinuation({ binding, current: common, blockers: [] }), /blocker delta/);
});

test("10-case benchmark clears the median token and time-to-fix bars", () => {
  const result = benchmarkCodexFixLoops(fixture("benchmark.json"));
  assert.equal(result.caseCount, 10);
  assert.ok(result.medianInputTokenReductionPct >= 25, JSON.stringify(result));
  assert.ok(result.medianTimeToFixReductionPct >= 20, JSON.stringify(result));
});
