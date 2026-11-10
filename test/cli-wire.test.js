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
import { mkdir, writeFile, readFile, readdir, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { trackedMkdtemp as mkdtemp, tmpProject } from "../test-support/helpers.js";

const pexecFile = promisify(execFile);

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..");
const CLI = join(REPO_ROOT, "src/cli.js");

function run(args, cwd = REPO_ROOT) {
  return pexecFile(process.execPath, [CLI, ...args], { cwd });
}

test("cli wire: help and --help exit zero without dispatching mutating verbs", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "muster-help-"));
  const before = await readdir(cwd);
  const direct = await run(["help", "signals"], cwd);
  const flagged = await run(["signals", "--help"], cwd);
  const install = await run(["install", "--help"], cwd);
  assert.match(direct.stdout, /Usage: muster/);
  assert.equal(flagged.stdout, direct.stdout);
  assert.equal(install.stdout, direct.stdout);
  assert.deepEqual(await readdir(cwd), before, "help must not create files in the caller's directory");
});

test("cli wire: init lifecycle emits the complete envelope and setup remains legacy", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "muster-init-wire-"));
  const prepared = JSON.parse((await run(["init", cwd])).stdout);
  assert.equal(prepared.receipt.format, "muster.init-receipt");
  assert.equal(prepared.observedNativeEvidence, null);
  assert.equal(prepared.receipt.phase, "prepared");
  await assert.rejects(() => readFile(join(cwd, "AGENTS.md"), "utf8"), { code: "ENOENT" });

  const transitioned = JSON.parse((await run([
    "init", "transition", cwd, "--to", "handoff", "--reason", "unavailable", "--expect", "",
  ])).stdout);
  assert.equal(transitioned.receipt.nativeInit.state, "handoff");
  await run(["init", "acknowledge", cwd, "--reason", "unavailable"]);
  const finalized = JSON.parse((await run(["init", "finalize", cwd])).stdout);
  assert.equal(finalized.receipt.phase, "finalized");

  const legacy = await mkdtemp(join(tmpdir(), "muster-setup-wire-"));
  await run(["setup", legacy]);
  assert.match(await readFile(join(legacy, "AGENTS.md"), "utf8"), /managed with muster/);
});

test("cli wire: signals writes signals.json under the explicit target directory", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "muster-signals-cwd-"));
  const target = await mkdtemp(join(tmpdir(), "muster-signals-target-"));
  await writeFile(join(target, "package.json"), JSON.stringify({ name: "signals-target" }));
  const { stdout } = await run(["signals", target], cwd);
  const persisted = JSON.parse(await readFile(join(target, ".muster/signals.json"), "utf8"));
  assert.deepEqual(persisted, JSON.parse(stdout));
  await assert.rejects(() => readFile(join(cwd, ".muster/signals.json"), "utf8"), { code: "ENOENT" });
});

test("cli wire: signals refuses symlinked .muster ancestry and dangling signals.json", async () => {
  const target = await mkdtemp(join(tmpdir(), "muster-signals-safe-"));
  const outside = await mkdtemp(join(tmpdir(), "muster-signals-outside-"));
  await writeFile(join(target, "package.json"), "{}");
  await symlink(outside, join(target, ".muster"), "dir");
  await assert.rejects(() => run(["signals", target]), error => {
    assert.match(String(error.stderr), /symlink|reparse/i);
    return true;
  });
  await assert.rejects(() => readFile(join(outside, "signals.json")), { code: "ENOENT" });

  const dangling = await mkdtemp(join(tmpdir(), "muster-signals-dangling-"));
  await mkdir(join(dangling, ".muster"));
  await symlink(join(dangling, "missing.json"), join(dangling, ".muster", "signals.json"));
  await assert.rejects(() => run(["signals", dangling]), error => {
    assert.match(String(error.stderr), /symlink|reparse/i);
    return true;
  });
  await assert.rejects(() => readFile(join(dangling, "missing.json")), { code: "ENOENT" });
});

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
  // "compact" is a STRUCTURAL guarantee, not a size ratio: the single-role output
  // omits the heavy parts (the skills inventory and the full roles map). A byte
  // ratio against the full output is env-coupled (it swings with how many
  // providers are installed), so assert the structure directly instead.
  assert.ok(!("skills" in compact), "compact role output omits the skills inventory");
  assert.ok(!("roles" in compact), "compact role output omits the full roles map");
});

// audit S3 (2026-07-30, architecture P1): `capabilities [home]` documents a
// positional home-dir override, and readInstalled(home) honored it -- but the
// default/--cowork/--work lanes then called resolveCapabilities WITHOUT it (only
// --codex threaded it through), so the skills inventory reported names
// from the override home while resolving their descriptions against the REAL
// homedir: every description came back "". Pinned end to end through the CLI.
test("cli wire: capabilities resolves installed skill descriptions from the positional home override", async () => {
  const home = await tmpProject({
    ".claude/skills/audit-s3-home-override/SKILL.md":
      "---\nname: audit-s3-home-override\ndescription: fixture skill proving the home override reaches skill descriptions\n---\n\n# body\n",
  });
  const { skills } = JSON.parse((await run(["capabilities", home])).stdout);
  const skill = skills.find((s) => s.id === "audit-s3-home-override");
  assert.ok(skill, "the override home's installed skill must appear in the inventory");
  assert.equal(skill.source, "installed");
  assert.equal(skill.description, "fixture skill proving the home override reaches skill descriptions",
    "the description must be read from the override home, not the real homedir");
});

test("cli wire: capabilities --roles-only omits skills and installed inventory", async () => {
  const { stdout } = await run(["capabilities", "--roles-only"]);
  const compact = JSON.parse(stdout);
  assert.ok(compact.roles.implement);
  assert.deepEqual(Object.keys(compact), ["roles"]);
});

// ── Cowork plugin-ride capability check ─────────────────────────────────────
// Cowork loads plugin skills and agents from the claude.ai account
// (docs/research/claude-cowork.md §3), so `capabilities --cowork` resolves
// muster's builtins unless the install is plugin-less: a declaration
// (--native-plugin / --plugin-less / MUSTER_COWORK_NATIVE_PLUGIN) wins, then
// the Desktop app's account plugin list, then the documented plugin route.
// Each test pins a fixture home (positional arg; on Linux the config dir is
// <home>/.config/Claude) so a real Desktop install cannot change the result.
// Assertions compare against the non-cowork resolution from an empty home
// rather than a frozen provider id, so a catalog re-rank stays harmless.
async function coworkHome(plugins) {
  const home = await mkdtemp(join(tmpdir(), "muster-cowork-home-"));
  if (plugins) {
    const list = join(home, ".config/Claude/plugin-list/org/account");
    await mkdir(list, { recursive: true });
    await writeFile(join(list, "plugins.json"), JSON.stringify({ plugins }));
  }
  return home;
}
const plainDebug = async (home) => JSON.parse((await run(["capabilities", home, "--role", "debug"])).stdout).chosen;
const coworkDebug = async (home, extra = [], env = {}) => JSON.parse((await pexecFile(
  process.execPath, [CLI, "capabilities", "--cowork", home, ...extra, "--role", "debug"],
  { cwd: REPO_ROOT, env: { ...process.env, MUSTER_COWORK_NATIVE_PLUGIN: "", ...env } },
)).stdout).chosen;

test("cli wire: capabilities --cowork with no declaration and no readable plugin list resolves the plugin route", async () => {
  const home = await coworkHome();
  try {
    const chosen = await coworkDebug(home);
    assert.notEqual(chosen.id, "inline", "the plugin marketplace is the documented route; unknown is not plugin-less");
    assert.deepEqual(chosen, await plainDebug(home));
  } finally { await rm(home, { recursive: true, force: true }); }
});

test("cli wire: capabilities --cowork reads the account plugin list (muster absent -> MCP fallback, present -> plugin)", async () => {
  const without = await coworkHome([{ id: "design@kw", name: "design", enabled: true }]);
  const withMuster = await coworkHome([{ id: "muster@muster", name: "muster", enabled: true }]);
  try {
    assert.equal((await coworkDebug(without)).id, "inline", "a readable list without muster selects the plugin-less fallback");
    assert.deepEqual(await coworkDebug(withMuster), await plainDebug(withMuster));
  } finally {
    await rm(without, { recursive: true, force: true });
    await rm(withMuster, { recursive: true, force: true });
  }
});

test("cli wire: --native-plugin and MUSTER_COWORK_NATIVE_PLUGIN=1 override a list without muster", async () => {
  const home = await coworkHome([{ id: "design@kw", name: "design", enabled: true }]);
  try {
    const plain = await plainDebug(home);
    assert.deepEqual(await coworkDebug(home, ["--native-plugin"]), plain);
    assert.deepEqual(await coworkDebug(home, [], { MUSTER_COWORK_NATIVE_PLUGIN: "1" }), plain);
  } finally { await rm(home, { recursive: true, force: true }); }
});

test("cli wire: --plugin-less and MUSTER_COWORK_NATIVE_PLUGIN=0/false declare the MCP-only fallback; empty declares nothing", async () => {
  const home = await coworkHome();
  try {
    assert.equal((await coworkDebug(home, ["--plugin-less"])).id, "inline");
    for (const value of ["0", "false"]) {
      assert.equal((await coworkDebug(home, [], { MUSTER_COWORK_NATIVE_PLUGIN: value })).id, "inline", `MUSTER_COWORK_NATIVE_PLUGIN=${value}`);
    }
    assert.notEqual((await coworkDebug(home, [], { MUSTER_COWORK_NATIVE_PLUGIN: "" })).id, "inline", "an empty value is not a declaration");
  } finally { await rm(home, { recursive: true, force: true }); }
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
// tally <verdicts.json> -- schema boundary before tallyReview
// ---------------------------------------------------------------------------

// .muster/verdicts.json is a structured-output-binding contract
// (src/verdict.schema.json, loaded via src/verdict-schema.js).
// The schema is the STRICT boundary validator; src/review.js's tallyReview is the
// defensive floor (see test/verdict-schema.test.js's header). The CLI's tally verb
// validates BEFORE tallying and splits violations into three pinned classes:
//   1. schema-valid                    -> exit 0, tally JSON on stdout;
//   2. schema-invalid but tally-able   -> exit 0, tally JSON on stdout PLUS a
//      structured stderr warning naming the violations (tallyReview's documented
//      tolerance -- findings alongside an exhaustion status, a reviewer with no
//      findings, a finding with no `note`);
//   3. tally-corrupting                -> exit 1, no tally JSON: unparseable JSON,
//      a non-array top level, or an entry with no reviewer identity (the exact
//      floor verdictsTallyCorruptionErrors pins from tallyReview's needs).
test("cli wire: tally on a schema-valid verdicts file exits 0 with the tally shape", async (t) => {
  const tmp = await mkdtemp(join(tmpdir(), "muster-cli-tally-"));
  t.after(() => rm(tmp, { recursive: true, force: true }));
  const file = join(tmp, "verdicts.json");
  await writeFile(file, JSON.stringify([
    { reviewer: "code-review", findings: [{ severity: "blocker", note: "real bug" }] },
    { reviewer: "killed-worker", status: "exhausted" },
  ]));
  const { stdout } = await run(["tally", file]);
  const parsed = JSON.parse(stdout);
  assert.equal(parsed.blocked, true, "an exhausted status entry forces blocked:true");
  assert.deepEqual(parsed.counts, { blocker: 1, risk: 0, nit: 0 });
});

test("cli wire: tally on a schema-violating but tally-able file exits 0, tallies, and warns with named violations", async (t) => {
  const tmp = await mkdtemp(join(tmpdir(), "muster-cli-tally-"));
  t.after(() => rm(tmp, { recursive: true, force: true }));
  const file = join(tmp, "verdicts.json");
  await writeFile(file, JSON.stringify([
    // status + findings: tallyReview ignores the spoofed finding (documented tolerance)
    { reviewer: "killed-worker", status: "exhausted", findings: [{ severity: "blocker", note: "spoofed alongside exhaustion" }] },
    // a reviewer entry with no findings at all
    { reviewer: "quiet-reviewer" },
    // a finding missing its `note`
    { reviewer: "sloppy", findings: [{ severity: "risk" }] },
  ]));
  const { stdout, stderr } = await run(["tally", file]);
  const parsed = JSON.parse(stdout);
  assert.equal(parsed.blocked, true, "the exhausted entry still forces blocked:true");
  assert.deepEqual(parsed.counts, { blocker: 0, risk: 1, nit: 0 },
    "the spoofed finding is discarded; the note-less risk finding still tallies");
  const warning = JSON.parse(stderr.trim());
  assert.match(warning.warn, /verdict\.schema\.json/, "the warning names the schema as the bent contract");
  assert.ok(Array.isArray(warning.violations) && warning.violations.length > 0,
    "the warning carries the named schema violations");
});

test("cli wire: tally on tally-corrupting files exits 1 and names why (unparseable JSON, non-array, no reviewer identity)", async (t) => {
  const tmp = await mkdtemp(join(tmpdir(), "muster-cli-tally-"));
  t.after(() => rm(tmp, { recursive: true, force: true }));

  const expectFail = async (name, content, patterns) => {
    const file = join(tmp, name);
    await writeFile(file, content);
    try {
      await run(["tally", file]);
      assert.fail(`${name}: should have exited non-zero`);
    } catch (err) {
      assert.equal(err.code, 1, `${name}: expected exit 1, got ${err.code}`);
      for (const pattern of patterns) assert.match(err.stderr, pattern, `${name}: stderr must name the failure`);
      assert.equal(err.stdout ?? "", "", `${name}: no tally JSON may be emitted`);
    }
  };

  // unparseable JSON -- fails loud before validation ever runs
  await expectFail("garbage.json", "this is not json{", [/tally|error|JSON/i]);
  // a non-array top level would for-of into silent garbage or throw
  await expectFail("object.json", JSON.stringify({ reviewer: "a", findings: [] }),
    [/not tally-able/, /must be an array/]);
  // entries lacking a reviewer identity silently break blocker/blockedReasons
  // attribution -- stricter than tallyReview's UNNAMED_REVIEWER floor
  await expectFail("nameless-findings.json", JSON.stringify([{ findings: [{ severity: "blocker", note: "x" }] }]),
    [/not tally-able/, /no reviewer identity/]);
  await expectFail("nameless-status.json", JSON.stringify([{ status: "exhausted" }]),
    [/not tally-able/, /no reviewer identity/]);
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
