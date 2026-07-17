// Smoke test for eval/perf/replay-plan-budget.mjs (speed-tuning item, criteria 1 + 4). The
// script must run to completion and print its structured report. Deliberately does NOT pin
// the exact token/latency numbers here -- those depend on REAL file sizes and REAL CLI
// wall-clock timings measured at run time, which legitimately drift as plan.md and the CLI
// evolve; test/plan-token-budget.test.js already pins the ARITHMETIC itself with fixed
// inputs. This test only guards against the script crashing/import-erroring, and against
// silently dropping any of its required honesty disclosures.
//
// A MISS exit code (1) is a legitimate, expected, and documented outcome (report the real
// figure, even when it misses a target) -- this test accepts either exit code.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";

const pexecFile = promisify(execFile);
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = join(REPO_ROOT, "eval/perf/replay-plan-budget.mjs");

async function runScript() {
  try {
    const { stdout } = await pexecFile(process.execPath, [SCRIPT], { cwd: REPO_ROOT, timeout: 60_000 });
    return { stdout, code: 0 };
  } catch (err) {
    if (err.code === 1 && err.stdout) return { stdout: err.stdout, code: 1 };
    throw err;
  }
}

test("eval/perf/replay-plan-budget.mjs runs to completion and prints the structured report", async () => {
  const { stdout, code } = await runScript();
  assert.ok(code === 0 || code === 1, `expected exit 0 (PASS) or 1 (MISS), got ${code}`);
  assert.match(stdout, /Step 1 -- REAL command-prompt size/);
  assert.match(stdout, /Step 2 -- REAL CLI-call sequence/);
  assert.match(stdout, /Step 3 -- modeled constant/);
  assert.match(stdout, /Step 4 -- token \+ latency projection/);
  assert.match(stdout, /criterion 1 asks for <=15000 total tokens/);
  assert.match(stdout, /criterion 4 asks for <=60000ms wall-clock/);
  assert.match(stdout, /TOTAL tokens: \d+/);
  assert.match(stdout, /TOTAL plan-to-manifest wall-clock: [\d.]+ms/);
});

test("eval/perf/replay-plan-budget.mjs always states its honesty caveat (real vs modeled inputs)", async () => {
  const { stdout } = await runScript();
  assert.match(stdout, /Caveat \(honest method, not fabricated\)/);
  assert.match(stdout, /REAL measurements/);
  assert.match(stdout, /documented MODEL/);
});

test("eval/perf/replay-plan-budget.mjs measures every named CLI call in its own real sequence", async () => {
  const { stdout } = await runScript();
  for (const label of ["scope", "assess", "fast-path (score)", "detect", "capabilities --roles-only", "memory read", "manifest validate"]) {
    assert.ok(stdout.includes(label), `expected the "${label}" call to appear in the measured sequence`);
  }
});
