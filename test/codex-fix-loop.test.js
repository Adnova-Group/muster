import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import assert from "node:assert/strict";
import { benchmarkCodexFixLoops } from "../src/codex-fix-loop.js";

const fixtureDir = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "codex-fix-loop");
const fixture = name => JSON.parse(readFileSync(join(fixtureDir, name), "utf8"));

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
