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
import { withCodexFileLock } from "../src/codex-lock.js";

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

function leaseRuntime() {
  let added = 0, removed = 0, cleared = 0;
  return {
    options: {
      setInterval: () => ({ unref() {} }),
      clearInterval: () => { cleared++; },
      addExitListener: () => { added++; },
      removeExitListener: () => { removed++; }
    },
    counts: () => ({ added, removed, cleared })
  };
}

async function freshModule(relativePath, label) {
  return import(`${new URL(relativePath, import.meta.url).href}?${label}-${Date.now()}-${Math.random()}`);
}

async function assertNamespaceSafeLeases(t, { label, load, resolve }) {
  const root = await tempRepo(t);
  const published = await publish({ repoRoot: root, stagedRelease: await candidate(root, `${label}-namespace`), packageVersion: "0.5.0" });
  const [leftModule, rightModule] = await Promise.all([load(`${label}-left`), load(`${label}-right`)]);
  const left = await resolve(leftModule, root, leaseRuntime().options);
  const right = await resolve(rightModule, root, leaseRuntime().options);
  const leases = (await readdir(join(root, ".agents", "plugins", "leases", published.generation))).sort();
  assert.equal(leases.length, 2, `${label} resolver collapsed independent same-PID lease owners`);
  assert.notEqual(leases[0], leases[1]);
  await left.lease.close();
  await right.lease.close();
}

async function assertBoundedLeaseListeners(t, { label, load, resolve }) {
  const runtime = leaseRuntime(), selected = [];
  const module = await load(`${label}-listener-controller`);
  for (let index = 0; index < 12; index++) {
    const root = await tempRepo(t);
    await publish({ repoRoot: root, stagedRelease: await candidate(root, `${label}-listener-${index}`), packageVersion: "0.5.0" });
    selected.push(await resolve(module, root, runtime.options));
  }
  assert.equal(runtime.counts().added, 1, `${label} resolver accumulated process exit listeners`);
  await Promise.all(selected.map(item => item.lease.close()));
  assert.deepEqual(runtime.counts(), { added: 1, removed: 1, cleared: 12 });
}

const wait = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

async function assertAtomicPublishVsRenew(t, { label, resolve }) {
  const root = await tempRepo(t);
  await publish({ repoRoot: root, stagedRelease: await candidate(root, `${label}-atomic-g1`), packageVersion: "0.5.0" });
  await publish({ repoRoot: root, stagedRelease: await candidate(root, `${label}-atomic-g2`), packageVersion: "0.5.0" });
  let staged;
  const replacementStaged = new Promise(resolve => { staged = resolve; });
  let continueReplacement;
  const replacementMayContinue = new Promise(resolve => { continueReplacement = resolve; });
  const selected = await resolve(root, {
    lease: {
      ...leaseRuntime().options,
      replaceLease: async (temporary, destination) => {
        staged();
        await replacementMayContinue;
        await rename(temporary, destination);
      }
    }
  });
  const original = JSON.parse(await readFile(selected.lease.path, "utf8"));
  const renewing = selected.lease.renew();
  const didStage = await Promise.race([replacementStaged.then(() => true), wait(100).then(() => false)]);
  assert.equal(didStage, true, `${label} renewal did not stage an atomic replacement`);
  assert.deepEqual(JSON.parse(await readFile(selected.lease.path, "utf8")), original, `${label} renewal exposed a truncated live lease`);
  let published = false;
  const publishing = publish({ repoRoot: root, stagedRelease: await candidate(root, `${label}-atomic-g3`), packageVersion: "0.5.0" }).then(result => { published = true; return result; });
  await wait(20);
  assert.equal(published, false, `${label} publisher scanned a lease while its renewal transaction was active`);
  continueReplacement();
  await renewing;
  await publishing;
  await selected.lease.close();
}

async function assertCleanupPreservesReplacement(t, { label, resolve }) {
  const root = await tempRepo(t);
  await publish({ repoRoot: root, stagedRelease: await candidate(root, `${label}-cleanup`), packageVersion: "0.5.0" });
  let cleanupCalls = 0;
  const selected = await resolve(root, {
    lease: {
      ...leaseRuntime().options,
      beforeLeaseCleanup: async ({ path }) => {
        cleanupCalls++;
        await writeFile(path, JSON.stringify({ token: "replacement-owner", preserved: true }) + "\n");
      }
    }
  });
  await selected.lease.close();
  assert.equal(cleanupCalls, 1, `${label} cleanup was not identity-revalidated before deletion`);
  assert.deepEqual(JSON.parse(await readFile(selected.lease.path, "utf8")), { token: "replacement-owner", preserved: true });
}

async function assertCrashedLifecycleLockIsReclaimed(t, { label, resolve }) {
  const root = await tempRepo(t);
  await publish({ repoRoot: root, stagedRelease: await candidate(root, `${label}-lifecycle-crash`), packageVersion: "0.5.0" });
  const selected = await resolve(root, { lease: { ...leaseRuntime().options, lifecycleLock: { staleMs: 20, maxStaleMs: 40, timeoutMs: 100 } } });
  const lock = `${selected.lease.path}.lifecycle.lock`;
  await writeFile(lock, JSON.stringify({ format: 1, pid: 99999999, createdAt: 0, token: "crashed" }) + "\n");
  const stale = new Date(Date.now() - 20 * 60 * 1000);
  await utimes(lock, stale, stale);
  await selected.lease.renew();
  await assert.rejects(readFile(lock, "utf8"), `${label} retained a crashed lifecycle lock`);
  await selected.lease.close();
}

async function assertHardExpiredLifecycleLockIsReclaimed(t, { label, resolve }) {
  const root = await tempRepo(t);
  await publish({ repoRoot: root, stagedRelease: await candidate(root, `${label}-lifecycle-expiry`), packageVersion: "0.5.0" });
  const selected = await resolve(root, { lease: { ...leaseRuntime().options, lifecycleLock: { staleMs: 20, maxStaleMs: 40, timeoutMs: 100 } } });
  const owner = JSON.parse(await readFile(selected.lease.path, "utf8"));
  const lock = `${selected.lease.path}.lifecycle.lock`;
  await writeFile(lock, JSON.stringify({ format: 1, pid: process.pid, processIdentity: owner.processIdentity, createdAt: 0, token: "wedged-live-owner" }) + "\n");
  const stale = new Date(Date.now() - 100);
  await utimes(lock, stale, stale);
  await selected.lease.renew();
  await assert.rejects(readFile(lock, "utf8"), `${label} retained a hard-expired lifecycle lock from a live PID`);
  await selected.lease.close();
}

async function assertLeaseRegistrationCannotRacePrune(t, { label, resolve }) {
  const root = await tempRepo(t);
  await publish({ repoRoot: root, stagedRelease: await candidate(root, `${label}-registry-g1`), packageVersion: "0.5.0" });
  const leased = await publish({ repoRoot: root, stagedRelease: await candidate(root, `${label}-registry-g2`), packageVersion: "0.5.0" });
  let scanned, continueScan;
  const scanReached = new Promise(resolveScan => { scanned = resolveScan; });
  const scanMayContinue = new Promise(resolveScan => { continueScan = resolveScan; });
  let selected;
  const publishing = publish({
    repoRoot: root,
    stagedRelease: await candidate(root, `${label}-registry-g3`),
    packageVersion: "0.5.0",
    afterLeaseScan: async ({ selectionName }) => {
      await rm(join(root, ".agents", "plugins", "selections", selectionName));
      scanned();
      await scanMayContinue;
    }
  });
  try {
    assert.equal(await Promise.race([scanReached.then(() => true), wait(100).then(() => false)]), true, `${label} publisher did not expose the scan-to-prune interleaving`);
    const registering = resolve(root, { lease: leaseRuntime().options }).then(result => { selected = result; return result; });
    assert.equal(await Promise.race([registering.then(() => true), wait(30).then(() => false)]), false, `${label} registered a lease after publisher scan but before prune`);
    continueScan();
    await publishing;
    assert.equal((await registering).generation, leased.generation, `${label} did not preserve the generation selected before the publisher barrier`);
  } finally {
    continueScan?.();
    await publishing.catch(() => {});
    await selected?.lease.close();
  }
}

async function assertForeignAndLegacyLeasesAreConservative(t, { label, resolve }) {
  const root = await tempRepo(t);
  await publish({ repoRoot: root, stagedRelease: await candidate(root, `${label}-lease-g1`), packageVersion: "0.5.0" });
  const foreign = await publish({ repoRoot: root, stagedRelease: await candidate(root, `${label}-lease-g2`), packageVersion: "0.5.0" });
  const selected = await resolve(root, { lease: { ...leaseRuntime().options, processNamespace: "foreign-process-namespace" } });
  const foreignRecord = JSON.parse(await readFile(selected.lease.path, "utf8"));
  foreignRecord.processIdentity = "foreign-process-identity";
  await writeFile(selected.lease.path, JSON.stringify(foreignRecord) + "\n");
  await publish({ repoRoot: root, stagedRelease: await candidate(root, `${label}-lease-g3`), packageVersion: "0.5.0" });
  await publish({ repoRoot: root, stagedRelease: await candidate(root, `${label}-lease-g4`), packageVersion: "0.5.0" });
  assert.ok((await readdir(join(root, ".agents", "plugins", "releases"))).includes(foreign.generation), `${label} reclaimed a fresh foreign-namespace lease`);
  const legacy = join(root, ".agents", "plugins", "leases", foreign.generation, "99999999.json");
  await writeFile(legacy, "{transient in-place legacy write\n");
  await publish({ repoRoot: root, stagedRelease: await candidate(root, `${label}-lease-g5`), packageVersion: "0.5.0" });
  assert.ok((await readdir(join(root, ".agents", "plugins", "releases"))).includes(foreign.generation), `${label} reclaimed a fresh legacy lease during an in-place write`);
  const old = new Date(Date.now() - 20 * 60 * 1000);
  await utimes(legacy, old, old);
  await writeFile(selected.lease.path, JSON.stringify({ ...foreignRecord, touchedAt: 0 }) + "\n");
  await publish({ repoRoot: root, stagedRelease: await candidate(root, `${label}-lease-g6`), packageVersion: "0.5.0" });
  assert.equal((await readdir(join(root, ".agents", "plugins", "releases"))).includes(foreign.generation), false, `${label} did not reclaim stale foreign/legacy lease state`);
  await selected.lease.close();
}

async function assertFreshLegacyWriteIsRetainedThenReclaimed(t, label) {
  const root = await tempRepo(t);
  await publish({ repoRoot: root, stagedRelease: await candidate(root, `${label}-legacy-g1`), packageVersion: "0.5.0" });
  const leased = await publish({ repoRoot: root, stagedRelease: await candidate(root, `${label}-legacy-g2`), packageVersion: "0.5.0" });
  const leases = join(root, ".agents", "plugins", "leases", leased.generation);
  await mkdir(leases, { recursive: true });
  const legacy = join(leases, "99999999.json");
  await writeFile(legacy, "{transient in-place legacy write\n");
  await publish({ repoRoot: root, stagedRelease: await candidate(root, `${label}-legacy-g3`), packageVersion: "0.5.0" });
  await publish({ repoRoot: root, stagedRelease: await candidate(root, `${label}-legacy-g4`), packageVersion: "0.5.0" });
  assert.ok((await readdir(join(root, ".agents", "plugins", "releases"))).includes(leased.generation), `${label} reclaimed a fresh legacy lease during an in-place write`);
  const old = new Date(Date.now() - 20 * 60 * 1000);
  await utimes(legacy, old, old);
  await publish({ repoRoot: root, stagedRelease: await candidate(root, `${label}-legacy-g5`), packageVersion: "0.5.0" });
  assert.equal((await readdir(join(root, ".agents", "plugins", "releases"))).includes(leased.generation), false, `${label} did not reclaim the stale legacy lease`);
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

test("successive marketplace swap failures retain the still-advertised generation", async t => {
  const root = await tempRepo(t);
  await publish({ repoRoot: root, stagedRelease: await candidate(root, "bootstrap"), packageVersion: "0.5.0" });
  const advertised = await publish({ repoRoot: root, stagedRelease: await candidate(root, "advertised"), packageVersion: "0.5.0" });
  const failMarketplaceSwap = async (source, destination) => {
    if (destination.endsWith("marketplace.json")) throw new Error("injected marketplace swap failure");
    await rename(source, destination);
  };

  for (const marker of ["orphan", "retry"]) {
    await assert.rejects(publish({
      repoRoot: root,
      stagedRelease: await candidate(root, marker),
      packageVersion: "0.5.0",
      replacePointer: failMarketplaceSwap
    }), /injected marketplace swap failure/);
  }

  const marketplace = JSON.parse(await readFile(join(root, ".agents", "plugins", "marketplace.json"), "utf8"));
  assert.equal(marketplace.plugins[0].source.path, `./.agents/plugins/releases/${advertised.generation}/plugin`);
  assert.equal(await readFile(join(advertised.pluginRoot, "runtime", "muster.mjs"), "utf8"), 'export const generation = "advertised";\n');
  assert.equal((await resolveCodexRelease(root)).generation, advertised.generation);
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
  const finalMarketplace = JSON.parse(await readFile(join(root, ".agents", "plugins", "marketplace.json"), "utf8"));
  assert.equal(finalMarketplace.plugins[0].source.path, `./.agents/plugins/releases/${next.generation}/plugin`);
  assert.notEqual(JSON.stringify(finalMarketplace), stableMarketplace);
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
  const selected = await resolveCodexRelease(root);
  assert.equal(selected.generation, g2.generation);
  await publish({ repoRoot: root, stagedRelease: await candidate(root, "g3"), packageVersion: "0.5.0" });
  await publish({ repoRoot: root, stagedRelease: await candidate(root, "g4"), packageVersion: "0.5.0" });
  assert.ok((await readdir(join(root, ".agents", "plugins", "releases"))).includes(g2.generation), "active g2 was garbage-collected by g4");
  const lease = selected.lease.path;
  const stale = JSON.parse(await readFile(lease, "utf8"));
  stale.processStartedAt = 0;
  stale.touchedAt = 0;
  await writeFile(lease, JSON.stringify(stale));
  await publish({ repoRoot: root, stagedRelease: await candidate(root, "g5"), packageVersion: "0.5.0" });
  assert.equal((await readdir(join(root, ".agents", "plugins", "releases"))).includes(g2.generation), false, "stale leased generation was not reclaimed");
  assert.ok((await readdir(join(root, ".agents", "plugins", "releases"))).length <= 3);
  await selected.lease.close();
});

test("parallel source resolution writes one collision-safe generation lease", async t => {
  const root = await tempRepo(t);
  const published = await publish({ repoRoot: root, stagedRelease: await candidate(root, "parallel-lease"), packageVersion: "0.5.0" });
  const selected = await Promise.all(Array.from({ length: 128 }, () => resolveCodexRelease(root)));
  assert.ok(selected.every(item => item.generation === published.generation));
  const leases = await readdir(join(root, ".agents", "plugins", "leases", published.generation));
  assert.equal(leases.length, 1);
  assert.match(leases[0], new RegExp(`^${process.pid}-[0-9a-f-]{36}\\.json$`));
  await selected[0].lease.close();
});

test("source resolver gives independent same-PID namespaces collision-resistant leases", async t => {
  await assertNamespaceSafeLeases(t, {
    label: "source",
    load: label => freshModule("../src/codex-release.js", label),
    resolve: (module, root, lease) => module.resolveCodexReleaseWithOptions(root, { lease })
  });
});

test("cached resolver gives independent same-PID namespaces collision-resistant leases", async t => {
  await assertNamespaceSafeLeases(t, {
    label: "cached",
    load: label => freshModule("../codex/bootstrap/resolve-release.mjs", label),
    resolve: (module, root, lease) => module.resolveCodexRelease(root, { lease })
  });
});

test("source resolver shares and releases one exit listener for bounded lease controllers", async t => {
  await assertBoundedLeaseListeners(t, {
    label: "source",
    load: label => freshModule("../src/codex-release.js", label),
    resolve: (module, root, lease) => module.resolveCodexReleaseWithOptions(root, { lease })
  });
});

test("cached resolver shares and releases one exit listener for bounded lease controllers", async t => {
  await assertBoundedLeaseListeners(t, {
    label: "cached",
    load: label => freshModule("../codex/bootstrap/resolve-release.mjs", label),
    resolve: (module, root, lease) => module.resolveCodexRelease(root, { lease })
  });
});

test("source renewal atomically retains a live lease while publication waits", async t => {
  await assertAtomicPublishVsRenew(t, {
    label: "source",
    resolve: (root, options) => resolveCodexReleaseWithOptions(root, options)
  });
});

test("cached renewal atomically retains a live lease while publication waits", async t => {
  await assertAtomicPublishVsRenew(t, {
    label: "cached",
    resolve: (root, options) => resolveCachedRelease(root, options)
  });
});

test("source cleanup preserves a replacement lease owner", async t => {
  await assertCleanupPreservesReplacement(t, {
    label: "source",
    resolve: (root, options) => resolveCodexReleaseWithOptions(root, options)
  });
});

test("cached cleanup preserves a replacement lease owner", async t => {
  await assertCleanupPreservesReplacement(t, {
    label: "cached",
    resolve: (root, options) => resolveCachedRelease(root, options)
  });
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

test("source lifecycle lease locks reclaim crashed owners", async t => {
  await assertCrashedLifecycleLockIsReclaimed(t, {
    label: "source",
    resolve: (root, options) => resolveCodexReleaseWithOptions(root, options)
  });
});

test("cached lifecycle lease locks reclaim crashed owners", async t => {
  await assertCrashedLifecycleLockIsReclaimed(t, {
    label: "cached",
    resolve: (root, options) => resolveCachedRelease(root, options)
  });
});

test("cached lifecycle lease locks reclaim live-PID owners after hard expiry", async t => {
  await assertHardExpiredLifecycleLockIsReclaimed(t, {
    label: "cached",
    resolve: (root, options) => resolveCachedRelease(root, options)
  });
});

test("source registration serializes lease creation with publisher scan-to-prune", async t => {
  await assertLeaseRegistrationCannotRacePrune(t, {
    label: "source",
    resolve: (root, options) => resolveCodexReleaseWithOptions(root, options)
  });
});

test("cached registration serializes lease creation with publisher scan-to-prune", async t => {
  await assertLeaseRegistrationCannotRacePrune(t, {
    label: "cached",
    resolve: (root, options) => resolveCachedRelease(root, options)
  });
});

test("source publisher conservatively handles foreign and legacy lease state", async t => {
  await assertForeignAndLegacyLeasesAreConservative(t, {
    label: "source",
    resolve: (root, options) => resolveCodexReleaseWithOptions(root, options)
  });
});

test("cached lease records remain conservative for source publisher pruning", async t => {
  await assertForeignAndLegacyLeasesAreConservative(t, {
    label: "cached",
    resolve: (root, options) => resolveCachedRelease(root, options)
  });
});

test("publisher retains a fresh transient legacy write and reclaims it after bounded age", async t => {
  await assertFreshLegacyWriteIsRetainedThenReclaimed(t, "source");
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

test("publication stale-lock reclaim never deletes a replacement owner", async t => {
  const root = await tempRepo(t), lock = join(root, ".agents", "plugins", ".publication.lock");
  await writeFile(lock, JSON.stringify({ format: 1, pid: 99999999, processIdentity: "dead", createdAt: 0, token: "crashed" }));
  const old = new Date(Date.now() - 20 * 60 * 1000);
  await utimes(lock, old, old);
  const replacement = { format: 1, pid: process.pid, processIdentity: "replacement", createdAt: Date.now(), token: "fresh-owner" };
  let interleaved = false;
  await assert.rejects(withCodexFileLock(lock, async () => {
    throw new Error("replacement owner was bypassed");
  }, {
      timeoutMs: 0,
      afterQuarantine: async () => {
        interleaved = true;
        await writeFile(lock, JSON.stringify(replacement) + "\n", { flag: "wx" });
      }
  }), /timed out waiting for Codex transaction lock/);
  assert.equal(interleaved, true, "test did not interleave a replacement after quarantine");
  assert.equal(JSON.parse(await readFile(lock, "utf8")).token, replacement.token);
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
