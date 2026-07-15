import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile as execFileCb, spawn } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { resolveCodexRelease } from "../src/codex-release.js";

const execFile = promisify(execFileCb);
const repoRoot = new URL("../", import.meta.url).pathname;
const fixtureEntries = ["catalog", "codex", "cowork", "pipelines", "plugin", "scripts", "src", "vendor", "package.json"];
const bundles = ["runtime/muster.mjs", "src/cli.js", "runtime/muster-mcp.mjs"];

const readJson = async path => JSON.parse(await readFile(path, "utf8"));

async function buildCheckout(checkout, sharedNodeModules) {
  await mkdir(checkout, { recursive: true });
  await Promise.all(fixtureEntries.map(entry => cp(join(repoRoot, entry), join(checkout, entry), { recursive: true })));
  await symlink(sharedNodeModules, join(checkout, "node_modules"), "dir");
  await execFile("node", ["scripts/build-codex.mjs"], { cwd: checkout, timeout: 90_000, maxBuffer: 4 * 1024 * 1024 });
  const { pluginRoot: plugin } = await resolveCodexRelease(checkout);
  return Object.fromEntries(await Promise.all(bundles.map(async path => [path, await readFile(join(plugin, path), "utf8")] )));
}

async function selectedSnapshot(checkout) {
  const selected = await resolveCodexRelease(checkout);
  const generation = selected.generation;
  const release = selected.releaseRoot;
  const paths = [
    "plugin/runtime/muster.mjs",
    "plugin/commands/audit.md",
    "plugin/internal-skills/advisor/SKILL.md",
    "profiles/muster-builder.toml"
  ];
  return { generation, files: await Promise.all(paths.map(path => readFile(join(release, path), "utf8"))) };
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

test("Codex rebuild exposes only exact old or new immutable generation snapshots", async t => {
  const tmp = await mkdtemp(join(repoRoot, ".codex-race-"));
  t.after(() => rm(tmp, { recursive: true, force: true }));
  const checkout = join(tmp, "checkout");
  await mkdir(checkout, { recursive: true });
  await Promise.all(fixtureEntries.map(entry => cp(join(repoRoot, entry), join(checkout, entry), { recursive: true })));
  await symlink(await realpath(join(repoRoot, "node_modules")), join(checkout, "node_modules"), "dir");
  await execFile(process.execPath, ["scripts/build-codex.mjs"], { cwd: checkout, timeout: 90_000, maxBuffer: 4 * 1024 * 1024 });
  const oldSnapshot = await selectedSnapshot(checkout);
  const stableBootstrap = await readFile(join(checkout, ".agents", "plugins", "bootstrap", "muster", "bootstrap.json"), "utf8");
  const sourceAdvisor = join(checkout, "plugin", "skills", "advisor", "SKILL.md");
  await writeFile(sourceAdvisor, `${await readFile(sourceAdvisor, "utf8")}\nChanged while the published plugin remains live.\n`);

  const child = spawn(process.execPath, ["scripts/build-codex.mjs"], { cwd: checkout, stdio: ["ignore", "ignore", "pipe"] });
  let stderr = "";
  let closed = false;
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", chunk => { stderr += chunk; });
  const completion = new Promise((resolve, reject) => {
    child.on("error", error => {
      closed = true;
      reject(error);
    });
    child.on("exit", code => {
      if (code !== 0) reject(new Error(stderr || `build exited ${code}`));
    });
    child.on("close", code => {
      closed = true;
      code === 0 ? resolve() : reject(new Error(stderr || `build closed ${code}`));
    });
  });

  const observed = [];
  while (!closed) {
    observed.push(await selectedSnapshot(checkout));
    assert.equal(await readFile(join(checkout, ".agents", "plugins", "bootstrap", "muster", "bootstrap.json"), "utf8"), stableBootstrap);
    await new Promise(resolve => setImmediate(resolve));
  }
  await completion;
  const newSnapshot = await selectedSnapshot(checkout);
  assert.notEqual(newSnapshot.generation, oldSnapshot.generation);
  assert.match(newSnapshot.files[2], /Changed while the published plugin remains live/);
  for (const snapshot of observed) {
    assert.ok(
      (snapshot.generation === oldSnapshot.generation && JSON.stringify(snapshot.files) === JSON.stringify(oldSnapshot.files)) ||
      (snapshot.generation === newSnapshot.generation && JSON.stringify(snapshot.files) === JSON.stringify(newSnapshot.files)),
      "reader observed a partial or mixed generation"
    );
  }
  await resolveCodexRelease(checkout);
  assert.deepEqual((await readdir(join(checkout, ".agents", "plugins"))).filter(name => name.startsWith(".muster-build-")), []);
  assert.doesNotMatch(await readFile(join(checkout, "scripts", "build-codex.mjs"), "utf8"), /--exchange|publishTreeAtomically/);
});

test("Codex build rejects source symlinks and leaves the selected release unchanged", async t => {
  const tmp = await mkdtemp(join(tmpdir(), "muster-codex-symlink-"));
  t.after(() => rm(tmp, { recursive: true, force: true }));
  const checkout = join(tmp, "checkout");
  await mkdir(checkout, { recursive: true });
  await Promise.all(fixtureEntries.map(entry => cp(join(repoRoot, entry), join(checkout, entry), { recursive: true })));
  await symlink(await realpath(join(repoRoot, "node_modules")), join(checkout, "node_modules"), "dir");
  await execFile(process.execPath, ["scripts/build-codex.mjs"], { cwd: checkout, timeout: 90_000 });
  const before = await readFile(join(checkout, ".agents", "plugins", "marketplace.json"), "utf8");
  await symlink(join(tmp, "external"), join(checkout, "plugin", "skills", "advisor", "escape"));
  await assert.rejects(execFile(process.execPath, ["scripts/build-codex.mjs"], { cwd: checkout, timeout: 90_000 }), /symlink|regular file/i);
  assert.equal(await readFile(join(checkout, ".agents", "plugins", "marketplace.json"), "utf8"), before);
  assert.deepEqual((await readdir(join(checkout, ".agents", "plugins"))).filter(name => name.startsWith(".muster-build-")), []);
});

test("repeated Codex build reuses the same immutable generation", async t => {
  const tmp = await mkdtemp(join(tmpdir(), "muster-codex-repeat-"));
  t.after(() => rm(tmp, { recursive: true, force: true }));
  const checkout = join(tmp, "checkout");
  await mkdir(checkout, { recursive: true });
  await Promise.all(fixtureEntries.map(entry => cp(join(repoRoot, entry), join(checkout, entry), { recursive: true })));
  await symlink(await realpath(join(repoRoot, "node_modules")), join(checkout, "node_modules"), "dir");
  const stale = join(checkout, ".agents", "plugins", ".muster-build-stale");
  await mkdir(stale, { recursive: true });
  await writeFile(join(stale, "abandoned.txt"), "stale\n");
  const old = new Date(Date.now() - 10 * 60 * 1000);
  await utimes(stale, old, old);
  await execFile(process.execPath, ["scripts/build-codex.mjs"], { cwd: checkout, timeout: 90_000, env: { ...process.env, MUSTER_CODEX_BUILD_LEASE_STALE_MS: "1000" } });
  await assert.rejects(readFile(join(stale, "abandoned.txt"), "utf8"));
  const first = await selectedSnapshot(checkout);
  await execFile(process.execPath, ["scripts/build-codex.mjs"], { cwd: checkout, timeout: 90_000 });
  const second = await selectedSnapshot(checkout);
  assert.deepEqual(second, first);
});

test("Codex build synchronizes project profiles and hooks to the selected release contract", async t => {
  const tmp = await mkdtemp(join(tmpdir(), "muster-codex-project-parity-"));
  t.after(() => rm(tmp, { recursive: true, force: true }));
  const checkout = join(tmp, "checkout");
  await mkdir(checkout, { recursive: true });
  await Promise.all(fixtureEntries.map(entry => cp(join(repoRoot, entry), join(checkout, entry), { recursive: true })));
  await symlink(await realpath(join(repoRoot, "node_modules")), join(checkout, "node_modules"), "dir");
  await execFile(process.execPath, ["scripts/build-codex.mjs"], { cwd: checkout, timeout: 30_000 });

  const selected = await resolveCodexRelease(checkout);
  const marketplace = await readJson(join(checkout, ".agents", "plugins", "marketplace.json"));
  const profileManifest = await readJson(join(checkout, ".codex", "agents", ".muster-managed.json"));
  const hookManifest = await readJson(join(checkout, ".codex", "muster", ".muster-managed.json"));
  assert.equal(profileManifest.generation, selected.generation);
  assert.equal(hookManifest.generation, selected.generation);
  assert.equal(profileManifest.bootstrapDigest, marketplace.musterBootstrap.digest);
  assert.equal(hookManifest.bootstrapDigest, marketplace.musterBootstrap.digest);
  for (const name of profileManifest.files) {
    assert.equal(await readFile(join(checkout, ".codex", "agents", name), "utf8"), await readFile(join(selected.profilesRoot, name), "utf8"), name);
  }
  for (const name of hookManifest.files) {
    assert.equal(await readFile(join(checkout, ".codex", "muster", name), "utf8"), await readFile(join(selected.pluginRoot, "runtime", "install-hooks", name.replace(/^hooks\//, "")), "utf8"), name);
  }

  const hook = await readFile(join(checkout, ".codex", "muster", "hooks", "muster-hook.mjs"), "utf8");
  const policy = JSON.parse(hook.match(/\/\* read-only-agent-policy: (\[.*\]) \*\//)?.[1] || "null");
  const readOnlyProfiles = [];
  for (const name of profileManifest.files) {
    if ((await readFile(join(selected.profilesRoot, name), "utf8")).includes('sandbox_mode = "read-only"')) readOnlyProfiles.push(name.slice(0, -5));
  }
  assert.deepEqual(policy, readOnlyProfiles.sort(), "hook policy must be generated from the selected profile sandboxes");
});

test("Codex checker rejects project parity drift and the inactive legacy plugin tree", async t => {
  const tmp = await mkdtemp(join(tmpdir(), "muster-codex-check-parity-"));
  t.after(() => rm(tmp, { recursive: true, force: true }));
  const checkout = join(tmp, "checkout");
  await mkdir(checkout, { recursive: true });
  await Promise.all(fixtureEntries.map(entry => cp(join(repoRoot, entry), join(checkout, entry), { recursive: true })));
  await symlink(await realpath(join(repoRoot, "node_modules")), join(checkout, "node_modules"), "dir");
  await execFile(process.execPath, ["scripts/build-codex.mjs"], { cwd: checkout, timeout: 30_000 });
  await execFile(process.execPath, ["scripts/check-codex.mjs"], { cwd: checkout, timeout: 30_000 });

  const selected = await resolveCodexRelease(checkout);
  const profile = join(checkout, ".codex", "agents", "muster-builder.toml");
  const profileBytes = await readFile(profile, "utf8");
  await writeFile(profile, `${profileBytes}# stale\n`);
  await assert.rejects(execFile(process.execPath, ["scripts/check-codex.mjs"], { cwd: checkout, timeout: 30_000 }), /project profile .* stale/i);
  await writeFile(profile, profileBytes);

  const manifestPath = join(checkout, ".codex", "agents", ".muster-managed.json");
  const manifest = await readJson(manifestPath);
  await writeFile(manifestPath, JSON.stringify({ ...manifest, generation: "0".repeat(64) }, null, 2) + "\n");
  await assert.rejects(execFile(process.execPath, ["scripts/check-codex.mjs"], { cwd: checkout, timeout: 30_000 }), /project profile manifest .* generation\/bootstrap/i);
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + "\n");

  await mkdir(join(checkout, ".agents", "plugins", "plugins", "muster"), { recursive: true });
  await writeFile(join(checkout, ".agents", "plugins", "plugins", "muster", "package.json"), "{}\n");
  await assert.rejects(execFile(process.execPath, ["scripts/check-codex.mjs"], { cwd: checkout, timeout: 30_000 }), /inactive legacy plugin tree/i);

  assert.equal(selected.generation, manifest.generation);
});

test("overlapping Codex builders preserve active stages and reclaim only stale crashed stages", { skip: process.platform === "win32" }, async t => {
  const tmp = await mkdtemp(join(tmpdir(), "muster-codex-overlap-"));
  t.after(() => rm(tmp, { recursive: true, force: true }));
  const checkout = join(tmp, "checkout");
  await mkdir(checkout, { recursive: true });
  await Promise.all(fixtureEntries.map(entry => cp(join(repoRoot, entry), join(checkout, entry), { recursive: true })));
  await symlink(await realpath(join(repoRoot, "node_modules")), join(checkout, "node_modules"), "dir");
  const first = spawn(process.execPath, ["scripts/build-codex.mjs"], { cwd: checkout, stdio: ["ignore", "pipe", "pipe"] });
  let activeStage;
  for (let attempt = 0; attempt < 200; attempt++) {
    const names = await readdir(join(checkout, ".agents", "plugins")).catch(() => []);
    activeStage = names.find(name => name.startsWith(".muster-build-"));
    if (activeStage && await readFile(join(checkout, ".agents", "plugins", activeStage, ".lease.json"), "utf8").catch(() => null)) break;
    await new Promise(done => setTimeout(done, 10));
  }
  assert.ok(activeStage, "first builder did not publish its lease");
  process.kill(first.pid, "SIGSTOP");
  try {
    await execFile(process.execPath, ["scripts/build-codex.mjs"], { cwd: checkout, timeout: 90_000, env: { ...process.env, MUSTER_CODEX_BUILD_LEASE_STALE_MS: "1000" } });
    assert.ok((await readdir(join(checkout, ".agents", "plugins"))).includes(activeStage), "second builder removed the live first stage");
  } finally { process.kill(first.pid, "SIGCONT"); }
  await new Promise((resolve, reject) => first.once("close", code => code === 0 ? resolve() : reject(new Error(`first builder exited ${code}`))));
});
