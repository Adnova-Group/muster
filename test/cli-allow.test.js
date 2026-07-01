// test/cli-allow.test.js — `muster allow` CLI tests.
//
// `muster allow <toolName> [rest...] [--project]` writes the permission key to
// the run store (.muster/allow.run.json) or the project store (.muster-allow.json).
//
// `muster allow --list [--project]` prints current keys from the selected store.
//
// All tests use temp directories for stores and clean up after themselves.
// No .muster-allow.json is left in the repo working tree.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";
import { mkdtemp, readFile, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";

const pexecFile = promisify(execFile);

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..");
const CLI = join(REPO_ROOT, "src/cli.js");

// Run CLI in a specific cwd so all file writes go to that dir.
function runAllow(args, cwd) {
  return pexecFile(process.execPath, [CLI, ...args], { cwd });
}

// ── muster allow Bash npm test writes run store ──────────────────────────────

test("muster allow Bash npm test writes key to run store", async (t) => {
  const tmpDir = await mkdtemp(join(tmpdir(), "muster-allow-cli-"));
  t.after(() => rm(tmpDir, { recursive: true, force: true }));

  const { stdout } = await runAllow(["allow", "Bash", "npm", "test"], tmpDir);
  const result = JSON.parse(stdout);
  assert.equal(result.ok, true, "allow must return {ok:true}");
  assert.equal(result.store, "run", "default store must be run");
  assert.equal(result.key, "Bash:npm test", "key must be Bash:<command>");

  // Verify the file was actually written.
  const stored = JSON.parse(await readFile(join(tmpDir, ".muster", "allow.run.json"), "utf8"));
  assert.ok(Array.isArray(stored), "stored value must be an array");
  assert.ok(stored.includes("Bash:npm test"), "run store must contain the new key");
});

// ── muster allow Edit /src/foo.js --project writes project store ─────────────

test("muster allow Edit /src/foo.js --project writes key to project store", async (t) => {
  const tmpDir = await mkdtemp(join(tmpdir(), "muster-allow-cli-"));
  t.after(() => rm(tmpDir, { recursive: true, force: true }));

  const { stdout } = await runAllow(["allow", "Edit", "/src/foo.js", "--project"], tmpDir);
  const result = JSON.parse(stdout);
  assert.equal(result.ok, true, "allow --project must return {ok:true}");
  assert.equal(result.store, "project", "--project must write to project store");
  assert.equal(result.key, "Edit:/src/foo.js", "key must be Edit:<target>");

  // Project store at the cwd root (not under .muster/).
  const stored = JSON.parse(await readFile(join(tmpDir, ".muster-allow.json"), "utf8"));
  assert.ok(stored.includes("Edit:/src/foo.js"), "project store must contain the new key");
});

// ── muster allow --list prints current keys ──────────────────────────────────

test("muster allow --list prints run store keys", async (t) => {
  const tmpDir = await mkdtemp(join(tmpdir(), "muster-allow-cli-"));
  t.after(() => rm(tmpDir, { recursive: true, force: true }));

  // Seed two keys via allow command.
  await runAllow(["allow", "Bash", "npm", "test"], tmpDir);
  await runAllow(["allow", "Bash", "npm", "run", "build"], tmpDir);

  const { stdout } = await runAllow(["allow", "--list"], tmpDir);
  const lines = stdout.trim().split("\n").filter(Boolean);
  assert.ok(lines.includes("Bash:npm test"), "list must include npm test key");
  assert.ok(lines.includes("Bash:npm run build"), "list must include npm run build key");
});

test("muster allow --list --project prints project store keys", async (t) => {
  const tmpDir = await mkdtemp(join(tmpdir(), "muster-allow-cli-"));
  t.after(() => rm(tmpDir, { recursive: true, force: true }));

  await runAllow(["allow", "Edit", "/src/index.js", "--project"], tmpDir);
  const { stdout } = await runAllow(["allow", "--list", "--project"], tmpDir);
  const lines = stdout.trim().split("\n").filter(Boolean);
  assert.ok(lines.includes("Edit:/src/index.js"), "project list must include the edit key");
});

// ── idempotent: running allow twice yields one entry ─────────────────────────

test("muster allow is idempotent — same key added twice yields one entry", async (t) => {
  const tmpDir = await mkdtemp(join(tmpdir(), "muster-allow-cli-"));
  t.after(() => rm(tmpDir, { recursive: true, force: true }));

  await runAllow(["allow", "Bash", "npm", "test"], tmpDir);
  await runAllow(["allow", "Bash", "npm", "test"], tmpDir);

  const stored = JSON.parse(await readFile(join(tmpDir, ".muster", "allow.run.json"), "utf8"));
  const dupes = stored.filter(k => k === "Bash:npm test");
  assert.equal(dupes.length, 1, "idempotent: key must appear exactly once");
});

// ── --list with empty/missing store prints nothing, exits 0 ──────────────────

test("muster allow --list on empty store exits 0 with no output", async (t) => {
  const tmpDir = await mkdtemp(join(tmpdir(), "muster-allow-cli-"));
  t.after(() => rm(tmpDir, { recursive: true, force: true }));

  // No allow.run.json — list should print nothing.
  await mkdir(join(tmpDir, ".muster"), { recursive: true });
  const { stdout } = await runAllow(["allow", "--list"], tmpDir);
  assert.equal(stdout.trim(), "", "empty store list must produce no output");
});

// ── toolName missing → exits non-zero ────────────────────────────────────────

test("muster allow with missing toolName exits 1", async (t) => {
  const tmpDir = await mkdtemp(join(tmpdir(), "muster-allow-cli-"));
  t.after(() => rm(tmpDir, { recursive: true, force: true }));

  try {
    await runAllow(["allow"], tmpDir);
    assert.fail("should have exited non-zero");
  } catch (err) {
    assert.equal(err.code, 1, "missing toolName must exit 1");
  }
});

// ── no stray .muster-allow.json in repo root ─────────────────────────────────
//
// This test verifies that no test in this file leaves .muster-allow.json in the
// repo root. All --project writes go to temp dirs because runAllow passes cwd.

test("no stray .muster-allow.json was left in the repo root by this test suite", async () => {
  try {
    await readFile(join(REPO_ROOT, ".muster-allow.json"), "utf8");
    assert.fail(
      ".muster-allow.json must NOT exist in the repo root — a test wrote it there",
    );
  } catch (err) {
    // ENOENT = good: file does not exist
    assert.equal(err.code, "ENOENT", "repo-root .muster-allow.json must not exist");
  }
});
