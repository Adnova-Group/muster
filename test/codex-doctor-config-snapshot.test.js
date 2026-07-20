// Regression coverage for run-5 audit Low #13 (src/codex-doctor.js "double
// read"): a single runCodexDoctor call read CODEX_HOME/config.toml MORE THAN
// ONCE -- separately for the thread-limit check and the hook-state check -- so
// a concurrent mutation BETWEEN the two reads produced internally-inconsistent
// diagnostics (thread-limits reflecting one config.toml, hook-state reflecting
// a different one). The fix takes ONE safe snapshot per run and reuses the same
// bytes (or the same read error) for every config.toml consumer, so a mutation
// mid-run can no longer make the two checks disagree.
//
// runCodexDoctor exposes the config.toml read as an injectable collaborator
// (readConfigToml, defaulting to the module's dev/ino + O_NOFOLLOW guarded safe
// reader), mirroring the existing execFile / mcpRunner / env / platform seams.
// The stub below returns config A on the first read and, IF the code re-read,
// config B on the second -- so the double read is observable (read count) and
// its effect is observable (the two checks disagree).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCodexInstall } from "../src/codex-install.js";
import { runCodexDoctor } from "../src/codex-doctor.js";
import { repoRoot } from "../test-support/codex-helpers.js";
import { CODEX_COUNTS } from "../src/codex.js";

const absentCodex = async () => { throw new Error("codex absent"); };
// Isolate this test from the bundled-MCP handshake (and its known border
// flake): a healthy stub keeps the run focused on config.toml read semantics.
const healthyHandshake = async () => ({ initialized: true, tools: new Array(CODEX_COUNTS.mcpTools).fill({}), toolCallOk: true });
const hookStateBlock = (hooksJsonPath, events) =>
  events.map(event => `[hooks.state."${hooksJsonPath}:${event}:0:0"]\ntrusted_hash = "sha256:${"0".repeat(64)}"\n`).join("\n");

test("Codex doctor reads config.toml once per run: thread-limit and hook-state checks reflect one snapshot, never A-then-B", async t => {
  const tmp = await mkdtemp(join(tmpdir(), "muster-codex-doctor-config-snapshot-"));
  t.after(() => rm(tmp, { recursive: true, force: true }));
  const home = join(tmp, "home"), keep = join(tmp, "project-keep"), gone = join(tmp, "project-gone");
  const codexHome = join(home, ".codex");
  // Two managed scopes; then `gone` is deleted so it becomes a registered-but-
  // dead scope whose lingering [hooks.state] entry is genuinely stale.
  await runCodexInstall({ cwd: keep, home, repoRoot, execFile: absentCodex });
  await runCodexInstall({ cwd: gone, home, repoRoot, execFile: absentCodex });
  const goneHooksJson = join(gone, ".codex", "hooks.json");

  // config A: the healthy install baseline -- thread limits meet the floor AND
  // no stale hook trust entries. config B: A plus the dead scope's [hooks.state]
  // entry, which makes ONLY the hook-state check go stale (thread limits are
  // untouched). A single snapshot must make both checks reflect A.
  const configA = await readFile(join(codexHome, "config.toml"), "utf8");
  const configB = `${configA}\n${hookStateBlock(goneHooksJson, ["session_start"])}\n`;
  await rm(gone, { recursive: true, force: true });

  // Sanity: config B is a genuinely diverging config -- reading it makes
  // hook-state fail while thread limits still pass. This proves the A-vs-B
  // distinction below is real, not a no-op.
  const controlReport = await runCodexDoctor({
    root: repoRoot, cwd: keep, codexHome, execFile: absentCodex, mcpRunner: healthyHandshake,
    readConfigToml: async () => configB
  });
  assert.equal(controlReport.checks.find(check => check.name === "codex-hook-state")?.ok, false,
    "sanity: config B is a genuinely stale-hook-state config");
  assert.equal(controlReport.checks.find(check => check.name === "codex-thread-limits")?.ok, true,
    "sanity: config B leaves the thread-limit floor met");

  // Main run: the first config.toml read returns A; any SECOND read (i.e. a
  // double read) would return the mutated B. The thread-limit check runs first
  // and would see A; the hook-state check runs second and, under a double read,
  // would see B -- so the two checks would disagree about the same file.
  let reads = 0;
  const report = await runCodexDoctor({
    root: repoRoot, cwd: keep, codexHome, execFile: absentCodex, mcpRunner: healthyHandshake,
    readConfigToml: async () => { reads += 1; return reads === 1 ? configA : configB; }
  });
  const threadLimits = report.checks.find(check => check.name === "codex-thread-limits");
  const hookState = report.checks.find(check => check.name === "codex-hook-state");

  assert.equal(reads, 1, "config.toml must be read exactly once per doctor run (no double read)");
  assert.equal(hookState?.ok, true, "hook-state must reuse the first snapshot (config A, clean), not re-read the mutated config B");
  assert.equal(threadLimits?.ok, hookState?.ok, "thread-limit and hook-state checks must agree -- they derive from one config.toml snapshot");
});
