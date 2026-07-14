import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile as execFileCb, spawn } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFile = promisify(execFileCb);
const repoRoot = new URL("../", import.meta.url).pathname;
const fixtureEntries = ["catalog", "codex", "cowork", "pipelines", "plugin", "scripts", "src", "vendor", "package.json"];
const bundles = ["runtime/muster.mjs", "src/cli.js", "runtime/muster-mcp.mjs"];

async function buildCheckout(checkout, sharedNodeModules) {
  await mkdir(checkout, { recursive: true });
  await Promise.all(fixtureEntries.map(entry => cp(join(repoRoot, entry), join(checkout, entry), { recursive: true })));
  await symlink(sharedNodeModules, join(checkout, "node_modules"), "dir");
  await execFile("node", ["scripts/build-codex.mjs"], { cwd: checkout, timeout: 30_000, maxBuffer: 4 * 1024 * 1024 });
  const plugin = join(checkout, ".agents", "plugins", "plugins", "muster");
  return Object.fromEntries(await Promise.all(bundles.map(async path => [path, await readFile(join(plugin, path), "utf8")] )));
}

test("Codex bundles are byte-identical across checkout roots with shared symlinked dependencies", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "muster-codex-repro-"));
  try {
    const sharedNodeModules = await realpath(join(repoRoot, "node_modules"));
    const [shallow, nested] = await Promise.all([
      buildCheckout(join(tmp, "shallow"), sharedNodeModules),
      buildCheckout(join(tmp, "nested", "checkout"), sharedNodeModules)
    ]);
    for (const path of bundles) assert.equal(nested[path], shallow[path], `${path} depends on checkout location`);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test("Codex rebuild keeps every published skill readable for concurrent inventory scans", async t => {
  const tmp = await mkdtemp(join(repoRoot, ".codex-race-"));
  t.after(() => rm(tmp, { recursive: true, force: true }));
  const checkout = join(tmp, "checkout");
  await mkdir(checkout, { recursive: true });
  await Promise.all(fixtureEntries.map(entry => cp(join(repoRoot, entry), join(checkout, entry), { recursive: true })));
  await symlink(await realpath(join(repoRoot, "node_modules")), join(checkout, "node_modules"), "dir");
  await execFile(process.execPath, ["scripts/build-codex.mjs"], { cwd: checkout, timeout: 30_000, maxBuffer: 4 * 1024 * 1024 });
  const sourceAdvisor = join(checkout, "plugin", "skills", "advisor", "SKILL.md");
  await writeFile(sourceAdvisor, `${await readFile(sourceAdvisor, "utf8")}\nChanged while the published plugin remains live.\n`);

  const skillRoot = join(checkout, ".agents", "plugins", "plugins", "muster", "skills");
  const skillFiles = (await readdir(skillRoot, { withFileTypes: true }))
    .filter(entry => entry.isDirectory())
    .map(entry => join(skillRoot, entry.name, "SKILL.md"));
  assert.ok(skillFiles.length > 70, "fixture must exercise the full published skill inventory");

  const child = spawn(process.execPath, ["scripts/build-codex.mjs"], { cwd: checkout, stdio: ["ignore", "pipe", "pipe"] });
  let finished = false;
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", chunk => { stderr += chunk; });
  const completion = new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", code => {
      finished = true;
      if (code === 0) resolve(); else reject(new Error(stderr || `build exited ${code}`));
    });
  });

  const missing = new Set();
  while (!finished) {
    const reads = await Promise.allSettled(skillFiles.map(path => readFile(path, "utf8")));
    reads.forEach((result, index) => {
      if (result.status === "rejected" || !result.value.startsWith("---\n")) missing.add(skillFiles[index]);
    });
    await new Promise(resolve => setImmediate(resolve));
  }
  await completion;
  assert.deepEqual([...missing], [], "a live Codex inventory scan observed missing SKILL.md files during rebuild");
  assert.match(await readFile(join(skillRoot, "advisor", "SKILL.md"), "utf8"), /Changed while the published plugin remains live/);
});
