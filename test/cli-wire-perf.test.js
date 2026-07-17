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

// weight-reduction item, criterion 2: --changed-lines folds reviewerCount into the same
// gate-cadence result, scaled by diff size independently of taskCount.

test("cli wire: gate-cadence without --changed-lines omits reviewerCount (backward compatible)", async () => {
  const fixture = join(REPO_ROOT, "test/fixtures/plan.diamond.json");
  const { stdout } = await run(["gate-cadence", fixture]);
  const parsed = JSON.parse(stdout);
  assert.equal("reviewerCount" in parsed, false);
  assert.equal("reviewerReasoning" in parsed, false);
});

test("cli wire: gate-cadence --changed-lines under the default 200-line threshold folds reviewerCount:1 and reviewerReasoning:medium in (fast-path-token-gap lever 2)", async () => {
  const fixture = join(REPO_ROOT, "test/fixtures/plan.diamond.json");
  const { stdout } = await run(["gate-cadence", fixture, "--changed-lines", "50"]);
  const parsed = JSON.parse(stdout);
  assert.equal(parsed.reviewerCount, 1);
  assert.equal(parsed.reviewerReasoning, "medium");
});

test("cli wire: gate-cadence --changed-lines at/over the default threshold folds reviewerCount:2 and reviewerReasoning:high in (unchanged default)", async () => {
  const fixture = join(REPO_ROOT, "test/fixtures/plan.diamond.json");
  const { stdout } = await run(["gate-cadence", fixture, "--changed-lines", "200"]);
  const parsed = JSON.parse(stdout);
  assert.equal(parsed.reviewerCount, 2);
  assert.equal(parsed.reviewerReasoning, "high");
});

test("cli wire: gate-cadence honors MUSTER_REVIEW_DIFF_THRESHOLD to override the default", async () => {
  const fixture = join(REPO_ROOT, "test/fixtures/plan.diamond.json");
  const env = { ...process.env, MUSTER_REVIEW_DIFF_THRESHOLD: "40" };
  const { stdout } = await run(["gate-cadence", fixture, "--changed-lines", "50"], { env });
  const parsed = JSON.parse(stdout);
  assert.equal(parsed.reviewerCount, 2, "50 lines clears the overridden 40-line threshold");
});

test("cli wire: gate-cadence --changed-lines rejects a negative/non-numeric value", async (t) => {
  const fixture = join(REPO_ROOT, "test/fixtures/plan.diamond.json");
  try {
    await run(["gate-cadence", fixture, "--changed-lines", "-5"]);
    assert.fail("should have exited non-zero");
  } catch (err) {
    assert.equal(err.code, 1);
    assert.match(err.stderr, /--changed-lines must be a non-negative finite number/);
  }
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

// ---------------------------------------------------------------------------
// review-brief (fast-path-token-gap item, lever 1): a code-backed CLI wrapper over
// src/review-brief.js's lightBriefEligible/detectReviewTriggers, the SAME "code over model"
// decision pattern gate-cadence/citation-check/fast-path already established for a
// diff-content decision -- review-gate/SKILL.md's step invokes this instead of leaving the
// eligibility check to unenforced prose discipline.
// ---------------------------------------------------------------------------

test("cli wire: review-brief --reviewer-count is required", async (t) => {
  try {
    await run(["review-brief"]);
    assert.fail("should have exited non-zero");
  } catch (err) {
    assert.equal(err.code, 1);
    assert.match(err.stderr, /--reviewer-count/);
  }
});

test("cli wire: review-brief --reviewer-count rejects a negative/non-numeric value", async (t) => {
  try {
    await run(["review-brief", "--reviewer-count", "nope"]);
    assert.fail("should have exited non-zero");
  } catch (err) {
    assert.equal(err.code, 1);
    assert.match(err.stderr, /--reviewer-count must be a non-negative finite number/);
  }
});

test("cli wire: review-brief with no --diff-files and reviewerCount:1 is eligible (no triggers possible on an empty diff)", async () => {
  const { stdout } = await run(["review-brief", "--reviewer-count", "1"]);
  const parsed = JSON.parse(stdout);
  assert.equal(parsed.eligible, true);
  assert.deepEqual(parsed.triggers, { mutantKill: false, citation: false, surface: false, any: false });
});

test("cli wire: review-brief --reviewer-count 2 is never eligible, regardless of diff content", async (t) => {
  const tmp = await mkdtemp(join(tmpdir(), "muster-review-brief-"));
  t.after(() => rm(tmp, { recursive: true, force: true }));
  const diffFiles = join(tmp, "diff-files.txt");
  await writeFile(diffFiles, "src/keyword.js\nsrc/scope.js\n");
  const { stdout } = await run(["review-brief", "--reviewer-count", "2", "--diff-files", diffFiles]);
  const parsed = JSON.parse(stdout);
  assert.equal(parsed.eligible, false);
});

test("cli wire: review-brief --diff-files reads one path per line and reports the mutant-kill trigger for a touched test file", async (t) => {
  const tmp = await mkdtemp(join(tmpdir(), "muster-review-brief-"));
  t.after(() => rm(tmp, { recursive: true, force: true }));
  const diffFiles = join(tmp, "diff-files.txt");
  await writeFile(diffFiles, "src/keyword.js\ntest/keyword.test.js\n");
  const { stdout } = await run(["review-brief", "--reviewer-count", "1", "--diff-files", diffFiles]);
  const parsed = JSON.parse(stdout);
  assert.equal(parsed.eligible, false);
  assert.equal(parsed.triggers.mutantKill, true);
});

test("cli wire: review-brief --diff-text-file carries the citation-in-text signal even with no .md path", async (t) => {
  const tmp = await mkdtemp(join(tmpdir(), "muster-review-brief-"));
  t.after(() => rm(tmp, { recursive: true, force: true }));
  const diffFiles = join(tmp, "diff-files.txt");
  const diffTextFile = join(tmp, "diff-text.txt");
  await writeFile(diffFiles, "src/keyword.js\n");
  await writeFile(diffTextFile, "+some text [src: anchor-1] more text\n");
  const { stdout } = await run(["review-brief", "--reviewer-count", "1", "--diff-files", diffFiles, "--diff-text-file", diffTextFile]);
  const parsed = JSON.parse(stdout);
  assert.equal(parsed.eligible, false);
  assert.equal(parsed.triggers.citation, true);
});

// ---------------------------------------------------------------------------
// fast-path (weight-reduction item, criterion 1: single-agent fast path)
// ---------------------------------------------------------------------------

test("cli wire: fast-path exits 1 with a usage message when the outcome arg is missing", async () => {
  try {
    await run(["fast-path"]);
    assert.fail("should have exited non-zero");
  } catch (err) {
    assert.equal(err.code, 1);
    assert.match(err.stderr, /fast-path <outcome>/);
  }
});

test("cli wire: fast-path on a trivial outcome (no --capabilities) returns just the score", async () => {
  const { stdout } = await run(["fast-path", "Fix the flaky login test"]);
  const parsed = JSON.parse(stdout);
  assert.equal(parsed.eligible, true);
  assert.equal("manifest" in parsed, false, "no --capabilities given, so no manifest is emitted");
});

test("cli wire: fast-path on a cross-cutting/multi-task outcome scores NOT eligible", async () => {
  const { stdout } = await run(["fast-path", "Migrate every service across the monorepo to the new logger"]);
  const parsed = JSON.parse(stdout);
  assert.equal(parsed.eligible, false);
});

test("cli wire: fast-path --capabilities <file> on an eligible outcome emits the minimal manifest, which validates", async (t) => {
  const tmp = await mkdtemp(join(tmpdir(), "muster-fast-path-"));
  t.after(() => rm(tmp, { recursive: true, force: true }));
  const capsFile = join(tmp, "capabilities.json");
  await writeFile(capsFile, JSON.stringify({
    roles: {
      implement: { chosen: { id: "muster-builder", source: "builtin", kind: "agent" }, chain: [{ id: "inline", source: "inline", kind: "inline" }], recommendations: [], model: "sonnet" },
      "code-review": { chosen: { id: "muster-reviewer", source: "builtin", kind: "agent" }, chain: [{ id: "inline", source: "inline", kind: "inline" }], recommendations: [], model: "sonnet" },
    },
  }));
  const { stdout } = await run(["fast-path", "Fix the flaky login test", "--capabilities", capsFile]);
  const parsed = JSON.parse(stdout);
  assert.equal(parsed.eligible, true);
  assert.ok(parsed.manifest, "manifest must be emitted when --capabilities is given and eligible");
  assert.equal(parsed.manifest.crew.length, 2);
  assert.equal(parsed.manifest.plan.length, 1);
});

test("cli wire: fast-path --capabilities <file> on a NOT-eligible outcome does not emit a manifest", async (t) => {
  const tmp = await mkdtemp(join(tmpdir(), "muster-fast-path-"));
  t.after(() => rm(tmp, { recursive: true, force: true }));
  const capsFile = join(tmp, "capabilities.json");
  await writeFile(capsFile, JSON.stringify({
    roles: {
      implement: { chosen: { id: "muster-builder", source: "builtin", kind: "agent" }, chain: [{ id: "inline", source: "inline", kind: "inline" }], recommendations: [], model: "sonnet" },
      "code-review": { chosen: { id: "muster-reviewer", source: "builtin", kind: "agent" }, chain: [{ id: "inline", source: "inline", kind: "inline" }], recommendations: [], model: "sonnet" },
    },
  }));
  const { stdout } = await run(["fast-path", "Migrate every service across the monorepo to the new logger", "--capabilities", capsFile]);
  const parsed = JSON.parse(stdout);
  assert.equal(parsed.eligible, false);
  assert.equal("manifest" in parsed, false);
});
