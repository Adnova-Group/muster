import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  codexThreadLimitManifestPath,
  ensureCodexThreadLimits,
  restoreCodexThreadLimits,
} from "../src/codex-thread-limits.js";
import { computeSprintWaves } from "../src/sprint-waves.js";
import { runCodexInstall, runCodexUninstall } from "../src/codex-install.js";
import { repoRoot } from "../test-support/codex-helpers.js";

const absentCodex = async () => { throw new Error("codex absent"); };

const backlog = Array.from(
  { length: 6 },
  (_, index) => `- [ ] Item ${index + 1} {id: item-${index + 1}} {deps: none}`,
).join("\n");

test("Codex 0.146 install preserves a canonical user ceiling and defaults only when absent", () => {
  assert.equal(
    ensureCodexThreadLimits("").text,
    "[agents]\nmax_concurrent_threads_per_session = 12\n",
  );
  const userConfig = "[agents]\nmax_concurrent_threads_per_session = 3 # user\n";
  assert.equal(ensureCodexThreadLimits(userConfig).text, userConfig);
});

test("Codex 0.146 migration copies but does not clean an unowned legacy ceiling", () => {
  const input = "[agents]\nmax_threads = 4 # user\nmax_depth = 1\n";
  const installed = ensureCodexThreadLimits(input);
  assert.match(installed.text, /max_threads = 4 # user/);
  assert.match(installed.text, /max_depth = 1/);
  assert.match(installed.text, /max_concurrent_threads_per_session = 4/);
});

test("Codex 0.146 legacy cleanup is restricted to receipt-proven Muster values", () => {
  const input = "[agents]\nmax_threads = 12\nmax_depth = 2\nuser_key = true\n";
  const restored = restoreCodexThreadLimits(input, {
    before: { max_threads: null, max_depth: null },
    installed: { max_threads: 12, max_depth: 2 },
    sectionCreated: false,
  });
  assert.equal(restored, "[agents]\nuser_key = true\n");

  const userEdited = input.replace("max_threads = 12", "max_threads = 7");
  assert.match(
    restoreCodexThreadLimits(userEdited, {
      before: { max_threads: null, max_depth: null },
      installed: { max_threads: 12, max_depth: 2 },
      sectionCreated: false,
    }),
    /max_threads = 7/,
  );
});

test("Codex install migrates an owned legacy receipt and uninstall restores its user baseline", async t => {
  const tmp = await mkdtemp(join(tmpdir(), "muster-canonical-thread-migration-"));
  t.after(() => import("node:fs/promises").then(fs => fs.rm(tmp, { recursive: true, force: true })));
  const cwd = join(tmp, "project");
  const home = join(tmp, "home");
  const codexHome = join(home, ".codex");
  const configPath = join(codexHome, "config.toml");
  const receiptPath = codexThreadLimitManifestPath(codexHome);
  await mkdir(join(codexHome, "muster"), { recursive: true });
  await writeFile(configPath, "[agents]\nmax_threads = 12\nmax_depth = 2\n");
  await writeFile(receiptPath, JSON.stringify({
    format: 1,
    owner: "muster",
    configPath,
    before: { max_threads: 4, max_depth: null },
    installed: { max_threads: 12, max_depth: 2 },
    sectionCreated: false,
    configCreated: false,
  }));

  await runCodexInstall({ cwd, home, repoRoot, execFile: absentCodex });
  const installed = await readFile(configPath, "utf8");
  assert.match(installed, /max_threads = 4/);
  assert.doesNotMatch(installed, /max_depth/);
  assert.match(installed, /max_concurrent_threads_per_session = 4/);

  await runCodexUninstall({ cwd, home, execFile: absentCodex });
  assert.equal(await readFile(configPath, "utf8"), "[agents]\nmax_threads = 4\n");
});

test("Codex install rejects legacy ownership receipts for another config path", async t => {
  const tmp = await mkdtemp(join(tmpdir(), "muster-canonical-thread-forged-"));
  t.after(() => import("node:fs/promises").then(fs => fs.rm(tmp, { recursive: true, force: true })));
  const cwd = join(tmp, "project");
  const home = join(tmp, "home");
  const codexHome = join(home, ".codex");
  const configPath = join(codexHome, "config.toml");
  const receiptPath = codexThreadLimitManifestPath(codexHome);
  await mkdir(join(codexHome, "muster"), { recursive: true });
  await writeFile(configPath, "[agents]\nmax_threads = 12\nmax_depth = 2\n");
  await writeFile(receiptPath, JSON.stringify({
    format: 1,
    owner: "muster",
    configPath: join(tmp, "victim.toml"),
    before: { max_threads: null, max_depth: null },
    installed: { max_threads: 12, max_depth: 2 },
    sectionCreated: false,
    configCreated: false,
  }));

  await assert.rejects(
    runCodexInstall({ cwd, home, repoRoot, execFile: absentCodex }),
    /thread-limit manifest conflict/,
  );
  assert.equal(await readFile(configPath, "utf8"), "[agents]\nmax_threads = 12\nmax_depth = 2\n");
});

test("Codex wave scheduling cannot exceed the canonical session ceiling", () => {
  const result = computeSprintWaves(backlog, {
    parallelLimit: 9,
    maxConcurrentThreadsPerSession: 2,
  });
  assert.equal(result.schedule.buildReview.maxConcurrency, 2);
  assert.deepEqual(result.schedule.waves[0].buildReview.batches, [
    ["item-1", "item-2"],
    ["item-3", "item-4"],
    ["item-5", "item-6"],
  ]);
  assert.equal(
    computeSprintWaves(backlog, { maxConcurrentThreadsPerSession: 2 })
      .schedule.buildReview.maxConcurrency,
    2,
  );
});

test("generated Codex watch policy names only the canonical session ceiling", async () => {
  const adapter = await readFile(new URL("../codex/skill-adapter.md", import.meta.url), "utf8");
  assert.match(adapter, /agents\.max_concurrent_threads_per_session/);
  assert.doesNotMatch(adapter, /agents\.max_threads/);
});
