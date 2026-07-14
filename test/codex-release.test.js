import { test } from "node:test";
import { createHash } from "node:crypto";
import { execFile as execFileCb } from "node:child_process";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import {
  assertRegularTree,
  publishCodexRelease,
  resolveCodexRelease,
  resolveCodexReleaseWithOptions,
  validateCodexRelease
} from "../src/codex-release.js";
import { readSelectedAsset, resolveCodexRelease as resolveCachedRelease } from "../codex/bootstrap/resolve-release.mjs";

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

const bootstrapPayload = { format: 1, files: [] };
const execFile = promisify(execFileCb);
const TEST_BOOTSTRAP_DIGEST = createHash("sha256").update(JSON.stringify(bootstrapPayload)).digest("hex");
const publish = options => publishCodexRelease({ allowBootstrapMigration: true, bootstrapDigest: TEST_BOOTSTRAP_DIGEST, ...options });

function fakeLeaseClock(start = Date.now() - 6 * 60 * 1000) {
  let current = start, heartbeat = null;
  const timer = { unref() {} };
  return {
    options: {
      now: () => current,
      setInterval: callback => { heartbeat = callback; return timer; },
      clearInterval: () => { heartbeat = null; },
      addExitListener() {},
      removeExitListener() {}
    },
    async advance(milliseconds) {
      current += milliseconds;
      assert.equal(typeof heartbeat, "function", "lease heartbeat was not scheduled");
      await heartbeat();
    }
  };
}

async function tempRepo(t) {
  const root = await mkdtemp(join(tmpdir(), "muster-codex-release-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, ".agents", "plugins"), { recursive: true });
  await write(join(root, ".agents", "plugins", "bootstrap", "muster", "bootstrap.json"), JSON.stringify({
    ...bootstrapPayload,
    digest: TEST_BOOTSTRAP_DIGEST
  }, null, 2) + "\n");
  await write(join(root, ".agents", "plugins", "marketplace.json"), JSON.stringify({
    name: "muster",
    plugins: [{ name: "muster", source: { source: "local", path: "./.agents/plugins/plugins/muster" } }]
  }, null, 2) + "\n");
  return root;
}

test("published Codex release resolves one content-addressed plugin/profile generation", async t => {
  const root = await tempRepo(t);
  const published = await publish({ repoRoot: root, stagedRelease: await candidate(root, "one"), packageVersion: "0.5.0" });
  assert.match(published.generation, /^[a-f0-9]{64}$/);
  assert.equal(published.releaseRoot, join(root, ".agents", "plugins", "releases", published.generation));
  const selected = await resolveCodexRelease(root);
  assert.equal(selected.generation, published.generation);
  assert.equal(await readFile(join(selected.pluginRoot, "runtime", "muster.mjs"), "utf8"), 'export const generation = "one";\n');
  assert.equal(await readFile(join(selected.profilesRoot, "muster-builder.toml"), "utf8"), 'name = "muster-builder"\ngeneration = "one"\n');
  assert.equal((await validateCodexRelease(selected.releaseRoot, selected.generation)).generation, selected.generation);
});

test("release resolver rejects traversal and Windows-shaped bootstrap paths", async t => {
  const root = await tempRepo(t);
  await publish({ repoRoot: root, stagedRelease: await candidate(root, "safe"), packageVersion: "0.5.0" });
  const pointerPath = join(root, ".agents", "plugins", "marketplace.json");
  const original = JSON.parse(await readFile(pointerPath, "utf8"));
  for (const path of ["../../outside/plugin", "C:\\outside\\plugin", "\\\\server\\share\\plugin"]) {
    const pointer = structuredClone(original);
    pointer.plugins[0].source.path = path;
    await writeFile(pointerPath, JSON.stringify(pointer));
    await assert.rejects(resolveCodexRelease(root), /bootstrap contract/i, path);
  }
});

test("release validation rejects an external-target symlink without reading it", async t => {
  const root = await tempRepo(t);
  const release = await candidate(root, "symlink");
  const outside = join(root, "outside.txt");
  await writeFile(outside, "secret");
  await symlink(outside, join(release, "plugin", "skills", "muster", "escape.md"));
  await assert.rejects(assertRegularTree(release), /symlink|regular file/i);
  await assert.rejects(publish({ repoRoot: root, stagedRelease: release, packageVersion: "0.5.0" }), /symlink|regular file/i);
  assert.match(await readFile(join(root, ".agents", "plugins", "marketplace.json"), "utf8"), /plugins\/muster/);
});

test("publication rejects a symlink already present in the live release tree", async t => {
  const root = await tempRepo(t);
  await publish({ repoRoot: root, stagedRelease: await candidate(root, "old"), packageVersion: "0.5.0" });
  const pointerPath = join(root, ".agents", "plugins", "marketplace.json");
  const before = await readFile(pointerPath, "utf8");
  const outside = join(root, "outside-live");
  await mkdir(outside);
  await symlink(outside, join(root, ".agents", "plugins", "releases", "escape"));
  await assert.rejects(publish({ repoRoot: root, stagedRelease: await candidate(root, "new"), packageVersion: "0.5.0" }), /symlink|regular file/i);
  assert.equal(await readFile(pointerPath, "utf8"), before);
});

test("release publication rejects symlinked repository ancestry without touching external victims", async t => {
  const tmp = await mkdtemp(join(tmpdir(), "muster-codex-release-ancestry-"));
  t.after(() => rm(tmp, { recursive: true, force: true }));
  for (const level of [".agents", "plugins", "releases", "marketplace.json"]) {
    const root = join(tmp, level.replaceAll(".", "-")), outside = join(tmp, `${level.replaceAll(".", "-")}-outside`);
    await mkdir(root, { recursive: true });
    const pointer = JSON.stringify({ name: "muster", plugins: [{ name: "muster", source: { source: "local", path: "./legacy" } }] }, null, 2) + "\n";
    if (level === ".agents") {
      await mkdir(join(outside, "plugins"), { recursive: true });
      await write(join(outside, "plugins", "marketplace.json"), pointer);
      await symlink(outside, join(root, ".agents"));
    } else if (level === "plugins") {
      await mkdir(join(root, ".agents"), { recursive: true });
      await mkdir(outside, { recursive: true });
      await write(join(outside, "marketplace.json"), pointer);
      await symlink(outside, join(root, ".agents", "plugins"));
    } else if (level === "releases") {
      await mkdir(join(root, ".agents", "plugins"), { recursive: true });
      await write(join(root, ".agents", "plugins", "marketplace.json"), pointer);
      await mkdir(outside, { recursive: true });
      await write(join(outside, "sentinel.txt"), "keep\n");
      await symlink(outside, join(root, ".agents", "plugins", "releases"));
    } else {
      await mkdir(join(root, ".agents", "plugins"), { recursive: true });
      await write(outside, pointer);
      await symlink(outside, join(root, ".agents", "plugins", "marketplace.json"));
    }
    const before = level === "releases" ? await readFile(join(outside, "sentinel.txt"), "utf8") : await readFile(level === "marketplace.json" ? outside : join(outside, level === ".agents" ? "plugins/marketplace.json" : "marketplace.json"), "utf8");
    await assert.rejects(publish({ repoRoot: root, stagedRelease: await candidate(root, `attack-${level}`), packageVersion: "0.5.0" }), /symlink|ordinary|regular/i, level);
    const after = level === "releases" ? await readFile(join(outside, "sentinel.txt"), "utf8") : await readFile(level === "marketplace.json" ? outside : join(outside, level === ".agents" ? "plugins/marketplace.json" : "marketplace.json"), "utf8");
    assert.equal(after, before, level);
  }
});

test("release publication rejects special-file-shaped pointer and release ancestors", async t => {
  const root = await tempRepo(t);
  await rm(join(root, ".agents", "plugins", "marketplace.json"));
  await mkdir(join(root, ".agents", "plugins", "marketplace.json"));
  await assert.rejects(publish({ repoRoot: root, stagedRelease: await candidate(root, "bad-pointer"), packageVersion: "0.5.0" }), /regular file/i);

  await rm(join(root, ".agents", "plugins", "marketplace.json"), { recursive: true });
  await write(join(root, ".agents", "plugins", "marketplace.json"), JSON.stringify({ name: "muster", plugins: [{ name: "muster", source: { source: "local", path: "./legacy" } }] }));
  await rm(join(root, ".agents", "plugins", "releases"), { recursive: true, force: true });
  await write(join(root, ".agents", "plugins", "releases"), "not a directory\n");
  await assert.rejects(publish({ repoRoot: root, stagedRelease: await candidate(root, "bad-releases"), packageVersion: "0.5.0" }), /ordinary directory|regular directory/i);
});

test("pointer swap failure keeps the prior coherent generation selected", async t => {
  const root = await tempRepo(t);
  const first = await publish({ repoRoot: root, stagedRelease: await candidate(root, "old"), packageVersion: "0.5.0" });
  await assert.rejects(publish({
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
  const oldRelease = await publish({ repoRoot: root, stagedRelease: await candidate(root, "old"), packageVersion: "0.5.0" });
  const stableMarketplace = await readFile(join(root, ".agents", "plugins", "marketplace.json"), "utf8");
  let releaseSwap;
  const gate = new Promise(resolve => { releaseSwap = resolve; });
  const publishing = publish({
    repoRoot: root,
    stagedRelease: await candidate(root, "new"),
    packageVersion: "0.5.0",
    replacePointer: async (source, destination) => { await gate; await rename(source, destination); }
  });
  const snapshots = new Set();
  for (let i = 0; i < 100; i++) {
    if (i === 50) releaseSwap();
    const selected = await resolveCodexRelease(root);
    assert.equal(await readFile(join(root, ".agents", "plugins", "marketplace.json"), "utf8"), stableMarketplace);
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

test("selection retries transient failures and falls back to complete bootstrap or prior generations", async t => {
  const root = await tempRepo(t);
  const old = await publish({ repoRoot: root, stagedRelease: await candidate(root, "old"), packageVersion: "0.5.0" });
  const next = await publish({ repoRoot: root, stagedRelease: await candidate(root, "new"), packageVersion: "0.5.0" });
  const selections = join(root, ".agents", "plugins", "selections");
  let attempts = 0;
  const retried = await resolveCodexReleaseWithOptions(root, { readSelections: async () => {
    attempts++;
    if (attempts < 3) { const error = new Error("injected v9fs denial"); error.code = attempts === 1 ? "ENOENT" : "EACCES"; throw error; }
    return readdir(selections);
  } });
  assert.equal(retried.generation, next.generation);
  const fallback = await resolveCodexReleaseWithOptions(root, { retries: 2, readSelections: async () => {
    const error = new Error("persistent injected v9fs denial"); error.code = "EACCES"; throw error;
  } });
  assert.equal(fallback.generation, old.generation);

  const newest = (await readdir(selections)).sort().at(-1);
  await writeFile(join(selections, newest), "{corrupt\n");
  assert.equal((await resolveCodexRelease(root)).generation, old.generation);
});

test("selector scan skips symlink and FIFO records without following or blocking", { skip: process.platform === "win32" }, async t => {
  const root = await tempRepo(t);
  const old = await publish({ repoRoot: root, stagedRelease: await candidate(root, "old-special"), packageVersion: "0.5.0" });
  await publish({ repoRoot: root, stagedRelease: await candidate(root, "new-special"), packageVersion: "0.5.0" });
  const selections = join(root, ".agents", "plugins", "selections"), outside = join(root, "outside-selector.json");
  await writeFile(outside, JSON.stringify({ format: 1, sequence: 999999999999, generation: old.generation, bootstrapDigest: TEST_BOOTSTRAP_DIGEST }));
  await execFile("mkfifo", [join(selections, `999999999998-${old.generation}.json`)]);
  await symlink(outside, join(selections, `999999999999-${old.generation}.json`));
  const started = Date.now(), selected = await resolveCodexRelease(root);
  assert.ok(Date.now() - started < 2_000, "FIFO selector blocked resolution");
  assert.notEqual(selected.generation, undefined);
  assert.equal(await readFile(outside, "utf8"), JSON.stringify({ format: 1, sequence: 999999999999, generation: old.generation, bootstrapDigest: TEST_BOOTSTRAP_DIGEST }));
});

test("release retention preserves an actively leased generation and reclaims its stale lease", async t => {
  const root = await tempRepo(t);
  await publish({ repoRoot: root, stagedRelease: await candidate(root, "g1"), packageVersion: "0.5.0" });
  const g2 = await publish({ repoRoot: root, stagedRelease: await candidate(root, "g2"), packageVersion: "0.5.0" });
  assert.equal((await resolveCodexRelease(root)).generation, g2.generation);
  await publish({ repoRoot: root, stagedRelease: await candidate(root, "g3"), packageVersion: "0.5.0" });
  await publish({ repoRoot: root, stagedRelease: await candidate(root, "g4"), packageVersion: "0.5.0" });
  assert.ok((await readdir(join(root, ".agents", "plugins", "releases"))).includes(g2.generation), "active g2 was garbage-collected by g4");
  const lease = join(root, ".agents", "plugins", "leases", g2.generation, `${process.pid}.json`);
  const stale = JSON.parse(await readFile(lease, "utf8"));
  stale.processStartedAt = 0;
  stale.touchedAt = 0;
  await writeFile(lease, JSON.stringify(stale));
  await publish({ repoRoot: root, stagedRelease: await candidate(root, "g5"), packageVersion: "0.5.0" });
  assert.equal((await readdir(join(root, ".agents", "plugins", "releases"))).includes(g2.generation), false, "stale leased generation was not reclaimed");
  assert.ok((await readdir(join(root, ".agents", "plugins", "releases"))).length <= 3);
});

test("parallel source resolution writes one collision-safe generation lease", async t => {
  const root = await tempRepo(t);
  const published = await publish({ repoRoot: root, stagedRelease: await candidate(root, "parallel-lease"), packageVersion: "0.5.0" });
  const selected = await Promise.all(Array.from({ length: 128 }, () => resolveCodexRelease(root)));
  assert.ok(selected.every(item => item.generation === published.generation));
  const leases = await readdir(join(root, ".agents", "plugins", "leases", published.generation));
  assert.deepEqual(leases, [`${process.pid}.json`]);
});

test("source resolver renews a generation lease beyond five minutes and releases it explicitly", async t => {
  const root = await tempRepo(t), clock = fakeLeaseClock();
  await publish({ repoRoot: root, stagedRelease: await candidate(root, "source-long-g1"), packageVersion: "0.5.0" });
  const leased = await publish({ repoRoot: root, stagedRelease: await candidate(root, "source-long-g2"), packageVersion: "0.5.0" });
  const selected = await resolveCodexReleaseWithOptions(root, { lease: clock.options });
  assert.equal(selected.generation, leased.generation);
  await clock.advance(6 * 60 * 1000);
  await publish({ repoRoot: root, stagedRelease: await candidate(root, "source-long-g3"), packageVersion: "0.5.0" });
  await publish({ repoRoot: root, stagedRelease: await candidate(root, "source-long-g4"), packageVersion: "0.5.0" });
  assert.ok((await readdir(join(root, ".agents", "plugins", "releases"))).includes(leased.generation), "renewed source lease did not retain its generation");
  await selected.lease.close();
  assert.deepEqual(await readdir(join(root, ".agents", "plugins", "leases", leased.generation)), []);
});

test("cached resolver revalidates an asset at the point of use", async t => {
  const root = await tempRepo(t);
  await publish({ repoRoot: root, stagedRelease: await candidate(root, "cache-point-of-use"), packageVersion: "0.5.0" });
  const selected = await resolveCachedRelease(root);
  const skill = join(selected.pluginRoot, "skills", "muster", "SKILL.md");
  await writeFile(skill, "ATTACKER-CONTROLLED-SKILL-AFTER-VALIDATION\n");
  await assert.rejects(readSelectedAsset(selected, "plugin/skills/muster/SKILL.md"), /changed after release validation/);
});

test("parallel cached resolution writes collision-safe lease temporaries", async t => {
  const root = await tempRepo(t);
  const published = await publish({ repoRoot: root, stagedRelease: await candidate(root, "cache-parallel-lease"), packageVersion: "0.5.0" });
  const selected = await Promise.all(Array.from({ length: 128 }, () => resolveCachedRelease(root)));
  assert.ok(selected.every(item => item.generation === published.generation));
});

test("cached resolver renews a generation lease beyond five minutes and releases it explicitly", async t => {
  const root = await tempRepo(t), clock = fakeLeaseClock();
  await publish({ repoRoot: root, stagedRelease: await candidate(root, "cache-long-g1"), packageVersion: "0.5.0" });
  const leased = await publish({ repoRoot: root, stagedRelease: await candidate(root, "cache-long-g2"), packageVersion: "0.5.0" });
  const selected = await resolveCachedRelease(root, { lease: clock.options });
  assert.equal(selected.generation, leased.generation);
  await clock.advance(6 * 60 * 1000);
  await publish({ repoRoot: root, stagedRelease: await candidate(root, "cache-long-g3"), packageVersion: "0.5.0" });
  await publish({ repoRoot: root, stagedRelease: await candidate(root, "cache-long-g4"), packageVersion: "0.5.0" });
  assert.ok((await readdir(join(root, ".agents", "plugins", "releases"))).includes(leased.generation), "renewed cached lease did not retain its generation");
  await selected.lease.close();
  assert.deepEqual(await readdir(join(root, ".agents", "plugins", "leases", leased.generation)), []);
});

test("divergent publishers serialize selection and pruning as one transaction", async t => {
  const root = await tempRepo(t);
  await publish({ repoRoot: root, stagedRelease: await candidate(root, "initial"), packageVersion: "0.5.0" });
  let active = 0, maxActive = 0;
  const replacePointer = async (source, destination) => {
    active++;
    maxActive = Math.max(maxActive, active);
    await new Promise(resolve => setTimeout(resolve, 25));
    try { await rename(source, destination); } finally { active--; }
  };
  const [left, right] = await Promise.all([
    publish({ repoRoot: root, stagedRelease: await candidate(root, "divergent-left"), packageVersion: "0.5.0", replacePointer }),
    publish({ repoRoot: root, stagedRelease: await candidate(root, "divergent-right"), packageVersion: "0.5.0", replacePointer })
  ]);
  assert.equal(maxActive, 1, "publisher critical sections overlapped");
  for (const published of [left, right]) assert.equal((await validateCodexRelease(published.releaseRoot, published.generation)).generation, published.generation);
  const names = (await readdir(join(root, ".agents", "plugins", "selections"))).sort();
  assert.equal(new Set(names.map(name => name.slice(0, 12))).size, names.length, "selector sequences collided");
  assert.ok([left.generation, right.generation].includes((await resolveCodexRelease(root)).generation));
});

test("publication reclaims a crashed stale writer lock", async t => {
  const root = await tempRepo(t), lock = join(root, ".agents", "plugins", ".publication.lock");
  await writeFile(lock, JSON.stringify({ format: 1, pid: 99999999, processIdentity: "dead", createdAt: 0, token: "crashed" }));
  const old = new Date(Date.now() - 20 * 60 * 1000);
  await utimes(lock, old, old);
  const result = await publish({ repoRoot: root, stagedRelease: await candidate(root, "after-crash"), packageVersion: "0.5.0" });
  assert.equal((await resolveCodexRelease(root)).generation, result.generation);
  await assert.rejects(readFile(lock, "utf8"));
});

test("normal publication fails closed on bootstrap surface drift with maintenance guidance", async t => {
  const root = await tempRepo(t);
  await publish({ repoRoot: root, stagedRelease: await candidate(root, "old"), packageVersion: "0.5.0", bootstrapDigest: "a".repeat(64) });
  const marketplace = await readFile(join(root, ".agents", "plugins", "marketplace.json"), "utf8");
  await assert.rejects(publishCodexRelease({
    repoRoot: root,
    stagedRelease: await candidate(root, "drift"),
    packageVersion: "0.5.0",
    bootstrapDigest: "c".repeat(64)
  }), /surface drift.*offline bootstrap maintenance.*restart/i);
  assert.equal(await readFile(join(root, ".agents", "plugins", "marketplace.json"), "utf8"), marketplace);
});
