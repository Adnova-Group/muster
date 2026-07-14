import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  assertRegularTree,
  publishCodexRelease,
  resolveCodexRelease,
  validateCodexRelease
} from "../src/codex-release.js";

async function write(path, content) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content);
}

async function candidate(root, marker) {
  const release = join(root, `${marker}-candidate`);
  await write(join(release, "plugin", ".codex-plugin", "plugin.json"), JSON.stringify({ name: "muster", version: "0.5.0" }));
  await write(join(release, "plugin", "skills", "muster", "SKILL.md"), `---\nname: muster\ndescription: ${marker}\n---\n\n${marker}\n`);
  await write(join(release, "plugin", "runtime", "muster.mjs"), `export const generation = ${JSON.stringify(marker)};\n`);
  await write(join(release, "profiles", "muster-builder.toml"), `name = "muster-builder"\ngeneration = ${JSON.stringify(marker)}\n`);
  return release;
}

async function tempRepo(t) {
  const root = await mkdtemp(join(tmpdir(), "muster-codex-release-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, ".agents", "plugins"), { recursive: true });
  await write(join(root, ".agents", "plugins", "marketplace.json"), JSON.stringify({
    name: "muster",
    plugins: [{ name: "muster", source: { source: "local", path: "./.agents/plugins/plugins/muster" } }]
  }, null, 2) + "\n");
  return root;
}

test("published Codex release resolves one content-addressed plugin/profile generation", async t => {
  const root = await tempRepo(t);
  const published = await publishCodexRelease({ repoRoot: root, stagedRelease: await candidate(root, "one"), packageVersion: "0.5.0" });
  assert.match(published.generation, /^[a-f0-9]{64}$/);
  assert.equal(published.releaseRoot, join(root, ".agents", "plugins", "releases", published.generation));
  const selected = await resolveCodexRelease(root);
  assert.equal(selected.generation, published.generation);
  assert.equal(await readFile(join(selected.pluginRoot, "runtime", "muster.mjs"), "utf8"), 'export const generation = "one";\n');
  assert.equal(await readFile(join(selected.profilesRoot, "muster-builder.toml"), "utf8"), 'name = "muster-builder"\ngeneration = "one"\n');
  assert.equal((await validateCodexRelease(selected.releaseRoot, selected.generation)).generation, selected.generation);
});

test("release resolver rejects traversal and Windows-shaped absolute pointer paths", async t => {
  const root = await tempRepo(t);
  for (const path of ["../../outside/plugin", "C:\\outside\\plugin", "\\\\server\\share\\plugin"]) {
    const pointer = JSON.parse(await readFile(join(root, ".agents", "plugins", "marketplace.json"), "utf8"));
    pointer.plugins[0].source.path = path;
    pointer.musterRelease = { format: 1, generation: "a".repeat(64), profiles: path.replace(/plugin$/, "profiles"), metadata: path.replace(/plugin$/, "release.json") };
    await writeFile(join(root, ".agents", "plugins", "marketplace.json"), JSON.stringify(pointer));
    await assert.rejects(resolveCodexRelease(root), /relative|contained|release pointer/i, path);
  }
});

test("release validation rejects an external-target symlink without reading it", async t => {
  const root = await tempRepo(t);
  const release = await candidate(root, "symlink");
  const outside = join(root, "outside.txt");
  await writeFile(outside, "secret");
  await symlink(outside, join(release, "plugin", "skills", "muster", "escape.md"));
  await assert.rejects(assertRegularTree(release), /symlink|regular file/i);
  await assert.rejects(publishCodexRelease({ repoRoot: root, stagedRelease: release, packageVersion: "0.5.0" }), /symlink|regular file/i);
  assert.match(await readFile(join(root, ".agents", "plugins", "marketplace.json"), "utf8"), /plugins\/muster/);
});

test("publication rejects a symlink already present in the live release tree", async t => {
  const root = await tempRepo(t);
  await publishCodexRelease({ repoRoot: root, stagedRelease: await candidate(root, "old"), packageVersion: "0.5.0" });
  const pointerPath = join(root, ".agents", "plugins", "marketplace.json");
  const before = await readFile(pointerPath, "utf8");
  const outside = join(root, "outside-live");
  await mkdir(outside);
  await symlink(outside, join(root, ".agents", "plugins", "releases", "escape"));
  await assert.rejects(publishCodexRelease({ repoRoot: root, stagedRelease: await candidate(root, "new"), packageVersion: "0.5.0" }), /symlink|regular file/i);
  assert.equal(await readFile(pointerPath, "utf8"), before);
});

test("pointer swap failure keeps the prior coherent generation selected", async t => {
  const root = await tempRepo(t);
  const first = await publishCodexRelease({ repoRoot: root, stagedRelease: await candidate(root, "old"), packageVersion: "0.5.0" });
  await assert.rejects(publishCodexRelease({
    repoRoot: root,
    stagedRelease: await candidate(root, "new"),
    packageVersion: "0.5.0",
    replacePointer: async () => { throw new Error("injected pointer swap failure"); }
  }), /injected pointer swap failure/);
  const selected = await resolveCodexRelease(root);
  assert.equal(selected.generation, first.generation);
  assert.match(await readFile(join(selected.pluginRoot, "runtime", "muster.mjs"), "utf8"), /"old"/);
  assert.match(await readFile(join(selected.profilesRoot, "muster-builder.toml"), "utf8"), /"old"/);
});

test("concurrent pointer readers observe only exact old or new coherent snapshots", async t => {
  const root = await tempRepo(t);
  const oldRelease = await publishCodexRelease({ repoRoot: root, stagedRelease: await candidate(root, "old"), packageVersion: "0.5.0" });
  let releaseSwap;
  const gate = new Promise(resolve => { releaseSwap = resolve; });
  const publishing = publishCodexRelease({
    repoRoot: root,
    stagedRelease: await candidate(root, "new"),
    packageVersion: "0.5.0",
    replacePointer: async (source, destination) => { await gate; await rename(source, destination); }
  });
  const snapshots = new Set();
  for (let i = 0; i < 100; i++) {
    if (i === 50) releaseSwap();
    const selected = await resolveCodexRelease(root);
    const [runtime, profile] = await Promise.all([
      readFile(join(selected.pluginRoot, "runtime", "muster.mjs"), "utf8"),
      readFile(join(selected.profilesRoot, "muster-builder.toml"), "utf8")
    ]);
    const pluginMarker = runtime.match(/"(old|new)"/)?.[1];
    const profileMarker = profile.match(/"(old|new)"/)?.[1];
    assert.equal(profileMarker, pluginMarker, "mixed plugin/profile generation");
    snapshots.add(`${selected.generation}:${pluginMarker}:${profileMarker}`);
  }
  const next = await publishing;
  assert.deepEqual(snapshots, new Set([
    `${oldRelease.generation}:old:old`,
    `${next.generation}:new:new`
  ]));
});
