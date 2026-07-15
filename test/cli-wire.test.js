/**
 * CLI wire-format integration tests.
 *
 * These tests spawn `node src/cli.js <cmd>` via execFile and assert the exact
 * JSON shapes that SKILL.md prose and skill logic depend on.  They pin the
 * wire contract so a refactor that silently renames a key is caught before a
 * skill breaks at runtime.
 *
 * Each test uses the repo root as cwd (which has package.json + .git) except
 * where a specific fixture path is passed as a CLI argument.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";

const pexecFile = promisify(execFile);

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..");
const CLI = join(REPO_ROOT, "src/cli.js");

function run(args, cwd = REPO_ROOT) {
  return pexecFile(process.execPath, [CLI, ...args], { cwd });
}

// ---------------------------------------------------------------------------
// detect
// ---------------------------------------------------------------------------

test("cli wire: detect exits 0 and returns valid JSON", async () => {
  const { stdout } = await run(["detect", REPO_ROOT]);
  const parsed = JSON.parse(stdout);
  // Must be parseable — JSON.parse throws on invalid input
  assert.ok(typeof parsed === "object" && parsed !== null);
});

test("cli wire: detect result has required greenfield, languages, vcs keys", async () => {
  const { stdout } = await run(["detect", REPO_ROOT]);
  const parsed = JSON.parse(stdout);

  // greenfield — boolean
  assert.ok("greenfield" in parsed, "missing 'greenfield' key");
  assert.equal(typeof parsed.greenfield, "boolean");

  // languages — array
  assert.ok("languages" in parsed, "missing 'languages' key");
  assert.ok(Array.isArray(parsed.languages), "'languages' must be an array");

  // vcs — object with isRepo, branch, dirty, hasRemote
  assert.ok("vcs" in parsed, "missing 'vcs' key");
  const { vcs } = parsed;
  assert.equal(typeof vcs, "object");
  assert.ok("isRepo" in vcs, "vcs missing 'isRepo'");
  assert.ok("dirty" in vcs, "vcs missing 'dirty'");
  assert.ok("hasRemote" in vcs, "vcs missing 'hasRemote'");
  assert.ok("branch" in vcs, "vcs missing 'branch'");
});

test("cli wire: detect on repo root reports isRepo=true and javascript language", async () => {
  const { stdout } = await run(["detect", REPO_ROOT]);
  const parsed = JSON.parse(stdout);
  assert.equal(parsed.vcs.isRepo, true);
  assert.ok(parsed.languages.includes("javascript"), "repo root should detect javascript");
});

// ---------------------------------------------------------------------------
// assess
// ---------------------------------------------------------------------------

test("cli wire: assess exits 0 and returns valid JSON", async () => {
  const { stdout } = await run(["assess", "vague"]);
  JSON.parse(stdout); // must not throw
});

test("cli wire: assess result has clear (boolean) and signals (array) keys", async () => {
  const { stdout } = await run(["assess", "vague"]);
  const parsed = JSON.parse(stdout);

  assert.ok("clear" in parsed, "missing 'clear' key");
  assert.equal(typeof parsed.clear, "boolean");

  assert.ok("signals" in parsed, "missing 'signals' key");
  assert.ok(Array.isArray(parsed.signals), "'signals' must be an array");
});

test("cli wire: assess 'vague' flags clear=false with non-empty signals", async () => {
  const { stdout } = await run(["assess", "vague"]);
  const parsed = JSON.parse(stdout);
  assert.equal(parsed.clear, false);
  assert.ok(parsed.signals.length > 0, "vague outcome should produce at least one signal");
});

test("cli wire: assess exits non-zero when outcome argument is missing", async () => {
  try {
    await run(["assess"]);
    assert.fail("should have exited non-zero");
  } catch (err) {
    assert.ok(err.code !== 0, "exit code must be non-zero when outcome is missing");
  }
});

// ---------------------------------------------------------------------------
// capabilities
// ---------------------------------------------------------------------------

test("cli wire: capabilities exits 0 and returns valid JSON", async () => {
  const { stdout } = await run(["capabilities"]);
  JSON.parse(stdout); // must not throw
});

test("cli wire: capabilities result has a 'roles' object", async () => {
  const { stdout } = await run(["capabilities"]);
  const parsed = JSON.parse(stdout);
  assert.ok("roles" in parsed, "missing top-level 'roles' key");
  assert.equal(typeof parsed.roles, "object");
  assert.ok(!Array.isArray(parsed.roles), "'roles' must be an object, not an array");
});

test("cli wire: every role entry carries 'chosen' and 'model' keys", async () => {
  const { stdout } = await run(["capabilities"]);
  const { roles } = JSON.parse(stdout);

  const entries = Object.entries(roles);
  assert.ok(entries.length > 0, "roles object must not be empty");

  for (const [roleName, roleVal] of entries) {
    assert.ok("chosen" in roleVal, `role '${roleName}' missing 'chosen'`);
    assert.ok("model" in roleVal, `role '${roleName}' missing 'model'`);
    // chosen must have id, source, kind
    assert.ok("id" in roleVal.chosen, `role '${roleName}'.chosen missing 'id'`);
    assert.ok("source" in roleVal.chosen, `role '${roleName}'.chosen missing 'source'`);
    assert.ok("kind" in roleVal.chosen, `role '${roleName}'.chosen missing 'kind'`);
  }
});

test("cli wire: capabilities --role returns one compact role without the skill inventory", async () => {
  const full = JSON.parse((await run(["capabilities"])).stdout);
  const { stdout } = await run(["capabilities", "--role", "implement"]);
  const compact = JSON.parse(stdout);
  assert.equal(compact.role, "implement");
  assert.deepEqual(compact.chosen, full.roles.implement.chosen);
  assert.equal(compact.model, full.roles.implement.model);
  assert.ok(!("skills" in compact));
  assert.ok(Buffer.byteLength(stdout) < Buffer.byteLength(JSON.stringify(full)) / 10, "one-role output should be at least 90% smaller than the full inventory");
});

test("cli wire: capabilities --roles-only omits skills and installed inventory", async () => {
  const { stdout } = await run(["capabilities", "--roles-only"]);
  const compact = JSON.parse(stdout);
  assert.ok(compact.roles.implement);
  assert.deepEqual(Object.keys(compact), ["roles"]);
});

// ---------------------------------------------------------------------------
// manifest validate <fixture>
// ---------------------------------------------------------------------------

test("cli wire: manifest validate exits 0 on valid fixture", async () => {
  const fixture = join(REPO_ROOT, "test/fixtures/manifest.valid.json");
  // run() throws on non-zero exit
  await run(["manifest", "validate", fixture]);
});

test("cli wire: manifest validate returns {ok:true, errors:[]} on valid fixture", async () => {
  const fixture = join(REPO_ROOT, "test/fixtures/manifest.valid.json");
  const { stdout } = await run(["manifest", "validate", fixture]);
  const parsed = JSON.parse(stdout);

  assert.equal(parsed.ok, true, "'ok' must be true on valid manifest");
  assert.ok("errors" in parsed, "missing 'errors' key");
  assert.ok(Array.isArray(parsed.errors), "'errors' must be an array");
  assert.equal(parsed.errors.length, 0, "errors array must be empty for a valid manifest");
});

test("cli wire: manifest validate exits 2 on invalid manifest", async () => {
  // A manifest missing required keys should exit 2
  try {
    // Pass a path that doesn't match manifest schema by using a temp fixture
    // We pass the plan.diamond.json which has no 'outcome' key
    const badFixture = join(REPO_ROOT, "test/fixtures/plan.diamond.json");
    await run(["manifest", "validate", badFixture]);
    assert.fail("should have exited non-zero on invalid manifest");
  } catch (err) {
    assert.equal(err.code, 2, "exit code must be 2 when manifest is invalid");
  }
});

// manifest validate is wired to the real resolveCapabilities().skills inventory (same
// call used by capabilities/match --skills elsewhere in this file), so a hallucinated
// bound skill id trips manifestWarnings' inventory check for real, not just at the
// unit level. "totally-fake-nonexistent-skill-xyz" cannot resolve on any machine's
// live ~/.claude inventory, so this holds regardless of the calling environment.
test("cli wire: manifest validate surfaces a warning for a bound skill id absent from the live inventory", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "muster-cli-wire-"));
  try {
    const fixture = join(tmp, "manifest.hallucinated-skill.json");
    await writeFile(fixture, JSON.stringify({
      outcome: "Add rate limiting",
      successCriteria: ["429 past N req/min", "tests green"],
      crew: [{ stage: "navigate", provider: "grep", source: "builtin", model: "sonnet", rationale: "no LSP", evidence: "no serena", fallback: "inline" }],
      recommendations: [], degradations: [],
      plan: [{ id: "t1", task: "middleware", mode: "single",
        skills: [{ id: "totally-fake-nonexistent-skill-xyz", rationale: "r" }] }],
    }));
    const { stdout } = await run(["manifest", "validate", fixture]);
    const parsed = JSON.parse(stdout);
    assert.equal(parsed.ok, true, "an unresolved skill id is a warning, not a validation error");
    assert.ok(Array.isArray(parsed.warnings), "missing 'warnings' key");
    assert.ok(parsed.warnings.some(w => /totally-fake-nonexistent-skill-xyz/.test(w)),
      `expected an inventory warning, got ${JSON.stringify(parsed.warnings)}`);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test("cli wire: manifest validate on a fixture with no skills bindings has no warnings key", async () => {
  const fixture = join(REPO_ROOT, "test/fixtures/manifest.valid.json");
  const { stdout } = await run(["manifest", "validate", fixture]);
  const parsed = JSON.parse(stdout);
  assert.ok(!("warnings" in parsed), "a manifest with no skills bindings should carry no warnings key");
});

// ---------------------------------------------------------------------------
// plan-checklist <fixture>
// ---------------------------------------------------------------------------

test("cli wire: plan-checklist exits 0 on valid manifest", async () => {
  const fixture = join(REPO_ROOT, "test/fixtures/plan.diamond.json");
  await run(["plan-checklist", fixture]); // throws on non-zero
});

test("cli wire: plan-checklist output contains checkbox lines", async () => {
  const fixture = join(REPO_ROOT, "test/fixtures/plan.diamond.json");
  const { stdout } = await run(["plan-checklist", fixture]);

  const lines = stdout.trim().split("\n").filter(Boolean);
  assert.ok(lines.length > 0, "plan-checklist must emit at least one line");

  for (const line of lines) {
    assert.ok(
      /^- \[[ x]\]/.test(line),
      `every line must be a checkbox; got: ${JSON.stringify(line)}`
    );
  }
});

test("cli wire: plan-checklist shows task ids and names from the fixture", async () => {
  const fixture = join(REPO_ROOT, "test/fixtures/plan.diamond.json");
  const { stdout } = await run(["plan-checklist", fixture]);

  // plan.diamond.json has ids a, b, c, d
  assert.ok(stdout.includes(" a "), "output should contain task id 'a'");
  assert.ok(stdout.includes(" b "), "output should contain task id 'b'");
  assert.ok(stdout.includes("(tournament)"), "tournament task should be labelled");
});

// ---------------------------------------------------------------------------
// negative-path: unknown command, bad wave inputs
// ---------------------------------------------------------------------------

test("cli wire: unknown command exits 1 and emits 'unknown command' on stderr", async () => {
  try {
    await run(["totally-unknown-command-xyz"]);
    assert.fail("should have exited non-zero");
  } catch (err) {
    assert.equal(err.code, 1, `expected exit 1, got ${err.code}`);
    assert.match(err.stderr, /unknown command/i, "stderr must mention 'unknown command'");
  }
});

test("cli wire: wave /nonexistent.json exits 1", async () => {
  try {
    await run(["wave", "/nonexistent-file-that-does-not-exist-xyz.json"]);
    assert.fail("should have exited non-zero");
  } catch (err) {
    assert.equal(err.code, 1, `expected exit 1, got ${err.code}`);
  }
});

test("cli wire: wave <invalid JSON file> exits 1 with error on stderr", async (t) => {
  const tmp = await mkdtemp(join(tmpdir(), "muster-cli-wire-"));
  t.after(() => rm(tmp, { recursive: true, force: true }));
  const badJson = join(tmp, "bad.json");
  await writeFile(badJson, "{ this is not valid json !!!");
  try {
    await run(["wave", badJson]);
    assert.fail("should have exited non-zero for invalid JSON");
  } catch (err) {
    assert.equal(err.code, 1, `expected exit 1, got ${err.code}`);
    assert.ok(err.stderr && err.stderr.length > 0, "stderr must be non-empty on JSON parse error");
  }
});
