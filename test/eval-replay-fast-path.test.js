// Smoke test for eval/perf/replay-fast-path.mjs (weight-reduction item, criterion 3): the
// script must run to completion and print its structured report. Deliberately does NOT
// pin the exact token/percentage numbers here -- those live off REAL file sizes read at
// run time (plugin/skills/router/SKILL.md, review-gate/SKILL.md), which legitimately
// drift as those docs evolve; test/token-projection.test.js already pins the ARITHMETIC
// itself with fixed inputs. This test only guards against the script crashing/import-
// erroring, and against silently dropping any of its required honesty disclosures.
//
// A MISS exit code (1) is a legitimate, expected, and documented outcome (the item's own
// brief: report the real figure, even when it misses the 25% target) -- this test accepts
// either exit code, it does not require a PASS.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";

const pexecFile = promisify(execFile);
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = join(REPO_ROOT, "eval/perf/replay-fast-path.mjs");

async function runScript() {
  try {
    const { stdout } = await pexecFile(process.execPath, [SCRIPT], { cwd: REPO_ROOT });
    return { stdout, code: 0 };
  } catch (err) {
    // A MISS exit(1) is expected/legitimate -- surface stdout either way, only rethrow an
    // actual crash (no stdout at all, or a non-1 exit code).
    if (err.code === 1 && err.stdout) return { stdout: err.stdout, code: 1 };
    throw err;
  }
}

test("eval/perf/replay-fast-path.mjs runs to completion and prints the structured report", async () => {
  const { stdout, code } = await runScript();
  assert.ok(code === 0 || code === 1, `expected exit 0 (PASS) or 1 (MISS), got ${code}`);
  assert.match(stdout, /Step 1 -- REAL file-size measurement/);
  assert.match(stdout, /Step 2 -- grounded reviewer counts/);
  assert.match(stdout, /Step 3 -- modeled constants/);
  assert.match(stdout, /Step 4 -- before\/after projection/);
  assert.match(stdout, /criterion 3 asks for fast-path consumption/);
  assert.match(stdout, /reduction: -?\d+ tokens \([\d.]+% reduction/);
});

test("eval/perf/replay-fast-path.mjs always states its honesty caveat (real vs modeled inputs)", async () => {
  const { stdout } = await runScript();
  assert.match(stdout, /Caveat \(honest method, not fabricated\)/);
  assert.match(stdout, /REAL measurement/);
  assert.match(stdout, /documented MODELS/);
});

test("eval/perf/replay-fast-path.mjs prints the honest gap note when it misses the target", async () => {
  const { stdout, code } = await runScript();
  if (code === 1) {
    assert.match(stdout, /Honest gap note/);
    assert.match(stdout, /MISS --/);
  } else {
    assert.match(stdout, /PASS --/);
  }
});

// fast-path-token-gap item: both levers (lighter reviewer brief, cheaper reasoning tier) are
// documented and reflected in the printed report -- and, whatever the exact consumption %
// this checkout's real file sizes produce, it must be a REAL improvement over
// docs/speed-tuning.md's own prior 41.2% measurement (not pinned exactly, since it legitimately
// drifts with either SKILL.md's prose; test/token-projection.test.js pins the arithmetic).
test("eval/perf/replay-fast-path.mjs documents both fast-path-token-gap levers and measures a real improvement over the prior 41.2%", async () => {
  const { stdout } = await runScript();
  assert.match(stdout, /fast-path-brief\.md/, "must measure the lever-1 lighter-brief file's real size");
  assert.match(stdout, /reviewerReasoningForCount/, "must ground the lever-2 reasoning tier in src/gate-cadence.js");
  assert.match(stdout, /"medium" after/, "the after side must request the cheaper reasoning tier");
  const m = stdout.match(/fast path consumes ([\d.]+)% of full-pipeline tokens/);
  assert.ok(m, "must print the measured consumption percentage");
  assert.ok(Number(m[1]) < 41.2, `expected a real improvement over the prior 41.2% measurement, got ${m[1]}%`);
});
