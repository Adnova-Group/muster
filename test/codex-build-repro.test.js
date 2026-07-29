import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile as execFileCb } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { CODEX_BUILD_INPUT_DIRS, computeCodexBuildInputDigest, publishCodexPlugin, resolveCodexPlugin } from "../src/codex-release.js";

const execFile = promisify(execFileCb);
const repoRoot = new URL("../", import.meta.url).pathname;
// Single-sourced with computeCodexBuildInputDigest's own declared input set
// (src/codex-release.js) plus package.json, so this fixture list can never
// silently drift from what the skip-if-current check actually hashes.
const fixtureEntries = [...CODEX_BUILD_INPUT_DIRS, "package.json"];
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
  const markerPath = join(first.pluginRoot, "package.json");
  const mtimeBeforeSecondCall = (await stat(markerPath)).mtimeMs;
  // buildCodexPlugin is idempotent (skips regeneration entirely when the
  // published plugin's stored input digest already matches the current
  // inputs -- codex-bundle-cache-key fix), so a second build call is expected
  // to be a genuine skip here, not merely a regeneration that happens to
  // reproduce the same bytes. Proven two ways: the bundle content is
  // unchanged (below) AND the published package.json marker's mtime is
  // untouched (immediately below) -- a real regeneration always rewrites that
  // file via publishCodexPlugin's retire-then-copy, so an unchanged mtime is
  // only possible if the build was skipped outright.
  await execFile(process.execPath, ["scripts/build-codex.mjs"], { cwd: checkout, timeout: 90_000 });
  assert.equal((await stat(markerPath)).mtimeMs, mtimeBeforeSecondCall, "an unchanged-input second build call must skip regeneration outright, not just reproduce identical bytes");
  const second = await resolveCodexPlugin(checkout);
  assert.equal(await readFile(join(second.pluginRoot, "runtime", "muster.mjs"), "utf8"), firstBundle);
  assert.ok(second.inputDigest, "the published plugin must carry a stored input digest");
  assert.equal(second.inputDigest, first.inputDigest);
  // The staging directory used during the build must never survive it.
  assert.deepEqual((await readdir(join(checkout, ".agents", "plugins"))).filter(name => name.startsWith(".muster-build-")), []);
});

test("editing one plugin skill file -- with the version left unbumped -- triggers regeneration on the next build (the codex-bundle-cache-key incident scenario)", async t => {
  const tmp = await mkdtemp(join(tmpdir(), "muster-codex-edit-regen-"));
  t.after(() => rm(tmp, { recursive: true, force: true }));
  const checkout = join(tmp, "checkout");
  await mkdir(checkout, { recursive: true });
  await Promise.all(fixtureEntries.map(entry => cp(join(repoRoot, entry), join(checkout, entry), { recursive: true })));
  await symlink(await realpath(join(repoRoot, "node_modules")), join(checkout, "node_modules"), "dir");
  await execFile(process.execPath, ["scripts/build-codex.mjs"], { cwd: checkout, timeout: 90_000 });
  const first = await resolveCodexPlugin(checkout);
  const generatedAdvisorPath = join(first.pluginRoot, "internal-skills", "advisor", "SKILL.md");
  const marker = "MUSTER-TEST-MARKER-codex-bundle-cache-key";
  assert.ok(!(await readFile(generatedAdvisorPath, "utf8")).includes(marker), "sanity: the marker must not already be present in the first build");

  // Edit a real generation-input source file -- a fixture-copy plugin skill,
  // per the incident's own reproduction -- WITHOUT bumping package.json's
  // version. This is the exact bug: the old version-only skip check would
  // never observe this edit and would keep serving the stale first build.
  const sourceSkillPath = join(checkout, "plugin", "skills", "advisor", "SKILL.md");
  await writeFile(sourceSkillPath, `${await readFile(sourceSkillPath, "utf8")}\n${marker}\n`);
  const versionBefore = JSON.parse(await readFile(join(checkout, "package.json"), "utf8")).version;

  await execFile(process.execPath, ["scripts/build-codex.mjs"], { cwd: checkout, timeout: 90_000 });
  const second = await resolveCodexPlugin(checkout);
  assert.equal(JSON.parse(await readFile(join(checkout, "package.json"), "utf8")).version, versionBefore, "sanity: this test must never bump the version -- that is the whole point");
  assert.notEqual(second.inputDigest, first.inputDigest, "the stored input digest must change when a generation input is edited");
  assert.ok(
    (await readFile(join(second.pluginRoot, "internal-skills", "advisor", "SKILL.md"), "utf8")).includes(marker),
    "the edited source content must reach the regenerated bundle -- the second build must not have been skipped"
  );
});

test("Codex build rejects source symlinks -- even with an unbumped version, via the input-content digest -- and leaves the already-published plugin unchanged", async t => {
  const tmp = await mkdtemp(join(tmpdir(), "muster-codex-symlink-"));
  t.after(() => rm(tmp, { recursive: true, force: true }));
  const checkout = join(tmp, "checkout");
  await mkdir(checkout, { recursive: true });
  await Promise.all(fixtureEntries.map(entry => cp(join(repoRoot, entry), join(checkout, entry), { recursive: true })));
  await symlink(await realpath(join(repoRoot, "node_modules")), join(checkout, "node_modules"), "dir");
  await execFile(process.execPath, ["scripts/build-codex.mjs"], { cwd: checkout, timeout: 90_000 });
  const before = await readFile(join(checkout, ".agents", "plugins", "marketplace.json"), "utf8");
  await symlink(join(tmp, "external"), join(checkout, "plugin", "skills", "advisor", "escape"));
  // codex-bundle-cache-key incident fix, proven directly: buildCodexPlugin's
  // skip-if-current check now computes a fresh input digest (which walks
  // every generation-input tree, including plugin/) BEFORE deciding to skip,
  // so this second call -- with package.json's version deliberately left
  // UNCHANGED -- still re-walks the now symlink-tainted plugin/ tree and
  // rejects, rather than silently no-op-skipping on a version match the way
  // the pre-fix version-only check would have (which never re-walked source
  // at all and never rejected anything here).
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

test("buildCodexPlugin's input-digest skip-if-current check can be bypassed with MUSTER_BUILD_FORCE=1", async t => {
  const { buildCodexPlugin } = await import("../scripts/build-codex.mjs");
  const tmp = await mkdtemp(join(tmpdir(), "muster-codex-force-"));
  t.after(() => rm(tmp, { recursive: true, force: true }));
  const root = join(tmp, "root"), outDir = join(tmp, "plugins");
  await mkdir(root, { recursive: true });
  // A minimal but GENUINE input tree -- one empty directory per declared
  // generation-input entry, which is all computeCodexBuildInputDigest needs
  // to walk and hash -- rather than the expensive real esbuild generation
  // this synthetic root cannot support anyway. It deliberately carries none
  // of buildCodexPluginOnce's actual file content, which is exactly what
  // proves whether the force flag attempted a real rebuild below.
  await Promise.all(CODEX_BUILD_INPUT_DIRS.map(dir => mkdir(join(root, dir), { recursive: true })));
  const packageVersion = "9.9.9-force-test";
  await writeFile(join(root, "package.json"), JSON.stringify({ version: packageVersion }));
  const inputDigest = await computeCodexBuildInputDigest(root);
  // Fabricate an already-published plugin whose version AND input digest
  // match root directly via publishCodexPlugin, rather than running the
  // real (slow) esbuild generation.
  const staged = join(tmp, "staged");
  await mkdir(join(staged, "skills"), { recursive: true });
  await mkdir(join(staged, ".codex-plugin"), { recursive: true });
  await writeFile(join(staged, "package.json"), JSON.stringify({ version: packageVersion, inputDigest }));
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
    assert.equal(cached.packageVersion, packageVersion, "an unforced call with a matching input digest must return the cached publish without attempting real generation");
    assert.equal(cached.inputDigest, inputDigest);

    process.env.MUSTER_BUILD_FORCE = "1";
    await assert.rejects(
      buildCodexPlugin({ root, outDir }),
      /ENOENT/i,
      "MUSTER_BUILD_FORCE=1 must bypass the input-digest skip and attempt a real rebuild, which fails fast against this synthetic root's empty source directories"
    );
  } finally {
    delete process.env.MUSTER_BUILD_FORCE;
  }
});

test("buildCodexPlugin never treats a stale bundle as fresh: a published plugin whose stored input digest disagrees with current inputs is not selected, even with a matching version", async t => {
  const { buildCodexPlugin } = await import("../scripts/build-codex.mjs");
  const tmp = await mkdtemp(join(tmpdir(), "muster-codex-stale-digest-"));
  t.after(() => rm(tmp, { recursive: true, force: true }));
  const root = join(tmp, "root"), outDir = join(tmp, "plugins");
  await mkdir(root, { recursive: true });
  await Promise.all(CODEX_BUILD_INPUT_DIRS.map(dir => mkdir(join(root, dir), { recursive: true })));
  const packageVersion = "9.9.9-stale-digest-test";
  await writeFile(join(root, "package.json"), JSON.stringify({ version: packageVersion }));
  const currentInputDigest = await computeCodexBuildInputDigest(root);

  // Publish a plugin at the SAME version but stamped with a digest that does
  // NOT match root's actual current inputs -- this is exactly the incident
  // scenario replayed mechanically: a bundle generated from different source
  // content than what is on disk right now, at an unchanged version. This is
  // the mutant-kill for the codex-bundle-cache-key regression: a reverted,
  // version-only comparison would happily return this stale publish (version
  // matches); the input-digest comparison must not.
  const staged = join(tmp, "staged");
  await mkdir(join(staged, "skills"), { recursive: true });
  await mkdir(join(staged, ".codex-plugin"), { recursive: true });
  const staleInputDigest = `stale-${currentInputDigest.slice(8)}`;
  assert.notEqual(staleInputDigest, currentInputDigest);
  await writeFile(join(staged, "package.json"), JSON.stringify({ version: packageVersion, inputDigest: staleInputDigest }));
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

  delete process.env.MUSTER_BUILD_FORCE;
  await assert.rejects(
    buildCodexPlugin({ root, outDir }),
    /ENOENT/i,
    "a digest-mismatched published plugin must never be selected as fresh -- an unforced call must attempt real regeneration despite the matching version"
  );
});

test("buildCodexPlugin regenerates (never crashes or false-skips) a plugin published before this fix, which stored no input digest at all", async t => {
  const { buildCodexPlugin } = await import("../scripts/build-codex.mjs");
  const tmp = await mkdtemp(join(tmpdir(), "muster-codex-no-digest-"));
  t.after(() => rm(tmp, { recursive: true, force: true }));
  const root = join(tmp, "root"), outDir = join(tmp, "plugins");
  await mkdir(root, { recursive: true });
  await Promise.all(CODEX_BUILD_INPUT_DIRS.map(dir => mkdir(join(root, dir), { recursive: true })));
  const packageVersion = "9.9.9-no-digest-test";
  await writeFile(join(root, "package.json"), JSON.stringify({ version: packageVersion }));

  // Every plugin published before this fix shipped has a package.json with
  // ONLY `version` -- no `inputDigest` key at all. resolveCodexPluginOnce's
  // pass-through must surface that as `inputDigest: undefined`, which must
  // never equal a freshly computed digest string and so must never false-skip.
  const staged = join(tmp, "staged");
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

  delete process.env.MUSTER_BUILD_FORCE;
  await assert.rejects(
    buildCodexPlugin({ root, outDir }),
    /ENOENT/i,
    "a pre-fix plugin with no stored input digest must trigger regeneration, not a crash or a false skip"
  );
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
  // mismatch (name, then version) must make buildCodexPlugin's skip-if-current
  // check treat the published plugin as needing REGENERATION rather than
  // up-to-date -- resolution itself rejects a mislabeled identity before the
  // input-digest comparison is ever reached. Regeneration is proven the same way the force-flag
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

test("build-anchor-audit: rewording review-gate/SKILL.md's reviewer-selection prose past what the wording-tolerant anchor tolerates fails the Codex build loud instead of silently shipping the stale Claude-side prose", async t => {
  const tmp = await mkdtemp(join(tmpdir(), "muster-codex-anchor-reword-"));
  t.after(() => rm(tmp, { recursive: true, force: true }));
  const checkout = join(tmp, "checkout");
  await mkdir(checkout, { recursive: true });
  await Promise.all(fixtureEntries.map(entry => cp(join(repoRoot, entry), join(checkout, entry), { recursive: true })));
  await symlink(await realpath(join(repoRoot, "node_modules")), join(checkout, "node_modules"), "dir");

  // The mutation: reword review-gate/SKILL.md's step-1 reviewer-selection opening -- in this
  // fixture checkout only, never the real repo file -- past what the anchor's wording-tolerant
  // regex (scripts/build-codex.mjs's selectReviewersRe) tolerates. This is the SAME anchor class
  // as the review-gate fix-cap bug (PR #158 reworded the source, PR #159 added the fail-loud
  // regex this audit item's OTHER review-gate anchors were given the identical posture for) --
  // proving one of those siblings actually catches an equivalent rewording, not just that it
  // compiles.
  const reviewGateSkillPath = join(checkout, "plugin", "skills", "review-gate", "SKILL.md");
  const original = await readFile(reviewGateSkillPath, "utf8");
  const anchorOpening = "1. **Select reviewers, scaled by diff size.**";
  assert.ok(original.includes(anchorOpening), "sanity: the fixture carries the pre-reword anchor text");
  const reworded = original.replace(anchorOpening, "1. **Pick your reviewer crew based on how big the diff is.**");
  assert.notEqual(reworded, original, "sanity: the rewording actually changed the file");
  await writeFile(reviewGateSkillPath, reworded);

  // The kill: the reworded input-digest differs from anything ever published for this fixture, so
  // this call always attempts real regeneration (never a skip) and must fail loud, not silently
  // ship the pre-reword (now-stale) Claude-side prose into the Codex bundle.
  await assert.rejects(
    execFile(process.execPath, ["scripts/build-codex.mjs"], { cwd: checkout, timeout: 90_000 }),
    /review-gate select-reviewers anchor not found for Codex rewrite/,
    "a reviewer-selection rewording past the tolerant regex must throw the named error, not silently ship stale prose"
  );
});
