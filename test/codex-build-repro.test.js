import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile as execFileCb } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { publishCodexPlugin, resolveCodexPlugin } from "../src/codex-release.js";

const execFile = promisify(execFileCb);
const repoRoot = new URL("../", import.meta.url).pathname;
const fixtureEntries = ["catalog", "codex", "cowork", "pipelines", "plugin", "scripts", "src", "vendor", "package.json"];
const bundles = ["runtime/muster.mjs", "runtime/muster-mcp.mjs"];

async function buildCheckout(checkout, sharedNodeModules) {
  await mkdir(checkout, { recursive: true });
  await Promise.all(fixtureEntries.map(entry => cp(join(repoRoot, entry), join(checkout, entry), { recursive: true })));
  await symlink(sharedNodeModules, join(checkout, "node_modules"), "dir");
  await execFile("node", ["scripts/build-codex.mjs"], { cwd: checkout, timeout: 90_000, maxBuffer: 4 * 1024 * 1024 });
  const { pluginRoot: plugin } = await resolveCodexPlugin(checkout);
  return Object.fromEntries(await Promise.all(bundles.map(async path => [path, await readFile(join(plugin, path), "utf8")])));
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

test("repeated Codex build produces byte-identical bundles from unchanged source", async t => {
  const tmp = await mkdtemp(join(tmpdir(), "muster-codex-repeat-"));
  t.after(() => rm(tmp, { recursive: true, force: true }));
  const checkout = join(tmp, "checkout");
  await mkdir(checkout, { recursive: true });
  await Promise.all(fixtureEntries.map(entry => cp(join(repoRoot, entry), join(checkout, entry), { recursive: true })));
  await symlink(await realpath(join(repoRoot, "node_modules")), join(checkout, "node_modules"), "dir");
  await execFile(process.execPath, ["scripts/build-codex.mjs"], { cwd: checkout, timeout: 90_000 });
  const first = await resolveCodexPlugin(checkout);
  const firstBundle = await readFile(join(first.pluginRoot, "runtime", "muster.mjs"), "utf8");
  // buildCodexPlugin is idempotent (skips regeneration when already current),
  // so a second build call is expected to be a fast no-op here — the point of
  // this test is that its result is unchanged, whether or not it regenerated.
  await execFile(process.execPath, ["scripts/build-codex.mjs"], { cwd: checkout, timeout: 90_000 });
  const second = await resolveCodexPlugin(checkout);
  assert.equal(await readFile(join(second.pluginRoot, "runtime", "muster.mjs"), "utf8"), firstBundle);
  // The staging directory used during the build must never survive it.
  assert.deepEqual((await readdir(join(checkout, ".agents", "plugins"))).filter(name => name.startsWith(".muster-build-")), []);
});

test("Codex build rejects source symlinks and leaves the already-published plugin unchanged", async t => {
  const tmp = await mkdtemp(join(tmpdir(), "muster-codex-symlink-"));
  t.after(() => rm(tmp, { recursive: true, force: true }));
  const checkout = join(tmp, "checkout");
  await mkdir(checkout, { recursive: true });
  await Promise.all(fixtureEntries.map(entry => cp(join(repoRoot, entry), join(checkout, entry), { recursive: true })));
  await symlink(await realpath(join(repoRoot, "node_modules")), join(checkout, "node_modules"), "dir");
  await execFile(process.execPath, ["scripts/build-codex.mjs"], { cwd: checkout, timeout: 90_000 });
  const before = await readFile(join(checkout, ".agents", "plugins", "marketplace.json"), "utf8");
  await symlink(join(tmp, "external"), join(checkout, "plugin", "skills", "advisor", "escape"));
  // buildCodexPlugin's idempotent skip-if-current check only compares
  // package.json's version against the already-published plugin (a known,
  // documented limitation — see its docblock), so an unmodified version
  // would make this second call a no-op that never re-walks the (now
  // symlink-tainted) source tree at all, and never reject anything. Bump
  // the version to force a genuine rebuild attempt, which is what actually
  // exercises assertRegularTree's symlink rejection.
  const pkgPath = join(checkout, "package.json");
  const pkg = JSON.parse(await readFile(pkgPath, "utf8"));
  await writeFile(pkgPath, JSON.stringify({ ...pkg, version: `${pkg.version}-symlink-test` }));
  await assert.rejects(execFile(process.execPath, ["scripts/build-codex.mjs"], { cwd: checkout, timeout: 90_000 }), /symlink|regular file/i);
  assert.equal(await readFile(join(checkout, ".agents", "plugins", "marketplace.json"), "utf8"), before);
  assert.deepEqual((await readdir(join(checkout, ".agents", "plugins"))).filter(name => name.startsWith(".muster-build-")), []);
});

test("Codex build writes nothing outside its gitignored staging directory that git would see", async t => {
  const tmp = await mkdtemp(join(tmpdir(), "muster-codex-clean-tree-"));
  t.after(() => rm(tmp, { recursive: true, force: true }));
  const checkout = join(tmp, "checkout");
  await mkdir(checkout, { recursive: true });
  await Promise.all(fixtureEntries.map(entry => cp(join(repoRoot, entry), join(checkout, entry), { recursive: true })));
  await symlink(await realpath(join(repoRoot, "node_modules")), join(checkout, "node_modules"), "dir");
  const before = new Set(await readdir(checkout));
  await execFile(process.execPath, ["scripts/build-codex.mjs"], { cwd: checkout, timeout: 90_000 });
  const after = new Set(await readdir(checkout));
  after.delete(".agents");
  assert.deepEqual(after, before, "the build must only ever create the gitignored .agents/ staging directory");
});

test("buildCodexPlugin's version-only skip-if-current check can be bypassed with MUSTER_BUILD_FORCE=1", async t => {
  const { buildCodexPlugin } = await import("../scripts/build-codex.mjs");
  const tmp = await mkdtemp(join(tmpdir(), "muster-codex-force-"));
  t.after(() => rm(tmp, { recursive: true, force: true }));
  const root = join(tmp, "root"), outDir = join(tmp, "plugins");
  await mkdir(root, { recursive: true });
  const packageVersion = "9.9.9-force-test";
  await writeFile(join(root, "package.json"), JSON.stringify({ version: packageVersion }));
  // Fabricate an already-published plugin whose version matches root's
  // package.json directly via publishCodexPlugin, rather than running the
  // real (slow) esbuild generation this synthetic root cannot support
  // anyway — it deliberately has none of the real source directories
  // buildCodexPluginOnce needs, which is exactly what proves whether the
  // force flag actually attempted a real rebuild below.
  const staged = join(tmp, "staged");
  await mkdir(join(staged, "skills"), { recursive: true });
  await mkdir(join(staged, ".codex-plugin"), { recursive: true });
  await writeFile(join(staged, "package.json"), JSON.stringify({ version: packageVersion }));
  // publishCodexPlugin's pre-publication contract check reads the staged
  // manifest, so this synthetic staged tree must carry a coherent one (the
  // real build always writes it — scripts/build-codex.mjs).
  await writeFile(join(staged, ".codex-plugin", "plugin.json"), JSON.stringify({ name: "muster", version: packageVersion }));
  await publishCodexPlugin({
    pluginsRoot: outDir,
    stagedPlugin: staged,
    packageVersion,
    marketplaceTemplate: {
      name: "muster",
      interface: { displayName: "Muster" },
      // path is a placeholder; publishCodexPlugin overwrites it with codexMarketplacePluginPath(pluginsRoot).
      plugins: [{ name: "muster", source: { source: "local", path: "./plugin" }, category: "Productivity" }]
    }
  });

  try {
    delete process.env.MUSTER_BUILD_FORCE;
    const cached = await buildCodexPlugin({ root, outDir });
    assert.equal(cached.packageVersion, packageVersion, "an unforced call with a matching version must return the cached publish without attempting real generation");

    process.env.MUSTER_BUILD_FORCE = "1";
    await assert.rejects(
      buildCodexPlugin({ root, outDir }),
      /tree root is missing/i,
      "MUSTER_BUILD_FORCE=1 must bypass the version-only skip and attempt a real rebuild, which fails fast against this synthetic root's missing source directories"
    );
  } finally {
    delete process.env.MUSTER_BUILD_FORCE;
  }
});

test("buildCodexPlugin regenerates (does not same-version-skip) when the published plugin's identity is mislabeled", async t => {
  const { buildCodexPlugin } = await import("../scripts/build-codex.mjs");
  const tmp = await mkdtemp(join(tmpdir(), "muster-codex-mislabel-"));
  t.after(() => rm(tmp, { recursive: true, force: true }));
  const root = join(tmp, "root");
  await mkdir(root, { recursive: true });
  const packageVersion = "9.9.9-identity-test";
  await writeFile(join(root, "package.json"), JSON.stringify({ version: packageVersion }));

  // Publish a coherent plugin at the matching version (as the force-flag test
  // above does), then MISLABEL its published .codex-plugin/plugin.json. Each
  // mismatch (name, then version) must make buildCodexPlugin's version-only
  // same-version skip treat the published plugin as needing REGENERATION
  // rather than up-to-date. Regeneration is proven the same way the force-flag
  // test proves a real rebuild was attempted: this synthetic root has none of
  // the real source directories, so a genuine rebuild fails fast with "tree
  // root is missing". A same-version SKIP would instead return the cached
  // publish with no error — which is exactly the bug.
  const mislabels = [
    { name: "not-muster", version: packageVersion },              // manifest name != "muster"
    { name: "muster", version: "0.0.0-manifest-disagrees" }        // manifest version != package version
  ];
  delete process.env.MUSTER_BUILD_FORCE;
  for (const manifest of mislabels) {
    const outDir = join(tmp, `plugins-${manifest.name}-${manifest.version}`);
    const staged = join(tmp, `staged-${manifest.name}-${manifest.version}`);
    await mkdir(join(staged, "skills"), { recursive: true });
    await mkdir(join(staged, ".codex-plugin"), { recursive: true });
    await writeFile(join(staged, "package.json"), JSON.stringify({ version: packageVersion }));
    await writeFile(join(staged, ".codex-plugin", "plugin.json"), JSON.stringify({ name: "muster", version: packageVersion }));
    await publishCodexPlugin({
      pluginsRoot: outDir,
      stagedPlugin: staged,
      packageVersion,
      marketplaceTemplate: {
        name: "muster",
        interface: { displayName: "Muster" },
        plugins: [{ name: "muster", source: { source: "local", path: "./plugin" }, category: "Productivity" }]
      }
    });
    // Mislabel the PUBLISHED manifest after the publish contract check has run.
    await writeFile(join(outDir, "plugin", ".codex-plugin", "plugin.json"), JSON.stringify(manifest));
    await assert.rejects(
      buildCodexPlugin({ root, outDir }),
      /tree root is missing/i,
      `a mislabeled published manifest (${JSON.stringify(manifest)}) must trigger regeneration, not a same-version skip`
    );
  }
});

test("overlapping Codex builders serialize and both leave a fully coherent plugin", { skip: process.platform === "win32" }, async t => {
  const tmp = await mkdtemp(join(tmpdir(), "muster-codex-overlap-"));
  t.after(() => rm(tmp, { recursive: true, force: true }));
  const checkout = join(tmp, "checkout");
  await mkdir(checkout, { recursive: true });
  await Promise.all(fixtureEntries.map(entry => cp(join(repoRoot, entry), join(checkout, entry), { recursive: true })));
  await symlink(await realpath(join(repoRoot, "node_modules")), join(checkout, "node_modules"), "dir");
  await Promise.all([
    execFile(process.execPath, ["scripts/build-codex.mjs"], { cwd: checkout, timeout: 90_000 }),
    execFile(process.execPath, ["scripts/build-codex.mjs"], { cwd: checkout, timeout: 90_000 })
  ]);
  const selected = await resolveCodexPlugin(checkout);
  await readFile(join(selected.pluginRoot, "runtime", "muster.mjs"), "utf8");
  assert.deepEqual((await readdir(join(checkout, ".agents", "plugins"))).filter(name => name.startsWith(".muster-build-") || name.startsWith(".muster-retired-")), []);
});
