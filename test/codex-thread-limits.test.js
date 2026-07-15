import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverCodexGlobalHomes, ensureCodexThreadLimits, restoreCodexThreadLimits } from "../src/codex-thread-limits.js";
import { runCodexInstall, runCodexUninstall } from "../src/codex-install.js";

const repoRoot = new URL("../", import.meta.url).pathname;
const absentCodex = async () => { const error = new Error("codex absent"); error.code = "ENOENT"; throw error; };

test("Codex thread limits: fresh config receives the mandatory agents section", () => {
  const result = ensureCodexThreadLimits("");
  assert.match(result.text, /\[agents\][\s\S]*max_threads = 12[\s\S]*max_depth = 2/);
  assert.deepEqual(result.before, { max_threads: null, max_depth: null });
});

test("Codex thread limits: existing lower values are raised without changing unrelated config", () => {
  const input = "model = \"gpt\"\n\n[agents]\nmax_threads = 4 # keep comment\nmax_depth = 1\n\n[ui]\ncolor = true\n";
  const result = ensureCodexThreadLimits(input);
  assert.match(result.text, /max_threads = 12 # keep comment/);
  assert.match(result.text, /max_depth = 2/);
  assert.match(result.text, /model = \"gpt\"[\s\S]*\[ui\][\s\S]*color = true/);
});

test("Codex thread limits: existing higher values are never lowered", () => {
  const input = "[agents]\nmax_threads = 40\nmax_depth = 5\n";
  assert.equal(ensureCodexThreadLimits(input).text, input);
});

test("Codex thread limits: split WSL and Windows Desktop homes are both discovered once", () => {
  assert.deepEqual(discoverCodexGlobalHomes({
    cwd: "/mnt/c/Users/Ryan/work/muster", home: "/home/ryan", codexHome: "/home/ryan/.codex"
  }), ["/home/ryan/.codex", "/mnt/c/Users/Ryan/.codex"]);
});

test("Codex thread limits: repeated updates are idempotent", () => {
  const once = ensureCodexThreadLimits("[agents]\nmax_threads = 3\n").text;
  assert.equal(ensureCodexThreadLimits(once).text, once);
});

test("Codex thread limits: dry-run performs zero config mutations", async t => {
  const tmp = await mkdtemp(join(tmpdir(), "muster-thread-dry-"));
  t.after(() => rm(tmp, { recursive: true, force: true }));
  const cwd = join(tmp, "project"), home = join(tmp, "home"), globalHome = join(tmp, "global");
  await mkdir(globalHome, { recursive: true });
  await writeFile(join(globalHome, "config.toml"), "[agents]\nmax_threads = 1\n");
  await runCodexInstall({ cwd, home, repoRoot, execFile: absentCodex, dryRun: true, globalHomes: [globalHome] });
  assert.equal(await readFile(join(globalHome, "config.toml"), "utf8"), "[agents]\nmax_threads = 1\n");
  await assert.rejects(readFile(join(globalHome, "muster", "thread-limits.json")), /ENOENT/);
});

test("Codex thread limits: uninstall restores only Muster-owned values", async t => {
  const tmp = await mkdtemp(join(tmpdir(), "muster-thread-uninstall-"));
  t.after(() => rm(tmp, { recursive: true, force: true }));
  const cwd = join(tmp, "project"), home = join(tmp, "home"), globalHome = join(tmp, "global");
  await mkdir(globalHome, { recursive: true });
  const original = "theme = \"dark\"\n\n[agents]\nmax_threads = 4\n";
  await writeFile(join(globalHome, "config.toml"), original);
  await runCodexInstall({ cwd, home, repoRoot, execFile: absentCodex, globalHomes: [globalHome] });
  let installed = await readFile(join(globalHome, "config.toml"), "utf8");
  assert.match(installed, /max_threads = 12/);
  assert.match(installed, /max_depth = 2/);
  installed = installed.replace("max_threads = 12", "max_threads = 20");
  await writeFile(join(globalHome, "config.toml"), installed);
  await runCodexUninstall({ cwd, home, execFile: absentCodex, globalHomes: [globalHome] });
  const restored = await readFile(join(globalHome, "config.toml"), "utf8");
  assert.match(restored, /theme = \"dark\"/);
  assert.match(restored, /max_threads = 20/, "user's post-install higher value is preserved");
  assert.doesNotMatch(restored, /max_depth/, "Muster-added unchanged key is removed");
});

test("Codex thread limits: uninstall retains shared limits until the last managed scope", async t => {
  const tmp = await mkdtemp(join(tmpdir(), "muster-thread-scopes-"));
  t.after(() => rm(tmp, { recursive: true, force: true }));
  const first = join(tmp, "first"), second = join(tmp, "second"), home = join(tmp, "home"), globalHome = join(tmp, "global");
  await mkdir(globalHome, { recursive: true });
  await writeFile(join(globalHome, "config.toml"), "[agents]\nmax_threads = 4\n");
  await runCodexInstall({ cwd: first, home, repoRoot, execFile: absentCodex, globalHomes: [globalHome] });
  await runCodexInstall({ cwd: second, home, repoRoot, execFile: absentCodex, globalHomes: [globalHome] });

  await runCodexUninstall({ cwd: first, home, execFile: absentCodex, globalHomes: [globalHome] });
  assert.match(await readFile(join(globalHome, "config.toml"), "utf8"), /max_threads = 12/);
  assert.doesNotReject(readFile(join(globalHome, "muster", "thread-limits.json")));

  await runCodexUninstall({ cwd: second, home, execFile: absentCodex, globalHomes: [globalHome] });
  const restored = await readFile(join(globalHome, "config.toml"), "utf8");
  assert.match(restored, /max_threads = 4/);
  assert.doesNotMatch(restored, /max_depth/);
  await assert.rejects(readFile(join(globalHome, "muster", "thread-limits.json")), /ENOENT/);
});

test("Codex thread limits: malformed strict config fails with exact remediation", async t => {
  const tmp = await mkdtemp(join(tmpdir(), "muster-thread-invalid-"));
  t.after(() => rm(tmp, { recursive: true, force: true }));
  const cwd = join(tmp, "project"), home = join(tmp, "home"), globalHome = join(tmp, "global");
  await mkdir(globalHome, { recursive: true });
  await writeFile(join(globalHome, "config.toml"), "[agents]\nmax_threads = \"many\"\n");
  await assert.rejects(
    runCodexInstall({ cwd, home, repoRoot, execFile: absentCodex, globalHomes: [globalHome] }),
    /Set \[agents\] max_threads >= 12 and max_depth >= 2, then rerun muster install codex\./
  );
});
