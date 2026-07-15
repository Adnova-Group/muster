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

// codex-release.js dropped the source publisher's generation-lease
// reconciliation (afterLeaseScan, activeLeaseGenerations, foreign/legacy
// lease scanning) and its per-reader lease registration/renewal
// (registerGenerationLease, renewLease, removeLease). The bundled cached
// resolver at codex/bootstrap/resolve-release.mjs is a separate, still-owned
// artifact (see codex-cache-package.test.js) that keeps its own independent
// lease implementation for point-of-use asset revalidation; the "cached"
// tests below still exercise that surface and are intentionally unchanged.
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

test("deferred publication keeps the observable pointer stable until process-exit commit", async t => {
  const root = await tempRepo(t);
  const first = await publish({ repoRoot: root, stagedRelease: await candidate(root, "deferred-old"), packageVersion: "0.5.0" });
  const before = await readFile(join(root, ".agents", "plugins", "marketplace.json"), "utf8");
  const next = await publish({
    repoRoot: root,
    stagedRelease: await candidate(root, "deferred-new"),
    packageVersion: "0.5.0",
    deferFinalPointer: true
  });
  assert.equal(await readFile(join(root, ".agents", "plugins", "marketplace.json"), "utf8"), before);
  assert.equal((await resolveCodexRelease(root)).generation, first.generation);
  next.commitPointer();
  assert.equal((await resolveCodexRelease(root)).generation, next.generation);
});

test("deferred publication also stages legacy and bootstrap-maintenance pointer changes", async t => {
  const legacyRoot = await tempRepo(t);
  const legacyBefore = await readFile(join(legacyRoot, ".agents", "plugins", "marketplace.json"), "utf8");
  const legacy = await publish({
    repoRoot: legacyRoot,
    stagedRelease: await candidate(legacyRoot, "deferred-legacy"),
    packageVersion: "0.5.0",
    deferFinalPointer: true
  });
  assert.equal(await readFile(join(legacyRoot, ".agents", "plugins", "marketplace.json"), "utf8"), legacyBefore);
  legacy.commitPointer();
  assert.equal((await resolveCodexRelease(legacyRoot)).generation, legacy.generation);

  const driftRoot = await tempRepo(t);
  await publish({ repoRoot: driftRoot, stagedRelease: await candidate(driftRoot, "drift-old"), packageVersion: "0.5.0" });
  const driftBefore = await readFile(join(driftRoot, ".agents", "plugins", "marketplace.json"), "utf8");
  const drift = await publish({
    repoRoot: driftRoot,
    stagedRelease: await candidate(driftRoot, "drift-new"),
    packageVersion: "0.5.0",
    bootstrapDigest: "c".repeat(64),
    deferFinalPointer: true
  });
  assert.equal(await readFile(join(driftRoot, ".agents", "plugins", "marketplace.json"), "utf8"), driftBefore);
  drift.commitPointer();
  assert.equal(JSON.parse(await readFile(join(driftRoot, ".agents", "plugins", "marketplace.json"), "utf8")).musterBootstrap.digest, "c".repeat(64));
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

test("release retention keeps a bounded current-plus-previous generation window", async t => {
  const root = await tempRepo(t);
  await publish({ repoRoot: root, stagedRelease: await candidate(root, "g1"), packageVersion: "0.5.0" });
  const g2 = await publish({ repoRoot: root, stagedRelease: await candidate(root, "g2"), packageVersion: "0.5.0" });
  const selected = await resolveCodexRelease(root);
  assert.equal(selected.generation, g2.generation);
  assert.equal("lease" in selected, false, "resolveCodexRelease no longer tracks per-reader leases");
  await publish({ repoRoot: root, stagedRelease: await candidate(root, "g3"), packageVersion: "0.5.0" });
  assert.ok((await readdir(join(root, ".agents", "plugins", "releases"))).includes(g2.generation), "the immediately prior generation must survive one more publish");
  const g4 = await publish({ repoRoot: root, stagedRelease: await candidate(root, "g4"), packageVersion: "0.5.0" });
  assert.equal((await readdir(join(root, ".agents", "plugins", "releases"))).includes(g2.generation), false, "an older-than-prior generation must be pruned without per-reader lease tracking");
  assert.ok((await readdir(join(root, ".agents", "plugins", "releases"))).length <= 3);
  assert.equal((await resolveCodexRelease(root)).generation, g4.generation);
});

test("a fresh cached-resolver lease protects its generation through repeated publishes; a stale one does not", async t => {
  const root = await tempRepo(t);
  await publish({ repoRoot: root, stagedRelease: await candidate(root, "lease-protect-g1"), packageVersion: "0.5.0" });
  const g2 = await publish({ repoRoot: root, stagedRelease: await candidate(root, "lease-protect-g2"), packageVersion: "0.5.0" });
  const selected = await resolveCachedRelease(root, { lease: leaseRuntime().options });
  assert.equal(selected.generation, g2.generation);

  await publish({ repoRoot: root, stagedRelease: await candidate(root, "lease-protect-g3"), packageVersion: "0.5.0" });
  await publish({ repoRoot: root, stagedRelease: await candidate(root, "lease-protect-g4"), packageVersion: "0.5.0" });
  assert.ok((await readdir(join(root, ".agents", "plugins", "releases"))).includes(g2.generation),
    "a fresh reader lease must protect its generation beyond the bounded current+previous window across 2+ publishes");

  const old = new Date(Date.now() - 20 * 60 * 1000);
  await utimes(selected.lease.path, old, old);
  await publish({ repoRoot: root, stagedRelease: await candidate(root, "lease-protect-g5"), packageVersion: "0.5.0" });
  assert.equal((await readdir(join(root, ".agents", "plugins", "releases"))).includes(g2.generation), false,
    "a stale lease file must not protect its generation from pruning");

  await selected.lease.close();
});

test("parallel resolution returns one generation without creating lease bookkeeping", async t => {
  const root = await tempRepo(t);
  const published = await publish({ repoRoot: root, stagedRelease: await candidate(root, "parallel-no-lease"), packageVersion: "0.5.0" });
  const selected = await Promise.all(Array.from({ length: 128 }, () => resolveCodexRelease(root)));
  assert.ok(selected.every(item => item.generation === published.generation));
  await assert.rejects(readdir(join(root, ".agents", "plugins", "leases")), "the source resolver must not create a leases directory");
});

test("cached resolver gives independent same-PID namespaces collision-resistant leases", async t => {
  await assertNamespaceSafeLeases(t, {
    label: "cached",
    load: label => freshModule("../codex/bootstrap/resolve-release.mjs", label),
    resolve: (module, root, lease) => module.resolveCodexRelease(root, { lease })
  });
});

test("cached resolver shares and releases one exit listener for bounded lease controllers", async t => {
  await assertBoundedLeaseListeners(t, {
    label: "cached",
    load: label => freshModule("../codex/bootstrap/resolve-release.mjs", label),
    resolve: (module, root, lease) => module.resolveCodexRelease(root, { lease })
  });
});

test("cached cleanup preserves a replacement lease owner", async t => {
  await assertCleanupPreservesReplacement(t, {
    label: "cached",
    resolve: (root, options) => resolveCachedRelease(root, options)
  });
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

// withCodexFileLock's stale-reclaim and live-lock-timeout invariants (the
// dropped quarantine/retirement dance's replacement) are covered directly in
// test/codex-lock.test.js; "publication reclaims a crashed stale writer
// lock" above is this module's integration point with that primitive.

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
