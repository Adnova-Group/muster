import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile as execFileCb } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, realpath, rm, symlink } from "node:fs/promises";
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
