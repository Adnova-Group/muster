import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import {
  DEFAULT_CODEX_THREAD_LIMITS,
  codexThreadLimitManifestPath,
  ensureCodexThreadLimits,
} from "../src/codex-thread-limits.js";
import { runCodexInstall, runCodexUninstall } from "../src/codex-install.js";
import { runCodexWave } from "../src/codex-wave-runner.js";
import { repoRoot } from "../test-support/codex-helpers.js";

const absentCodex = async () => { throw new Error("codex absent"); };
const execFile = promisify(execFileCallback);

async function lifecycleFixture(t, { initialConfig, legacyManifest, expected }) {
  const tmp = await mkdtemp(join(tmpdir(), "muster-canonical-thread-ceiling-"));
  t.after(() => import("node:fs/promises").then(fs => fs.rm(tmp, { recursive: true, force: true })));
  const cwd = join(tmp, "project");
  const home = join(tmp, "home");
  const codexHome = join(home, ".codex");
  const configPath = join(codexHome, "config.toml");
  if (initialConfig !== undefined) {
    await mkdir(codexHome, { recursive: true });
    await writeFile(configPath, initialConfig);
  }
  if (legacyManifest) {
    const manifestPath = codexThreadLimitManifestPath(codexHome);
    await mkdir(join(codexHome, "muster"), { recursive: true });
    await writeFile(manifestPath, JSON.stringify({
      format: 1,
      owner: "muster",
      configPath: legacyManifest.configPath ?? configPath,
      configCreated: legacyManifest.configCreated,
      sectionCreated: legacyManifest.sectionCreated,
      before: legacyManifest.before,
      installed: legacyManifest.installed,
    }, null, 2) + "\n");
  }

  await runCodexInstall({ cwd, home, repoRoot, execFile: absentCodex });
  assert.equal(await readFile(configPath, "utf8"), expected.installed);
  await runCodexUninstall({ cwd, home, execFile: absentCodex });
  if (expected.uninstalled === null) {
    await assert.rejects(readFile(configPath, "utf8"), /ENOENT/);
  } else {
    assert.equal(await readFile(configPath, "utf8"), expected.uninstalled);
  }
  await runCodexInstall({ cwd, home, repoRoot, execFile: absentCodex });
  assert.equal(await readFile(configPath, "utf8"), expected.reinstalled);
}

test("canonical Codex thread ceiling: install/uninstall/reinstall preserve absent, lower, higher, and legacy-owned fixtures", async t => {
  await t.test("absent ceiling receives Muster's default only while installed", async t => {
    await lifecycleFixture(t, {
      expected: {
        installed: "[agents]\nmax_concurrent_threads_per_session = 12\n",
        uninstalled: null,
        reinstalled: "[agents]\nmax_concurrent_threads_per_session = 12\n",
      },
    });
  });

  for (const ceiling of [3, 24]) {
    await t.test(`${ceiling < 12 ? "lower" : "higher"} user ceiling ${ceiling} is preserved`, async t => {
      const config = `[agents]\nmax_concurrent_threads_per_session = ${ceiling}\n`;
      await lifecycleFixture(t, {
        initialConfig: config,
        expected: { installed: config, uninstalled: config, reinstalled: config },
      });
    });
  }

  await t.test("legacy Muster-owned aliases migrate and are removed without touching user values", async t => {
    await lifecycleFixture(t, {
      initialConfig: "[agents]\nmax_threads = 12\nmax_depth = 2\n",
      legacyManifest: {
        configCreated: true,
        sectionCreated: true,
        before: { max_threads: null, max_depth: null },
        installed: { max_threads: 12, max_depth: 2 },
      },
      expected: {
        installed: "[agents]\nmax_concurrent_threads_per_session = 12\n",
        uninstalled: null,
        reinstalled: "[agents]\nmax_concurrent_threads_per_session = 12\n",
      },
    });
  });

  await t.test("a user-edited legacy value is retained while owned aliases are migrated", async t => {
    await lifecycleFixture(t, {
      initialConfig: "[agents]\nmax_threads = 20\nmax_depth = 2\n",
      legacyManifest: {
        configCreated: true,
        sectionCreated: true,
        before: { max_threads: null, max_depth: null },
        installed: { max_threads: 12, max_depth: 2 },
      },
      expected: {
        installed: "[agents]\nmax_threads = 20\nmax_concurrent_threads_per_session = 20\n",
        uninstalled: "[agents]\nmax_threads = 20\n",
        reinstalled: "[agents]\nmax_threads = 20\nmax_concurrent_threads_per_session = 20\n",
      },
    });
  });

  await t.test("a legacy receipt for another config cannot authorize alias removal", async t => {
    const tmp = await mkdtemp(join(tmpdir(), "muster-canonical-foreign-receipt-"));
    t.after(() => import("node:fs/promises").then(fs => fs.rm(tmp, { recursive: true, force: true })));
    const cwd = join(tmp, "project");
    const home = join(tmp, "home");
    const codexHome = join(home, ".codex");
    const configPath = join(codexHome, "config.toml");
    const manifestPath = codexThreadLimitManifestPath(codexHome);
    const config = "[agents]\nmax_threads = 12\nmax_depth = 2\n";
    await mkdir(join(codexHome, "muster"), { recursive: true });
    await writeFile(configPath, config);
    await writeFile(manifestPath, JSON.stringify({
      format: 1,
      owner: "muster",
      configPath: join(tmp, "different", "config.toml"),
      configCreated: true,
      sectionCreated: true,
      before: { max_threads: null, max_depth: null },
      installed: { max_threads: 12, max_depth: 2 },
    }));
    await assert.rejects(
      runCodexInstall({ cwd, home, repoRoot, execFile: absentCodex }),
      /thread-limit manifest conflict/,
    );
    assert.equal(await readFile(configPath, "utf8"), config);
  });
});

test("canonical Codex thread ceiling: pure editor defaults only when absent and never raises user ceilings", () => {
  assert.deepEqual(DEFAULT_CODEX_THREAD_LIMITS, { max_concurrent_threads_per_session: 12 });
  assert.equal(
    ensureCodexThreadLimits("").text,
    "[agents]\nmax_concurrent_threads_per_session = 12\n",
  );
  for (const ceiling of [3, 24]) {
    const input = `[agents]\nmax_concurrent_threads_per_session = ${ceiling}\n`;
    assert.equal(ensureCodexThreadLimits(input).text, input);
  }
});

test("Codex scheduler never dispatches above the effective configured or available ceiling", async () => {
  const members = Array.from({ length: 7 }, (_, index) => ({
    id: `member-${index}`,
    prompt: `prompt-${index}`,
    model: "gpt-5.6-sol",
    agentType: "muster-builder",
    writes: [`file-${index}`],
  }));

  for (const { configured, available, expected } of [
    { configured: 2, available: undefined, expected: 2 },
    { configured: 6, available: 3, expected: 3 },
    { configured: 6, available: 1, expected: 1 },
  ]) {
    let active = 0;
    let peak = 0;
    const result = await runCodexWave({
      members,
      catalogVersions: { "gpt-5.6-sol": "v2" },
      maxConcurrentThreadsPerSession: configured,
      availableThreadLimit: available,
      waitForAgentBatch: async () => {},
      dispatchAgent: async () => {
        active += 1;
        peak = Math.max(peak, active);
        await new Promise(resolve => setTimeout(resolve, 5));
        active -= 1;
        return { accepted: true };
      },
    });
    assert.equal(result.effectiveCeiling, expected);
    assert.ok(peak <= expected, `peak ${peak} exceeded effective ceiling ${expected}`);
    assert.equal(result.results.length, members.length);
  }
});

test("codex-wave CLI carries the configured and available ceilings into scheduling", async t => {
  const tmp = await mkdtemp(join(tmpdir(), "muster-canonical-wave-cli-"));
  t.after(() => import("node:fs/promises").then(fs => fs.rm(tmp, { recursive: true, force: true })));
  const wavePath = join(tmp, "wave.json");
  const codexHome = join(tmp, "codex-home");
  await mkdir(codexHome, { recursive: true });
  await writeFile(
    join(codexHome, "config.toml"),
    "[agents]\nmax_concurrent_threads_per_session = 2\n",
  );
  await writeFile(wavePath, JSON.stringify({
    members: [
      { id: "one", prompt: "one", model: "gpt-5.6-sol", agentType: "muster-builder", writes: ["a"] },
      { id: "two", prompt: "two", model: "gpt-5.6-sol", agentType: "muster-builder", writes: ["b"] },
    ],
    catalogVersions: { "gpt-5.6-sol": "v2" },
    maxConcurrentThreadsPerSession: 6,
    codexHome,
  }));
  const { stdout } = await execFile(process.execPath, [join(repoRoot, "src", "cli.js"), "codex-wave", wavePath], {
    cwd: repoRoot,
  });
  const result = JSON.parse(stdout);
  assert.equal(result.effectiveCeiling, 2);
  assert.ok(result.batches.every(batch => batch.length <= 2));
});

test("spawn-agent scheduling waits between ceiling-sized batches after immediate spawn receipts", async () => {
  const members = Array.from({ length: 7 }, (_, index) => ({
    id: `member-${index}`,
    prompt: `prompt-${index}`,
    model: "gpt-5.6-sol",
    agentType: "muster-builder",
    writes: [`file-${index}`],
  }));
  let active = 0;
  let peak = 0;
  const waited = [];
  const result = await runCodexWave({
    members,
    catalogVersions: { "gpt-5.6-sol": "v2" },
    maxConcurrentThreadsPerSession: 2,
    dispatchAgent: async () => {
      active += 1;
      peak = Math.max(peak, active);
      return { taskId: `task-${active}` };
    },
    waitForAgentBatch: async batch => {
      waited.push(batch.map(row => row.id));
      active -= batch.length;
    },
  });
  assert.equal(peak, 2);
  assert.deepEqual(waited.map(batch => batch.length), [2, 2, 2, 1]);
  assert.deepEqual(result.batches.map(batch => batch.length), [2, 2, 2, 1]);
});
