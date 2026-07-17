/**
 * CLI wire-format tests for the performance-pass additions: `resolve-cli` and
 * `gate-cadence`. Same spawn-the-real-binary pattern as test/cli-wire.test.js.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";
import { mkdtemp, writeFile, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";

const pexecFile = promisify(execFile);

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..");
const CLI = join(REPO_ROOT, "src/cli.js");

function run(args, opts = {}) {
  return pexecFile(process.execPath, [CLI, ...args], { cwd: REPO_ROOT, ...opts });
}

// ---------------------------------------------------------------------------
// resolve-cli
// ---------------------------------------------------------------------------

test("cli wire: resolve-cli exits 0 and returns the resolution decision as JSON", async () => {
  const { stdout } = await run(["resolve-cli"]);
  const parsed = JSON.parse(stdout);
  assert.ok("command" in parsed, "missing 'command' key");
  assert.ok("args" in parsed, "missing 'args' key");
  assert.ok(Array.isArray(parsed.args), "'args' must be an array");
  assert.ok("source" in parsed, "missing 'source' key");
  assert.ok("degraded" in parsed, "missing 'degraded' key");
  assert.equal(typeof parsed.degraded, "boolean");
});

test("cli wire: resolve-cli run from this repo's own checkout resolves to local-checkout", async () => {
  // REPO_ROOT has both src/cli.js and src/cli-resolve.js, and CLAUDE_PLUGIN_ROOT is
  // unset in this spawn's env, so the local-checkout tier must win.
  const env = { ...process.env };
  delete env.CLAUDE_PLUGIN_ROOT;
  const { stdout } = await run(["resolve-cli"], { env });
  const parsed = JSON.parse(stdout);
  assert.equal(parsed.source, "local-checkout");
  assert.equal(parsed.degraded, false);
});

test("cli wire: resolve-cli prefers a vendored plugin runtime when CLAUDE_PLUGIN_ROOT points at one", async (t) => {
  const tmp = await mkdtemp(join(tmpdir(), "muster-resolve-cli-"));
  t.after(() => rm(tmp, { recursive: true, force: true }));
  const runtimeDir = join(tmp, "runtime");
  await mkdir(runtimeDir, { recursive: true });
  await writeFile(join(runtimeDir, "muster.mjs"), "// fake vendored bundle\n");

  const env = { ...process.env, CLAUDE_PLUGIN_ROOT: tmp };
  const { stdout } = await run(["resolve-cli"], { env, cwd: tmp });
  const parsed = JSON.parse(stdout);
  assert.equal(parsed.source, "vendored-plugin");
  assert.equal(parsed.command, "node");
  assert.deepEqual(parsed.args, [join(runtimeDir, "muster.mjs")]);
});

// ---------------------------------------------------------------------------
// gate-cadence
// ---------------------------------------------------------------------------

test("cli wire: gate-cadence exits 1 with a usage message when the file arg is missing", async () => {
  try {
    await run(["gate-cadence"]);
    assert.fail("should have exited non-zero");
  } catch (err) {
    assert.equal(err.code, 1);
    assert.match(err.stderr, /gate-cadence <manifest\.json>/);
  }
});

test("cli wire: gate-cadence on the diamond fixture (4 tasks, 3 waves) is above the fast-path threshold", async () => {
  const fixture = join(REPO_ROOT, "test/fixtures/plan.diamond.json");
  const { stdout } = await run(["gate-cadence", fixture]);
  const parsed = JSON.parse(stdout);
  assert.equal(parsed.taskCount, 4);
  assert.equal(parsed.waveCount, 3);
  assert.equal(parsed.specGateRounds, 1);
  assert.equal(parsed.reviewGateBatches, 3);
  assert.equal(parsed.fastPath, false);
});

test("cli wire: gate-cadence on a 3-task manifest qualifies for the fast path (batched review, <=1 spec-gate round)", async (t) => {
  const tmp = await mkdtemp(join(tmpdir(), "muster-gate-cadence-"));
  t.after(() => rm(tmp, { recursive: true, force: true }));
  const fixture = join(tmp, "manifest.3task.json");
  await writeFile(fixture, JSON.stringify({
    plan: [
      { id: "t1", task: "one", mode: "single", deps: [] },
      { id: "t2", task: "two", mode: "single", deps: ["t1"] },
      { id: "t3", task: "three", mode: "single", deps: ["t2"] },
    ],
  }));
  const { stdout } = await run(["gate-cadence", fixture]);
  const parsed = JSON.parse(stdout);
  assert.equal(parsed.taskCount, 3);
  assert.ok(parsed.specGateRounds <= 1);
  assert.equal(parsed.reviewGateBatches, 1);
  assert.equal(parsed.fastPath, true);
});

test("cli wire: gate-cadence on a manifest with no 'plan' array exits 1", async (t) => {
  const tmp = await mkdtemp(join(tmpdir(), "muster-gate-cadence-"));
  t.after(() => rm(tmp, { recursive: true, force: true }));
  const fixture = join(tmp, "manifest.noplan.json");
  await writeFile(fixture, JSON.stringify({ outcome: "x" }));
  try {
    await run(["gate-cadence", fixture]);
    assert.fail("should have exited non-zero");
  } catch (err) {
    assert.equal(err.code, 1);
    assert.match(err.stderr, /no 'plan' array/);
  }
});
