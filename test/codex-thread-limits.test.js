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
  restoreCodexThreadLimits,
} from "../src/codex-thread-limits.js";
import { runCodexInstall } from "../src/codex-install.js";
import { runCodexDoctor } from "../src/codex-doctor.js";
import { repoRoot } from "../test-support/codex-helpers.js";

const absentCodex = async () => { throw new Error("codex absent"); };

test("Codex thread limits: fresh config receives only the canonical default", () => {
  const result = ensureCodexThreadLimits("");
  assert.equal(result.text, "[agents]\nmax_concurrent_threads_per_session = 12\n");
  assert.deepEqual(result.before, { max_concurrent_threads_per_session: null });
  assert.deepEqual(result.installed, { max_concurrent_threads_per_session: 12 });
  assert.equal(result.sectionCreated, true);
});

test("Codex thread limits: existing canonical values are preserved byte-identically", () => {
  for (const ceiling of [3, 24]) {
    const input = `[agents]\nmax_concurrent_threads_per_session = ${ceiling}\n`;
    const result = ensureCodexThreadLimits(input);
    assert.equal(result.text, input);
    assert.deepEqual(result.installed, { max_concurrent_threads_per_session: ceiling });
  }
});

test("Codex thread limits: escaped quoted keys are decoded before canonical mutation", () => {
  const escaped = "[\"ag\\u0065nts\"]\n\"max_concurrent_threads_per_sessi\\u006fn\" = 3\n";
  assert.equal(ensureCodexThreadLimits(escaped).text, escaped);
  assert.throws(
    () => ensureCodexThreadLimits(
      "[agents]\nmax_concurrent_threads_per_session = 3\n\"max_concurrent_threads_per_sessi\\u006fn\" = 4\n",
    ),
    /duplicate \[agents\] max_concurrent_threads_per_session key/,
  );
});

test("Codex thread limits: unsafe integers retain exact identity in JSON-serializable records", () => {
  const exact = "9007199254740993";
  const installed = ensureCodexThreadLimits(`[agents]\nmax_concurrent_threads_per_session = ${exact}\n`);
  assert.deepEqual(installed.before, { max_concurrent_threads_per_session: exact });
  assert.deepEqual(installed.installed, { max_concurrent_threads_per_session: exact });
  assert.doesNotThrow(() => JSON.stringify(installed));
  assert.equal(
    restoreCodexThreadLimits(
      "[agents]\nmax_concurrent_threads_per_session = 9007199254740992\n",
      { ...installed, before: { max_concurrent_threads_per_session: null } },
    ),
    "[agents]\nmax_concurrent_threads_per_session = 9007199254740992\n",
  );
});

test("Codex thread limits: an unowned legacy ceiling is copied, not removed or raised", () => {
  const input = "model = \"gpt\"\n\n[agents]\nmax_threads = 4 # user\nmax_depth = 1\n";
  const result = ensureCodexThreadLimits(input);
  assert.match(result.text, /max_threads = 4 # user/);
  assert.match(result.text, /max_depth = 1/);
  assert.match(result.text, /max_concurrent_threads_per_session = 4/);
});

test("Codex thread limits: malformed canonical values fail strict validation", () => {
  assert.throws(
    () => ensureCodexThreadLimits("[agents]\nmax_concurrent_threads_per_session = \"many\"\n"),
    /max_concurrent_threads_per_session must be a non-negative integer/,
  );
  assert.throws(
    () => ensureCodexThreadLimits("[agents]\nmax_concurrent_threads_per_session = 0\n"),
    /positive integer/,
  );
});

test("Codex thread limits: read and validity checks use only the canonical key", () => {
  assert.deepEqual(readCodexThreadLimits(""), { max_concurrent_threads_per_session: null });
  assert.equal(codexThreadLimitsMeetFloor(readCodexThreadLimits("[agents]\nmax_threads = 12\n")), false);
  assert.equal(codexThreadLimitsMeetFloor(readCodexThreadLimits("[agents]\nmax_concurrent_threads_per_session = 3\n")), true);
});

test("Codex thread limits: restore removes an untouched created key but preserves user drift", () => {
  const installed = ensureCodexThreadLimits("theme = \"dark\"\n");
  assert.equal(restoreCodexThreadLimits(installed.text, installed), "theme = \"dark\"\n");
  const drifted = installed.text.replace(
    "max_concurrent_threads_per_session = 12",
    "max_concurrent_threads_per_session = 20",
  );
  assert.match(restoreCodexThreadLimits(drifted, installed), /max_concurrent_threads_per_session = 20/);
});

test("Codex thread limits: helpers and remediation name the canonical setting", () => {
  const codexHome = "/home/x/.codex";
  assert.equal(codexThreadLimitConfigPath(codexHome), join(codexHome, "config.toml"));
  assert.equal(codexThreadLimitManifestPath(codexHome), join(codexHome, "muster", "thread-limits.json"));
  assert.deepEqual(REQUIRED_CODEX_THREAD_LIMITS, { max_concurrent_threads_per_session: 12 });
  assert.match(CODEX_THREAD_LIMIT_REMEDIATION, /\[agents\] max_concurrent_threads_per_session to a positive integer/);
  assert.match(CODEX_THREAD_LIMIT_REMEDIATION, /muster install codex/);
});

test("Codex thread limits: install failures retain exact canonical remediation", async t => {
  const tmp = await mkdtemp(join(tmpdir(), "muster-thread-invalid-"));
  t.after(() => import("node:fs/promises").then(fs => fs.rm(tmp, { recursive: true, force: true })));
  const cwd = join(tmp, "project");
  const home = join(tmp, "home");
  const codexHome = join(home, ".codex");
  await mkdir(codexHome, { recursive: true });
  await writeFile(join(codexHome, "config.toml"), "[agents]\nmax_concurrent_threads_per_session = \"many\"\n");
  await assert.rejects(
    runCodexInstall({ cwd, home, repoRoot, execFile: absentCodex }),
    /Set \[agents\] max_concurrent_threads_per_session to a positive integer.*muster install codex/,
  );
});

test("Codex thread limits: repeat install retains the original canonical ownership baseline", async t => {
  const tmp = await mkdtemp(join(tmpdir(), "muster-thread-repeat-"));
  t.after(() => import("node:fs/promises").then(fs => fs.rm(tmp, { recursive: true, force: true })));
  const cwd = join(tmp, "project");
  const home = join(tmp, "home");
  const codexHome = join(home, ".codex");
  await mkdir(codexHome, { recursive: true });
  await writeFile(join(codexHome, "config.toml"), "[agents]\nmax_concurrent_threads_per_session = 4\n");
  await runCodexInstall({ cwd, home, repoRoot, execFile: absentCodex });
  await runCodexInstall({ cwd, home, repoRoot, execFile: absentCodex });
  const manifest = JSON.parse(await readFile(codexThreadLimitManifestPath(codexHome), "utf8"));
  assert.deepEqual(manifest.before, { max_concurrent_threads_per_session: 4 });
  assert.deepEqual(manifest.installed, { max_concurrent_threads_per_session: 4 });
});

test("Codex thread limits: doctor accepts lower ceilings and rejects missing canonical configuration", async t => {
  const tmp = await mkdtemp(join(tmpdir(), "muster-thread-doctor-"));
  t.after(() => import("node:fs/promises").then(fs => fs.rm(tmp, { recursive: true, force: true })));
  const cwd = join(tmp, "project");
  const codexHome = join(tmp, "home", ".codex");
  await mkdir(codexHome, { recursive: true });
  await writeFile(join(codexHome, "config.toml"), "[agents]\nmax_concurrent_threads_per_session = 3\n");
  let report = await runCodexDoctor({ root: repoRoot, cwd, codexHome, execFile: absentCodex });
  assert.equal(report.checks.find(item => item.name === "codex-thread-limits")?.ok, true);
  await writeFile(join(codexHome, "config.toml"), "[agents]\nmax_threads = 3\n");
  report = await runCodexDoctor({ root: repoRoot, cwd, codexHome, execFile: absentCodex });
  const check = report.checks.find(item => item.name === "codex-thread-limits");
  assert.equal(check?.ok, false);
  assert.match(check?.detail || "", /max_concurrent_threads_per_session.*muster install codex/);
});
