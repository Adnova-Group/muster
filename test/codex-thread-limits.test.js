// Codex subagent thread-limit floor enforcement (backlog item
// `codex-thread-limits-enforcement`, re-opened by
// docs/decisions/retriage-install-items.md against the dropped
// ensureCodexThreadLimits/restoreCodexThreadLimits pair, f2da066). Raise-not-
// lower semantics on the shared global config.toml's [agents] table
// (max_threads >= 12, max_depth >= 2), wired into runCodexInstall/
// runCodexUninstall's existing atomic-write/rollback transaction and a
// doctor drift check -- independent of install/uninstall scope, since the
// target file is the one CODEX_HOME shared by Codex CLI, IDE, and Desktop.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CODEX_THREAD_LIMIT_REMEDIATION,
  REQUIRED_CODEX_THREAD_LIMITS,
  codexThreadLimitConfigPath,
  codexThreadLimitManifestPath,
  codexThreadLimitsMeetFloor,
  ensureCodexThreadLimits,
  readCodexThreadLimits,
  restoreCodexThreadLimits
} from "../src/codex-thread-limits.js";
import { runCodexInstall, runCodexUninstall } from "../src/codex-install.js";
import { runCodexDoctor } from "../src/codex-doctor.js";
import { repoRoot } from "../test-support/codex-helpers.js";

const absentCodex = async () => { throw new Error("codex absent"); };

// -- Pure text-editor unit tests -------------------------------------------

test("Codex thread limits: fresh config receives the mandatory [agents] section", () => {
  const result = ensureCodexThreadLimits("");
  assert.match(result.text, /\[agents\][\s\S]*max_threads = 12[\s\S]*max_depth = 2/);
  assert.deepEqual(result.before, { max_threads: null, max_depth: null });
  assert.deepEqual(result.installed, { max_threads: 12, max_depth: 2 });
  assert.equal(result.sectionCreated, true);
});

test("Codex thread limits: existing lower values are raised without touching unrelated config", () => {
  const input = "model = \"gpt\"\n\n[agents]\nmax_threads = 4 # keep comment\nmax_depth = 1\n\n[ui]\ncolor = true\n";
  const result = ensureCodexThreadLimits(input);
  assert.match(result.text, /max_threads = 12 # keep comment/);
  assert.match(result.text, /max_depth = 2/);
  assert.match(result.text, /model = "gpt"[\s\S]*\[ui\][\s\S]*color = true/);
  assert.equal(result.sectionCreated, false);
  assert.deepEqual(result.before, { max_threads: 4, max_depth: 1 });
});

test("Codex thread limits: existing higher values are never lowered (byte-identical)", () => {
  const input = "[agents]\nmax_threads = 40\nmax_depth = 5\n";
  const result = ensureCodexThreadLimits(input);
  assert.equal(result.text, input);
  assert.deepEqual(result.installed, { max_threads: 40, max_depth: 5 });
});

test("Codex thread limits: repeated application is idempotent", () => {
  const once = ensureCodexThreadLimits("[agents]\nmax_threads = 3\n").text;
  assert.equal(ensureCodexThreadLimits(once).text, once);
});

test("Codex thread limits: malformed existing value fails strict validation", () => {
  assert.throws(() => ensureCodexThreadLimits("[agents]\nmax_threads = \"many\"\n"), /max_threads must be a non-negative integer/);
});

test("Codex thread limits: readCodexThreadLimits reports current values and floor status", () => {
  assert.deepEqual(readCodexThreadLimits(""), { max_threads: null, max_depth: null });
  assert.equal(codexThreadLimitsMeetFloor(readCodexThreadLimits("")), false);
  assert.equal(codexThreadLimitsMeetFloor(readCodexThreadLimits("[agents]\nmax_threads = 12\nmax_depth = 2\n")), true);
  assert.equal(codexThreadLimitsMeetFloor(readCodexThreadLimits("[agents]\nmax_threads = 12\nmax_depth = 1\n")), false);
});

test("Codex thread limits: restoreCodexThreadLimits preserves a user's post-install raise and drops an untouched created key", () => {
  const original = "theme = \"dark\"\n\n[agents]\nmax_threads = 4\n";
  const installed = ensureCodexThreadLimits(original);
  assert.match(installed.text, /max_threads = 12/);
  assert.match(installed.text, /max_depth = 2/);
  const userRaisedFurther = installed.text.replace("max_threads = 12", "max_threads = 20");
  const restored = restoreCodexThreadLimits(userRaisedFurther, installed);
  assert.match(restored, /theme = "dark"/);
  assert.match(restored, /max_threads = 20/, "user's post-install higher value is preserved");
  assert.doesNotMatch(restored, /max_depth/, "Muster-added untouched key is removed on restore");
});

test("Codex thread limits: path helpers target the shared CODEX_HOME, not a per-scope directory", () => {
  const codexHome = "/home/x/.codex";
  assert.equal(codexThreadLimitConfigPath(codexHome), join(codexHome, "config.toml"));
  assert.equal(codexThreadLimitManifestPath(codexHome), join(codexHome, "muster", "thread-limits.json"));
});

test("Codex thread limits: remediation text names the exact floor and the fix command", () => {
  assert.match(CODEX_THREAD_LIMIT_REMEDIATION, /\[agents\] max_threads >= 12 and max_depth >= 2/);
  assert.match(CODEX_THREAD_LIMIT_REMEDIATION, /muster install codex/);
});

test("Codex thread limits: required floor constants match the documented item text", () => {
  assert.deepEqual(REQUIRED_CODEX_THREAD_LIMITS, { max_threads: 12, max_depth: 2 });
});

// -- Install-time integration (runCodexInstall) -----------------------------

test("Codex thread limits: fresh install writes the floor into a brand-new global config.toml", async t => {
  const tmp = await mkdtemp(join(tmpdir(), "muster-thread-fresh-"));
  t.after(() => import("node:fs/promises").then(fs => fs.rm(tmp, { recursive: true, force: true })));
  const cwd = join(tmp, "project"), home = join(tmp, "home");
  const result = await runCodexInstall({ cwd, home, repoRoot, execFile: absentCodex });
  assert.ok(result.files.some(item => item.op === "merge" && item.path === join(home, ".codex", "config.toml")));
  const written = await readFile(join(home, ".codex", "config.toml"), "utf8");
  assert.match(written, /max_threads = 12/);
  assert.match(written, /max_depth = 2/);
  const manifest = JSON.parse(await readFile(join(home, ".codex", "muster", "thread-limits.json"), "utf8"));
  assert.equal(manifest.owner, "muster");
  assert.deepEqual(manifest.before, { max_threads: null, max_depth: null });
  assert.deepEqual(manifest.installed, { max_threads: 12, max_depth: 2 });
  assert.equal(manifest.configCreated, true);
});

test("Codex thread limits: existing-lower global config.toml is raised, unrelated keys untouched", async t => {
  const tmp = await mkdtemp(join(tmpdir(), "muster-thread-lower-"));
  t.after(() => import("node:fs/promises").then(fs => fs.rm(tmp, { recursive: true, force: true })));
  const cwd = join(tmp, "project"), home = join(tmp, "home"), codexHomeDir = join(home, ".codex");
  await mkdir(codexHomeDir, { recursive: true });
  await writeFile(join(codexHomeDir, "config.toml"), "model = \"gpt-5.6\"\n\n[agents]\nmax_threads = 6\nmax_depth = 1\n");
  await runCodexInstall({ cwd, home, repoRoot, execFile: absentCodex });
  const written = await readFile(join(codexHomeDir, "config.toml"), "utf8");
  assert.match(written, /model = "gpt-5\.6"/);
  assert.match(written, /max_threads = 12/);
  assert.match(written, /max_depth = 2/);
  const manifest = JSON.parse(await readFile(join(codexHomeDir, "muster", "thread-limits.json"), "utf8"));
  assert.deepEqual(manifest.before, { max_threads: 6, max_depth: 1 });
  assert.equal(manifest.configCreated, false);
});

test("Codex thread limits: existing-higher global config.toml is never lowered", async t => {
  const tmp = await mkdtemp(join(tmpdir(), "muster-thread-higher-"));
  t.after(() => import("node:fs/promises").then(fs => fs.rm(tmp, { recursive: true, force: true })));
  const cwd = join(tmp, "project"), home = join(tmp, "home"), codexHomeDir = join(home, ".codex");
  await mkdir(codexHomeDir, { recursive: true });
  const original = "[agents]\nmax_threads = 40\nmax_depth = 5\n";
  await writeFile(join(codexHomeDir, "config.toml"), original);
  await runCodexInstall({ cwd, home, repoRoot, execFile: absentCodex });
  assert.equal(await readFile(join(codexHomeDir, "config.toml"), "utf8"), original);
});

test("Codex thread limits: dry-run performs zero config.toml mutations", async t => {
  const tmp = await mkdtemp(join(tmpdir(), "muster-thread-dry-"));
  t.after(() => import("node:fs/promises").then(fs => fs.rm(tmp, { recursive: true, force: true })));
  const cwd = join(tmp, "project"), home = join(tmp, "home"), codexHomeDir = join(home, ".codex");
  await mkdir(codexHomeDir, { recursive: true });
  await writeFile(join(codexHomeDir, "config.toml"), "[agents]\nmax_threads = 1\n");
  await runCodexInstall({ cwd, home, repoRoot, execFile: absentCodex, dryRun: true });
  assert.equal(await readFile(join(codexHomeDir, "config.toml"), "utf8"), "[agents]\nmax_threads = 1\n");
  await assert.rejects(readFile(join(codexHomeDir, "muster", "thread-limits.json"), "utf8"), /ENOENT/);
});

test("Codex thread limits: uninstall restores only Muster-owned values", async t => {
  const tmp = await mkdtemp(join(tmpdir(), "muster-thread-uninstall-"));
  t.after(() => import("node:fs/promises").then(fs => fs.rm(tmp, { recursive: true, force: true })));
  const cwd = join(tmp, "project"), home = join(tmp, "home"), codexHomeDir = join(home, ".codex");
  await mkdir(codexHomeDir, { recursive: true });
  const original = "theme = \"dark\"\n\n[agents]\nmax_threads = 4\n";
  await writeFile(join(codexHomeDir, "config.toml"), original);
  await runCodexInstall({ cwd, home, repoRoot, execFile: absentCodex });
  let installed = await readFile(join(codexHomeDir, "config.toml"), "utf8");
  assert.match(installed, /max_threads = 12/);
  assert.match(installed, /max_depth = 2/);
  installed = installed.replace("max_threads = 12", "max_threads = 20");
  await writeFile(join(codexHomeDir, "config.toml"), installed);
  await runCodexUninstall({ cwd, home, execFile: absentCodex });
  const restored = await readFile(join(codexHomeDir, "config.toml"), "utf8");
  assert.match(restored, /theme = "dark"/);
  assert.match(restored, /max_threads = 20/, "user's post-install higher value is preserved");
  assert.doesNotMatch(restored, /max_depth/, "Muster-added untouched key is removed");
  await assert.rejects(readFile(join(codexHomeDir, "muster", "thread-limits.json"), "utf8"), /ENOENT/);
});

test("Codex thread limits: install fails outright with exact remediation when the config.toml write cannot complete", async t => {
  const tmp = await mkdtemp(join(tmpdir(), "muster-thread-writefail-"));
  t.after(() => import("node:fs/promises").then(fs => fs.rm(tmp, { recursive: true, force: true })));
  const cwd = join(tmp, "project"), home = join(tmp, "home"), codexHomeDir = join(home, ".codex");
  // A directory where config.toml should be: the write cannot complete.
  await mkdir(join(codexHomeDir, "config.toml"), { recursive: true });
  await assert.rejects(
    runCodexInstall({ cwd, home, repoRoot, execFile: absentCodex }),
    /Set \[agents\] max_threads >= 12 and max_depth >= 2.*muster install codex/
  );
  // The rest of the install (profiles/hooks) must also roll back -- the
  // failure is transactional, not a partial install.
  await assert.rejects(readFile(join(cwd, ".codex", "agents", ".muster-managed.json"), "utf8"), /ENOENT/);
});

test("Codex thread limits: install fails outright with exact remediation when the existing config.toml fails strict validation", async t => {
  const tmp = await mkdtemp(join(tmpdir(), "muster-thread-invalid-"));
  t.after(() => import("node:fs/promises").then(fs => fs.rm(tmp, { recursive: true, force: true })));
  const cwd = join(tmp, "project"), home = join(tmp, "home"), codexHomeDir = join(home, ".codex");
  await mkdir(codexHomeDir, { recursive: true });
  await writeFile(join(codexHomeDir, "config.toml"), "[agents]\nmax_threads = \"many\"\n");
  await assert.rejects(
    runCodexInstall({ cwd, home, repoRoot, execFile: absentCodex }),
    /Set \[agents\] max_threads >= 12 and max_depth >= 2.*muster install codex/
  );
});

test("Codex thread limits: a repeat install preserves the true original baseline for a later full restore", async t => {
  const tmp = await mkdtemp(join(tmpdir(), "muster-thread-repeat-"));
  t.after(() => import("node:fs/promises").then(fs => fs.rm(tmp, { recursive: true, force: true })));
  const cwd = join(tmp, "project"), home = join(tmp, "home"), codexHomeDir = join(home, ".codex");
  await mkdir(codexHomeDir, { recursive: true });
  await writeFile(join(codexHomeDir, "config.toml"), "[agents]\nmax_threads = 4\n");
  await runCodexInstall({ cwd, home, repoRoot, execFile: absentCodex });
  // A second install call must not re-derive "before" from the
  // already-raised file (12) -- it must keep remembering the true
  // pre-Muster baseline (4) recorded by the first install.
  await runCodexInstall({ cwd, home, repoRoot, execFile: absentCodex });
  const manifest = JSON.parse(await readFile(join(codexHomeDir, "muster", "thread-limits.json"), "utf8"));
  assert.deepEqual(manifest.before, { max_threads: 4, max_depth: null });
  await runCodexUninstall({ cwd, home, execFile: absentCodex });
  const restored = await readFile(join(codexHomeDir, "config.toml"), "utf8");
  assert.match(restored, /max_threads = 4/);
  assert.doesNotMatch(restored, /max_depth/);
});

// -- Doctor drift check ------------------------------------------------------

test("Codex thread limits: doctor reports ok:true immediately after install", async t => {
  const tmp = await mkdtemp(join(tmpdir(), "muster-thread-doctor-ok-"));
  t.after(() => import("node:fs/promises").then(fs => fs.rm(tmp, { recursive: true, force: true })));
  const cwd = join(tmp, "project"), home = join(tmp, "home"), codexHomeDir = join(home, ".codex");
  await runCodexInstall({ cwd, home, repoRoot, execFile: absentCodex });
  const report = await runCodexDoctor({ root: repoRoot, cwd, codexHome: codexHomeDir, execFile: absentCodex });
  const check = report.checks.find(item => item.name === "codex-thread-limits");
  assert.equal(check?.ok, true);
});

test("Codex thread limits: doctor reports the exact remediation message when a live config drifts below the floor outside a muster install", async t => {
  const tmp = await mkdtemp(join(tmpdir(), "muster-thread-doctor-drift-"));
  t.after(() => import("node:fs/promises").then(fs => fs.rm(tmp, { recursive: true, force: true })));
  const cwd = join(tmp, "project"), home = join(tmp, "home"), codexHomeDir = join(home, ".codex");
  await runCodexInstall({ cwd, home, repoRoot, execFile: absentCodex });
  // Drift outside of muster install: something else lowers max_threads back down.
  await writeFile(join(codexHomeDir, "config.toml"), "[agents]\nmax_threads = 3\nmax_depth = 2\n");
  const report = await runCodexDoctor({ root: repoRoot, cwd, codexHome: codexHomeDir, execFile: absentCodex });
  const check = report.checks.find(item => item.name === "codex-thread-limits");
  assert.equal(check?.ok, false);
  assert.match(check?.detail || "", /Set \[agents\] max_threads >= 12 and max_depth >= 2.*muster install codex/);
  assert.equal(report.ok, false, "an unmet thread-limit floor must fail the overall doctor verdict");
});

test("Codex thread limits: doctor reports the same remediation message when config.toml is missing entirely", async t => {
  const tmp = await mkdtemp(join(tmpdir(), "muster-thread-doctor-missing-"));
  t.after(() => import("node:fs/promises").then(fs => fs.rm(tmp, { recursive: true, force: true })));
  const cwd = join(tmp, "project"), home = join(tmp, "home"), codexHomeDir = join(home, ".codex");
  const report = await runCodexDoctor({ root: repoRoot, cwd, codexHome: codexHomeDir, execFile: absentCodex });
  const check = report.checks.find(item => item.name === "codex-thread-limits");
  assert.equal(check?.ok, false);
  assert.match(check?.detail || "", /Set \[agents\] max_threads >= 12 and max_depth >= 2.*muster install codex/);
});
