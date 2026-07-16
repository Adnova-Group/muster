// Split from the former test/codex.test.js monolith: the Codex managed-scope
// registry (install-scopes.json) -- shared-plugin retention across scopes
// and projects, orphan pruning, case-normalization reconciliation, and the
// stale-lock reclaim/retirement invariants that replaced the dropped
// quarantine dance (see test/codex-lock.test.js for withCodexFileLock itself).
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, unlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { reconcileScopeRegistryEntries, runCodexInstall, runCodexUninstall } from "../src/codex-install.js";
import { localMusterMarketplace, repoRoot, selectedPluginRoot } from "../test-support/codex-helpers.js";

test("Codex uninstall retains the shared plugin until the final managed scope is removed", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "muster-codex-dual-scope-")), cwd = join(tmp, "project"), home = join(tmp, "home"), calls = [];
  const execFile = async (_bin, args) => {
    calls.push(args.join(" "));
    if (args[0] === "--version") return { stdout: "codex-cli test" };
    if (args.slice(0, 3).join(" ") === "plugin marketplace list") return { stdout: JSON.stringify({ marketplaces: [localMusterMarketplace] }) };
    if (args.slice(0, 3).join(" ") === "plugin list --available") return { stdout: JSON.stringify({ installed: [] }) };
    return { stdout: "" };
  };
  await runCodexInstall({ scope: "project", cwd, home, repoRoot, execFile });
  await runCodexInstall({ scope: "user", cwd, home, repoRoot, execFile });
  calls.length = 0;
  const first = await runCodexUninstall({ scope: "project", cwd, home, execFile });
  assert.equal(first.plugin.retained, true);
  assert.equal(calls.includes("plugin remove muster@muster"), false);
  const last = await runCodexUninstall({ scope: "user", cwd, home, execFile });
  assert.equal(last.plugin.removed, true);
  assert.equal(calls.filter(call => call === "plugin remove muster@muster").length, 1);
});

test("Codex managed-scope registry retains the plugin across multiple projects in either uninstall order", async () => {
  for (const order of [["a", "b"], ["b", "a"]]) {
    const tmp = await mkdtemp(join(tmpdir(), "muster-codex-project-registry-")), home = join(tmp, "home"), calls = [];
    const projects = { a: join(tmp, "project-a"), b: join(tmp, "project-b") };
    const execFile = async (_bin, args) => {
      calls.push(args.join(" "));
      if (args[0] === "--version") return { stdout: "codex-cli test" };
      if (args.slice(0, 3).join(" ") === "plugin marketplace list") return { stdout: JSON.stringify({ marketplaces: [localMusterMarketplace] }) };
      if (args.slice(0, 3).join(" ") === "plugin list --available") return { stdout: JSON.stringify({ installed: [] }) };
      return { stdout: "" };
    };
    await runCodexInstall({ cwd: projects.a, home, repoRoot, execFile });
    await runCodexInstall({ cwd: projects.b, home, repoRoot, execFile });
    calls.length = 0;
    assert.equal((await runCodexUninstall({ cwd: projects[order[0]], home, execFile })).plugin.retained, true);
    assert.equal(calls.includes("plugin remove muster@muster"), false);
    assert.equal((await runCodexUninstall({ cwd: projects[order[1]], home, execFile })).plugin.removed, true);
    assert.equal(calls.filter(call => call === "plugin remove muster@muster").length, 1);
  }
});

test("Codex concurrent installs preserve every managed project owner", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "muster-codex-registry-concurrent-install-"));
  const home = join(tmp, "home"), projects = ["a", "b", "c", "d"].map(name => join(tmp, `project-${name}`));
  const absent = async () => { throw new Error("not found"); };
  await Promise.all(projects.map(cwd => runCodexInstall({ cwd, home, repoRoot: selectedPluginRoot, execFile: absent })));
  const registry = JSON.parse(await readFile(join(home, ".codex", "muster", "install-scopes.json"), "utf8"));
  assert.deepEqual(new Set(registry.entries.map(entry => entry.configDir)), new Set(projects.map(cwd => join(cwd, ".codex"))));
});

test("Codex install prunes install-scopes.json entries whose configDir no longer exists on disk", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "muster-codex-registry-prune-"));
  const home = join(tmp, "home"), keep = join(tmp, "project-keep"), gone = join(tmp, "project-gone");
  const absent = async () => { throw new Error("not found"); };
  await runCodexInstall({ cwd: keep, home, repoRoot, execFile: absent });
  await runCodexInstall({ cwd: gone, home, repoRoot, execFile: absent });
  const before = JSON.parse(await readFile(join(home, ".codex", "muster", "install-scopes.json"), "utf8"));
  assert.equal(before.entries.length, 2, "both scopes are registered before the orphaned worktree is removed");

  // Simulates a deleted git worktree: the .codex directory it registered is
  // gone, but the registry entry survives until the next install reconciles it.
  await rm(gone, { recursive: true, force: true });
  const result = await runCodexInstall({ cwd: keep, home, repoRoot, execFile: absent });
  const after = JSON.parse(await readFile(join(home, ".codex", "muster", "install-scopes.json"), "utf8"));
  assert.deepEqual(after.entries.map(entry => entry.configDir), [join(keep, ".codex")], "the orphaned scope is pruned on the next install");
  assert.deepEqual(result.prunedScopes, [{ scope: "project", configDir: join(gone, ".codex"), reason: "configDir missing" }],
    "the pruned entry is reported in the install summary instead of removed silently");
});

test("Codex install-scope reconciliation case-normalizes duplicate scopes, keeping the canonical on-disk casing", async () => {
  // Models a case-insensitive filesystem (e.g. WSL's /mnt/c DrvFS mount)
  // where two differently-cased configDir strings are the SAME physical
  // directory: lstat succeeds for either casing and reports identical
  // dev/ino, and readdir reveals the one true on-disk casing.
  const fakeStats = new Map([
    ["/case/project", { dev: 1, ino: 100 }],
    ["/other/dir", { dev: 1, ino: 200 }]
  ]);
  const lstatFn = async path => {
    const stat = fakeStats.get(path.toLowerCase());
    if (!stat) { const error = new Error("no such file"); error.code = "ENOENT"; throw error; }
    return { dev: stat.dev, ino: stat.ino, isDirectory: () => true, isSymbolicLink: () => false };
  };
  const diskTree = new Map([["/", ["case", "other"]], ["/case", ["Project"]], ["/other", ["dir"]]]);
  const readdirFn = async dir => diskTree.get(dir) || [];
  const entries = [
    { scope: "project", configDir: "/case/project" },
    { scope: "project", configDir: "/case/Project" },
    { scope: "project", configDir: "/case/deleted-worktree" },
    { scope: "project", configDir: "/other/dir" }
  ];
  const reconciled = await reconcileScopeRegistryEntries(entries, { lstatFn, readdirFn });
  assert.deepEqual(reconciled, [
    { scope: "project", configDir: "/case/Project" },
    { scope: "project", configDir: "/other/dir" }
  ]);
});

test("Codex concurrent uninstalls retain the plugin until one final removal", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "muster-codex-registry-concurrent-uninstall-"));
  const home = join(tmp, "home"), projects = ["a", "b"].map(name => join(tmp, `project-${name}`)), calls = [];
  const execFile = async (_bin, args) => {
    calls.push(args.join(" "));
    if (args[0] === "--version") return { stdout: "codex-cli test" };
    if (args.slice(0, 3).join(" ") === "plugin marketplace list") return { stdout: JSON.stringify({ marketplaces: [localMusterMarketplace] }) };
    if (args.slice(0, 3).join(" ") === "plugin list --available") return { stdout: JSON.stringify({ installed: [] }) };
    return { stdout: "" };
  };
  for (const cwd of projects) await runCodexInstall({ cwd, home, repoRoot, execFile });
  calls.length = 0;
  await Promise.all(projects.map(cwd => runCodexUninstall({ cwd, home, execFile })));
  assert.equal(calls.filter(call => call === "plugin remove muster@muster").length, 1);
});

test("Codex recovers a valid stale managed-scope lock and rejects unsafe locks", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "muster-codex-registry-stale-lock-"));
  const home = join(tmp, "home"), cwd = join(tmp, "project"), registryDir = join(home, ".codex", "muster");
  const lockPath = join(registryDir, "install-scopes.json.lock"), absent = async () => { throw new Error("not found"); };
  await mkdir(registryDir, { recursive: true });
  const old = new Date(Date.now() - 10 * 60 * 1000);
  await writeFile(lockPath, JSON.stringify({ format: 1, owner: "muster", pid: 2_147_483_647, token: "stale", createdAt: old.getTime() }) + "\n");
  await utimes(lockPath, old, old);
  await runCodexInstall({ cwd, home, repoRoot, execFile: absent });
  await assert.rejects(() => readFile(lockPath, "utf8"));

  const unsafeCwd = join(tmp, "unsafe-project");
  await writeFile(lockPath, "not-json\n");
  await assert.rejects(() => runCodexInstall({ cwd: unsafeCwd, home, repoRoot, execFile: absent }), /lock.*invalid|invalid.*lock/i);
  await assert.rejects(() => lstat(join(unsafeCwd, ".codex")));
  await assert.rejects(() => readFile(join(unsafeCwd, ".codex", "agents", ".muster-managed.json"), "utf8"));
});

test("Codex managed-scope stale-lock reclaim never deletes a replacement owner", async t => {
  const tmp = await mkdtemp(join(tmpdir(), "muster-codex-registry-lock-race-"));
  t.after(() => rm(tmp, { recursive: true, force: true }));
  const home = join(tmp, "home"), cwd = join(tmp, "project"), registryDir = join(home, ".codex", "muster");
  const lockPath = join(registryDir, "install-scopes.json.lock"), absent = async () => { throw new Error("not found"); };
  await mkdir(registryDir, { recursive: true });
  const old = new Date(Date.now() - 10 * 60 * 1000);
  await writeFile(lockPath, JSON.stringify({ format: 1, owner: "muster", pid: 2_147_483_647, token: "stale", createdAt: old.getTime() }) + "\n");
  await utimes(lockPath, old, old);
  const replacement = { format: 1, owner: "muster", pid: process.pid, token: "fresh-owner", createdAt: Date.now() };
  let interleaved = false;
  await assert.rejects(runCodexInstall({
    cwd, home, repoRoot, execFile: absent,
    scopeLockOptions: {
      maxAttempts: 1,
      afterQuarantine: async () => {
        interleaved = true;
        await writeFile(lockPath, JSON.stringify(replacement) + "\n", { flag: "wx" });
      }
    }
  }), /lock did not become available/);
  assert.equal(interleaved, true, "test did not interleave a replacement after quarantine");
  assert.equal(JSON.parse(await readFile(lockPath, "utf8")).token, replacement.token);
});

// withCodexFileLock's own stale-reclaim/live-timeout/ownership-before-delete
// invariants (the dropped quarantine/retirement dance's replacement) are
// covered directly in test/codex-lock.test.js; codex-install.js's
// managed-scope lock below is a separate, still-owned implementation.
test("Codex final stale-lock validation binds managed-scope deletion before release", async t => {
  const tmp = await mkdtemp(join(tmpdir(), "muster-codex-final-lock-validation-"));
  t.after(() => rm(tmp, { recursive: true, force: true }));
  const absent = async () => { throw new Error("not found"); };
  const old = new Date(Date.now() - 10 * 60 * 1000);

  const home = join(tmp, "home"), cwd = join(tmp, "project"), registryDir = join(home, ".codex", "muster");
  const scopeLock = join(registryDir, "install-scopes.json.lock");
  await mkdir(registryDir, { recursive: true });
  await writeFile(scopeLock, JSON.stringify({ format: 1, owner: "muster", pid: 2_147_483_647, token: "stale-scope", createdAt: old.getTime() }) + "\n");
  await utimes(scopeLock, old, old);
  const staleScopeReplacement = { format: 1, owner: "muster", pid: process.pid, token: "fresh-scope-stale", createdAt: Date.now() };
  await assert.rejects(runCodexInstall({
    cwd, home, repoRoot, execFile: absent,
    scopeLockOptions: {
      maxAttempts: 1,
      afterValidation: async ({ quarantine }) => {
        await unlink(quarantine);
        await writeFile(quarantine, JSON.stringify(staleScopeReplacement) + "\n", { flag: "wx" });
      }
    }
  }), /lock did not become available/);
  assert.equal(JSON.parse(await readFile(scopeLock, "utf8")).token, staleScopeReplacement.token);

  await unlink(scopeLock);
  const normalScopeReplacement = { format: 1, owner: "muster", pid: process.pid, token: "fresh-scope-release", createdAt: Date.now() };
  await assert.rejects(runCodexInstall({
    cwd, home, repoRoot, execFile: absent,
    scopeLockOptions: {
      beforeRelease: async ({ path }) => {
        await unlink(path);
        await writeFile(path, JSON.stringify(normalScopeReplacement) + "\n", { flag: "wx" });
      }
    }
  }), /lock ownership changed/i);
  assert.equal(JSON.parse(await readFile(scopeLock, "utf8")).token, normalScopeReplacement.token);
});

test("Codex reclaims a crashed stale managed-scope recovery sentinel", async t => {
  const tmp = await mkdtemp(join(tmpdir(), "muster-codex-stale-recovery-sentinel-"));
  t.after(() => rm(tmp, { recursive: true, force: true }));
  const home = join(tmp, "home"), cwd = join(tmp, "project"), registryDir = join(home, ".codex", "muster");
  const lockPath = join(registryDir, "install-scopes.json.lock"), recoveryPath = `${lockPath}.recover`;
  const absent = async () => { throw new Error("not found"); };
  await mkdir(registryDir, { recursive: true });
  const old = new Date(Date.now() - 10 * 60 * 1000);
  const stale = token => JSON.stringify({ format: 1, owner: "muster", pid: 2_147_483_647, token, createdAt: old.getTime() }) + "\n";
  await writeFile(lockPath, stale("stale-main"));
  await writeFile(recoveryPath, stale("stale-recovery"));
  await utimes(lockPath, old, old);
  await utimes(recoveryPath, old, old);
  await runCodexInstall({ cwd, home, repoRoot, execFile: absent, scopeLockOptions: { maxAttempts: 2 } });
  await assert.rejects(() => readFile(lockPath, "utf8"));
  await assert.rejects(() => readFile(recoveryPath, "utf8"));
});

test("Codex reclaims forged and long-lived live-PID recovery sentinels", async t => {
  const absent = async () => { throw new Error("not found"); };
  const recover = async (label, ageMs, processIdentity) => {
    const tmp = await mkdtemp(join(tmpdir(), `muster-codex-${label}-live-recovery-`));
    const home = join(tmp, "home"), cwd = join(tmp, "project"), registryDir = join(home, ".codex", "muster");
    const lockPath = join(registryDir, "install-scopes.json.lock"), recoveryPath = `${lockPath}.recover`;
    const old = new Date(Date.now() - ageMs);
    const record = (token, pid, identity) => JSON.stringify({ format: 1, owner: "muster", pid, processIdentity: identity, token, createdAt: old.getTime() }) + "\n";
    t.after(() => rm(tmp, { recursive: true, force: true }));
    await mkdir(registryDir, { recursive: true });
    await writeFile(lockPath, record("stale-main", 2_147_483_647, null));
    await writeFile(recoveryPath, record("live-recovery", process.pid, processIdentity));
    await utimes(lockPath, old, old);
    await utimes(recoveryPath, old, old);
    await runCodexInstall({ cwd, home, repoRoot, execFile: absent, scopeLockOptions: { maxAttempts: 2 } });
    await assert.rejects(() => readFile(lockPath, "utf8"));
    await assert.rejects(() => readFile(recoveryPath, "utf8"));
  };
  await recover("forged", 10 * 60 * 1000, "forged-process-identity");
  await recover("hard-expiry", 20 * 60 * 1000, null);
});

test("Codex scope-lock retirement preserves replacement components", async t => {
  const tmp = await mkdtemp(join(tmpdir(), "muster-codex-retirement-surface-"));
  const absent = async () => { throw new Error("not found"); };
  const old = new Date(Date.now() - 10 * 60 * 1000);
  t.after(() => rm(tmp, { recursive: true, force: true }));

  const home = join(tmp, "home"), cwd = join(tmp, "project"), registryDir = join(home, ".codex", "muster");
  const scopeLock = join(registryDir, "install-scopes.json.lock"), scopeReplacement = { format: 1, owner: "muster", pid: process.pid, processIdentity: "replacement", token: "scope-replacement", createdAt: Date.now() };
  await mkdir(registryDir, { recursive: true });
  await writeFile(scopeLock, JSON.stringify({ format: 1, owner: "muster", pid: 2_147_483_647, token: "stale-scope", createdAt: old.getTime() }) + "\n");
  await utimes(scopeLock, old, old);
  let scopeRetired;
  await assert.rejects(runCodexInstall({
    cwd, home, repoRoot, execFile: absent,
    scopeLockOptions: {
      maxAttempts: 1,
      afterRetirement: async state => {
        if (scopeRetired) return;
        scopeRetired = state.path;
        await unlink(scopeRetired);
        await writeFile(scopeRetired, JSON.stringify(scopeReplacement) + "\n", { flag: "wx" });
      }
    }
  }), /lock did not become available/);
  assert.equal(JSON.parse(await readFile(scopeRetired, "utf8")).token, scopeReplacement.token);

  const weakHome = join(tmp, "weak-home"), weakCwd = join(tmp, "weak-project");
  let weakScopeRetirement;
  await assert.rejects(runCodexInstall({
    cwd: weakCwd, home: weakHome, repoRoot, execFile: absent,
    scopeLockOptions: {
      afterRetirement: async state => {
        weakScopeRetirement = state.dir;
        await chmod(weakScopeRetirement, 0o777);
      }
    }
  }), /retirement directory/i);
  assert.equal((await lstat(weakScopeRetirement)).mode & 0o077, 0o077);

  const componentHome = join(tmp, "component-home"), componentCwd = join(tmp, "component-project");
  let componentScopeRetired;
  const componentReplacement = { format: 1, owner: "muster", pid: process.pid, processIdentity: "replacement", token: "scope-release-replacement", createdAt: Date.now() };
  await assert.rejects(runCodexInstall({
    cwd: componentCwd, home: componentHome, repoRoot, execFile: absent,
    scopeLockOptions: {
      afterRetirement: async state => {
        componentScopeRetired = state.path;
        await unlink(componentScopeRetired);
        await writeFile(componentScopeRetired, JSON.stringify(componentReplacement) + "\n", { flag: "wx" });
      }
    }
  }), /lock ownership changed/i);
  assert.equal(JSON.parse(await readFile(componentScopeRetired, "utf8")).token, componentReplacement.token);
});

test("Codex ownership dry-runs never create registry locks or entries", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "muster-codex-registry-dry-run-"));
  const home = join(tmp, "home"), cwd = join(tmp, "project"), absent = async () => { throw new Error("not found"); };
  await runCodexInstall({ cwd, home, repoRoot, dryRun: true, execFile: absent });
  await assert.rejects(() => readFile(join(home, ".codex", "muster", "install-scopes.json"), "utf8"));
  await assert.rejects(() => readFile(join(home, ".codex", "muster", "install-scopes.json.lock"), "utf8"));
});
