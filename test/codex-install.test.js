// Split from the former test/codex.test.js monolith: core Codex profile/hook
// install and uninstall (runCodexInstall/runCodexUninstall) -- repeatable
// ownership, conflict/dry-run refusal, traversal and symlink-ancestry
// rejection, historical-profile cleanup, user-scope isolation, Windows path
// mapping, and plugin marketplace registration/rollback.
import { test } from "node:test";
import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { CODEX_COUNTS } from "../src/codex.js";
import { assertContainedProfiles, formatCodexWindowsPath, runCodexInstall, runCodexUninstall } from "../src/codex-install.js";
import { canonicalMusterMarketplace, localMusterMarketplace, repoRoot, runCodexHook, selectedPlugin, selectedPluginRoot } from "../test-support/codex-helpers.js";

test("Codex installation owns only its profile manifest and is repeatable", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "muster-codex-install-"));
  const cwd = join(tmp, "project"), home = join(tmp, "home");
  await mkdir(join(cwd, ".codex"), { recursive: true });
  const userHook = { hooks: { Stop: [{ hooks: [{ type: "command", command: "printf user-hook" }] }] } };
  await writeFile(join(cwd, ".codex", "hooks.json"), JSON.stringify(userHook, null, 2));
  const execFile = async (_bin, args) => {
    if (args[0] === "--version") return { stdout: "codex-cli test" };
    if (args.slice(0, 3).join(" ") === "plugin marketplace list") return { stdout: JSON.stringify({ marketplaces: [canonicalMusterMarketplace] }) };
    if (args.slice(0, 3).join(" ") === "plugin list --available") return { stdout: JSON.stringify({ installed: [{ pluginId: "muster@muster", installed: true }] }) };
    if (args.slice(0, 2).join(" ") === "plugin add") return { stdout: "refreshed" };
    if (args.slice(0, 2).join(" ") === "plugin remove") return { stdout: "removed" };
    throw new Error(`unexpected command: ${args.join(" ")}`);
  };
  const result = await runCodexInstall({ cwd, home, repoRoot, execFile });
  assert.equal(result.profiles, CODEX_COUNTS.agents);
  const agents = join(cwd, ".codex", "agents");
  const manifest = JSON.parse(await readFile(join(agents, ".muster-managed.json"), "utf8"));
  assert.equal(manifest.files.length, CODEX_COUNTS.agents);
  assert.equal(manifest.packageVersion, selectedPlugin.packageVersion);
  assert.equal(result.hooks, 7);
  const hookManifest = JSON.parse(await readFile(join(cwd, ".codex", "muster", ".muster-managed.json"), "utf8"));
  assert.equal(hookManifest.packageVersion, selectedPlugin.packageVersion);
  assert.match(hookManifest.hookHash, /^[a-f0-9]{64}$/);
  const hooks = JSON.parse(await readFile(join(cwd, ".codex", "hooks.json"), "utf8"));
  assert.ok(hooks.hooks.Stop.some(group => group.hooks?.[0]?.command === "printf user-hook"));
  const installedHook = join(cwd, ".codex", "muster", "hooks", "muster-hook.mjs");
  assert.ok(hooks.hooks.SessionStart.some(group => group.hooks?.some(hook => hook.command.includes(installedHook))));
  assert.match((await runCodexHook({ hook_event_name: "SessionStart", session_id: "install-repeatable", source: "startup", cwd }, cwd, installedHook, { CODEX_HOME: join(home, ".codex") })).hookSpecificOutput.additionalContext, /Muster is installed for Codex/);
  await assert.doesNotReject(() => runCodexInstall({ cwd, home, repoRoot, execFile }));
  const repeatedHooks = JSON.parse(await readFile(join(cwd, ".codex", "hooks.json"), "utf8"));
  for (const groups of Object.values(repeatedHooks.hooks)) {
    assert.equal(groups.filter(group => group.hooks?.some(hook => hook.command?.includes("/muster/hooks/muster-hook.mjs"))).length, 1);
  }
  await writeFile(join(agents, "user-agent.toml"), "name = 'user-agent'\n");
  const removed = await runCodexUninstall({ cwd, home, execFile });
  // +3 hook runtime/config files, +1 the shared CODEX_HOME config.toml
  // thread-limit restore (this is the only/last Muster-managed scope for
  // this home, so uninstall also reports and restores it -- see
  // test/codex-thread-limits.test.js for dedicated coverage).
  assert.equal(removed.files.length, CODEX_COUNTS.agents + 4);
  assert.equal(await readFile(join(agents, "user-agent.toml"), "utf8"), "name = 'user-agent'\n");
  assert.deepEqual(JSON.parse(await readFile(join(cwd, ".codex", "hooks.json"), "utf8")), userHook);
  await assert.rejects(() => readFile(installedHook, "utf8"));
});

test("Codex installation refuses unrelated profiles and dry-run writes nothing", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "muster-codex-conflict-"));
  const cwd = join(tmp, "project"), home = join(tmp, "home"), agents = join(cwd, ".codex", "agents");
  await mkdir(agents, { recursive: true });
  await writeFile(join(agents, "muster-builder.toml"), "name = 'not-muster'\n");
  const absent = async () => { throw new Error("not found"); };
  await assert.rejects(() => runCodexInstall({ cwd, home, repoRoot, execFile: absent }), /Codex profile conflict/);
  const dry = await runCodexInstall({ cwd: join(tmp, "dry"), home, repoRoot, dryRun: true, execFile: absent });
  assert.equal(dry.plugin.skipped, "codex-not-found");
  await assert.rejects(() => readFile(join(tmp, "dry", ".codex", "agents", ".muster-managed.json"), "utf8"));
  await assert.rejects(() => readFile(join(tmp, "dry", ".codex", "hooks.json"), "utf8"));
  assert.deepEqual(dry.nextSteps, ["npm install -g @openai/codex", "muster install codex --scope project"]);
});

test("Codex install and uninstall reject registries without exact Muster ownership before mutation", async () => {
  for (const owner of [undefined, "another-tool"]) {
    const tmp = await mkdtemp(join(tmpdir(), "muster-codex-registry-owner-"));
    const home = join(tmp, "home"), cwd = join(tmp, "project"), registryDir = join(home, ".codex", "muster");
    const registryPath = join(registryDir, "install-scopes.json"), absent = async () => { throw new Error("not found"); };
    await mkdir(join(cwd, ".codex"), { recursive: true });
    await mkdir(registryDir, { recursive: true });
    const foreign = JSON.stringify({ format: 1, ...(owner === undefined ? {} : { owner }), entries: [] }, null, 2) + "\n";
    await writeFile(registryPath, foreign);
    await assert.rejects(() => runCodexInstall({ cwd, home, repoRoot, execFile: absent }), /registry.*(ownership|owner|invalid)/i);
    assert.equal(await readFile(registryPath, "utf8"), foreign);
    await assert.rejects(() => readFile(join(cwd, ".codex", "agents", ".muster-managed.json"), "utf8"));

    await writeFile(registryPath, JSON.stringify({ format: 1, owner: "muster", entries: [] }, null, 2) + "\n");
    await runCodexInstall({ cwd, home, repoRoot, execFile: absent });
    const profilePath = join(cwd, ".codex", "agents", "muster-builder.toml");
    const profile = await readFile(profilePath, "utf8");
    await writeFile(registryPath, foreign);
    await assert.rejects(() => runCodexUninstall({ cwd, home, execFile: absent }), /registry.*(ownership|owner|invalid)/i);
    assert.equal(await readFile(registryPath, "utf8"), foreign);
    assert.equal(await readFile(profilePath, "utf8"), profile);
  }
});

test("Codex uninstall rejects traversal in a managed manifest", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "muster-codex-traversal-"));
  const cwd = join(tmp, "project"), home = join(tmp, "home"), agents = join(cwd, ".codex", "agents");
  const victim = join(cwd, "victim.toml");
  await mkdir(agents, { recursive: true });
  await writeFile(victim, "keep me\n");
  await writeFile(join(agents, ".muster-managed.json"), JSON.stringify({ format: 1, owner: "muster", files: ["../../victim.toml"] }));
  const absent = async () => { throw new Error("not found"); };
  await assert.rejects(() => runCodexUninstall({ cwd, home, repoRoot, execFile: absent }), /Invalid Muster-owned Codex profile/);
  assert.equal(await readFile(victim, "utf8"), "keep me\n");
});

test("Codex install rejects symlinked configuration ancestry and targets without touching victims", async t => {
  const tmp = await mkdtemp(join(tmpdir(), "muster-codex-install-symlink-"));
  const absent = async () => { throw new Error("not found"); };
  const cases = [
    [".codex directory", async (cwd, victim) => {
      await mkdir(victim, { recursive: true });
      await writeFile(join(victim, "sentinel.txt"), "keep\n");
      await symlink(victim, join(cwd, ".codex"));
      return async () => assert.deepEqual(await readdir(victim), ["sentinel.txt"]);
    }],
    ["agents directory", async (cwd, victim) => {
      await mkdir(join(cwd, ".codex"), { recursive: true });
      await mkdir(victim, { recursive: true });
      await writeFile(join(victim, "sentinel.txt"), "keep\n");
      await symlink(victim, join(cwd, ".codex", "agents"));
      return async () => assert.deepEqual(await readdir(victim), ["sentinel.txt"]);
    }],
    ["muster directory", async (cwd, victim) => {
      await mkdir(join(cwd, ".codex"), { recursive: true });
      await mkdir(victim, { recursive: true });
      await writeFile(join(victim, "sentinel.txt"), "keep\n");
      await symlink(victim, join(cwd, ".codex", "muster"));
      return async () => assert.deepEqual(await readdir(victim), ["sentinel.txt"]);
    }],
    ["hooks.json", async (cwd, victim) => {
      await mkdir(join(cwd, ".codex"), { recursive: true });
      const bytes = '{"hooks":{}}\n';
      await writeFile(victim, bytes);
      await symlink(victim, join(cwd, ".codex", "hooks.json"));
      return async () => assert.equal(await readFile(victim, "utf8"), bytes);
    }],
    ["agents manifest", async (cwd, victim) => {
      const agents = join(cwd, ".codex", "agents");
      await mkdir(agents, { recursive: true });
      const bytes = JSON.stringify({ format: 1, owner: "muster", files: [] }) + "\n";
      await writeFile(victim, bytes);
      await symlink(victim, join(agents, ".muster-managed.json"));
      return async () => {
        assert.equal(await readFile(victim, "utf8"), bytes);
        assert.deepEqual(await readdir(agents), [".muster-managed.json"]);
      };
    }]
  ];
  for (const [name, setup] of cases) await t.test(name, async () => {
    const cwd = join(tmp, name.replaceAll(/[^a-z]+/gi, "-")), victim = join(tmp, `${name.replaceAll(/[^a-z]+/gi, "-")}-victim`);
    await mkdir(cwd, { recursive: true });
    const verify = await setup(cwd, victim);
    await assert.rejects(() => runCodexInstall({ cwd, home: join(tmp, "home"), repoRoot, execFile: absent }), /symlink|ordinary|regular/i);
    await verify();
  });
});

test("Codex uninstall rejects symlinked configuration ancestry and targets without touching victims", async t => {
  const tmp = await mkdtemp(join(tmpdir(), "muster-codex-uninstall-symlink-"));
  const absent = async () => { throw new Error("not found"); };
  const managedProfiles = JSON.stringify({ format: 1, owner: "muster", files: ["victim.toml"] }) + "\n";
  const managedHooks = JSON.stringify({ format: 1, owner: "muster", files: ["hooks/victim.mjs"], hookGroups: {} }) + "\n";
  const cases = [
    [".codex directory", async (cwd, victim) => {
      await mkdir(join(victim, "agents"), { recursive: true });
      await writeFile(join(victim, "agents", ".muster-managed.json"), managedProfiles);
      await writeFile(join(victim, "agents", "victim.toml"), "keep\n");
      await symlink(victim, join(cwd, ".codex"));
      return async () => assert.equal(await readFile(join(victim, "agents", "victim.toml"), "utf8"), "keep\n");
    }],
    ["agents directory", async (cwd, victim) => {
      await mkdir(join(cwd, ".codex"), { recursive: true });
      await mkdir(victim, { recursive: true });
      await writeFile(join(victim, ".muster-managed.json"), managedProfiles);
      await writeFile(join(victim, "victim.toml"), "keep\n");
      await symlink(victim, join(cwd, ".codex", "agents"));
      return async () => assert.equal(await readFile(join(victim, "victim.toml"), "utf8"), "keep\n");
    }],
    ["agents manifest", async (cwd, victim) => {
      const agents = join(cwd, ".codex", "agents");
      await mkdir(agents, { recursive: true });
      await writeFile(join(agents, "victim.toml"), "keep\n");
      await writeFile(victim, managedProfiles);
      await symlink(victim, join(agents, ".muster-managed.json"));
      return async () => assert.equal(await readFile(join(agents, "victim.toml"), "utf8"), "keep\n");
    }],
    ["muster directory", async (cwd, victim) => {
      await mkdir(join(cwd, ".codex"), { recursive: true });
      await mkdir(join(victim, "hooks"), { recursive: true });
      await writeFile(join(victim, ".muster-managed.json"), managedHooks);
      await writeFile(join(victim, "hooks", "victim.mjs"), "keep\n");
      await symlink(victim, join(cwd, ".codex", "muster"));
      return async () => assert.equal(await readFile(join(victim, "hooks", "victim.mjs"), "utf8"), "keep\n");
    }],
    ["hook manifest", async (cwd, victim) => {
      const runtime = join(cwd, ".codex", "muster"), hook = join(runtime, "hooks", "victim.mjs");
      await mkdir(dirname(hook), { recursive: true });
      await writeFile(hook, "keep\n");
      await writeFile(victim, managedHooks);
      await symlink(victim, join(runtime, ".muster-managed.json"));
      return async () => assert.equal(await readFile(hook, "utf8"), "keep\n");
    }],
    ["hooks.json", async (cwd, victim) => {
      const runtime = join(cwd, ".codex", "muster");
      await mkdir(runtime, { recursive: true });
      await writeFile(join(runtime, ".muster-managed.json"), JSON.stringify({ format: 1, owner: "muster", files: [], hookGroups: {} }));
      const bytes = '{"hooks":{},"keep":true}\n';
      await writeFile(victim, bytes);
      await symlink(victim, join(cwd, ".codex", "hooks.json"));
      return async () => assert.equal(await readFile(victim, "utf8"), bytes);
    }]
  ];
  for (const [name, setup] of cases) await t.test(name, async () => {
    const cwd = join(tmp, name.replaceAll(/[^a-z]+/gi, "-")), victim = join(tmp, `${name.replaceAll(/[^a-z]+/gi, "-")}-victim`);
    await mkdir(cwd, { recursive: true });
    const verify = await setup(cwd, victim);
    await assert.rejects(() => runCodexUninstall({ cwd, home: join(tmp, "home"), execFile: absent }), /symlink|ordinary|regular/i);
    await verify();
  });
});

test("Codex upgrade and uninstall clean historical managed profiles", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "muster-codex-historical-"));
  const cwd = join(tmp, "project"), home = join(tmp, "home"), agents = join(cwd, ".codex", "agents");
  const stale = join(agents, "retired-specialist.toml");
  await mkdir(agents, { recursive: true });
  await writeFile(stale, "name = 'retired'\n");
  await writeFile(join(agents, ".muster-managed.json"), JSON.stringify({ format: 1, owner: "muster", files: ["retired-specialist.toml"] }));
  const absent = async () => { throw new Error("not found"); };
  const upgraded = await runCodexInstall({ cwd, home, repoRoot, execFile: absent });
  assert.ok(upgraded.files.some(item => item.op === "remove" && item.path === stale));
  await assert.rejects(() => readFile(stale, "utf8"));
  const manifest = JSON.parse(await readFile(join(agents, ".muster-managed.json"), "utf8"));
  assert.ok(!manifest.files.includes("retired-specialist.toml"));

  const hookRoot = join(cwd, ".codex", "muster"), retiredHook = join(hookRoot, "hooks", "retired-hook.mjs");
  const hookManifestPath = join(hookRoot, ".muster-managed.json");
  const hookManifest = JSON.parse(await readFile(hookManifestPath, "utf8"));
  hookManifest.files.push("hooks/retired-hook.mjs");
  await writeFile(hookManifestPath, JSON.stringify(hookManifest));
  await writeFile(retiredHook, "// retired\n");
  const hookUpgrade = await runCodexInstall({ cwd, home, repoRoot, execFile: absent });
  assert.ok(hookUpgrade.files.some(item => item.op === "remove" && item.path === retiredHook));
  await assert.rejects(() => readFile(retiredHook, "utf8"));

  await writeFile(stale, "name = 'retired'\n");
  await writeFile(join(agents, ".muster-managed.json"), JSON.stringify({ format: 1, owner: "muster", files: ["retired-specialist.toml"] }));
  const uninstalled = await runCodexUninstall({ cwd, home, execFile: absent });
  assert.ok(uninstalled.files.some(item => item.op === "remove" && item.path === stale));
  assert.ok(uninstalled.files.some(item => item.op === "remove" && item.path.endsWith("muster-hook.mjs")));
  assert.ok(uninstalled.files.some(item => item.op === "remove" && item.path.endsWith("hooks.json")));
  await assert.rejects(() => readFile(stale, "utf8"));
});

test("Codex user-scope install and uninstall use CODEX_HOME without disturbing user hooks", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "muster-codex-user-scope-"));
  const cwd = join(tmp, "project"), home = join(tmp, "home"), target = join(home, ".codex");
  const absent = async () => { throw new Error("not found"); };
  await mkdir(target, { recursive: true });
  const existing = { hooks: { Stop: [{ hooks: [{ type: "command", command: "printf existing" }] }] } };
  await writeFile(join(target, "hooks.json"), JSON.stringify(existing));
  const installed = await runCodexInstall({ scope: "user", cwd, home, repoRoot, execFile: absent });
  assert.ok(installed.files.some(item => item.path === join(target, "agents", "muster-builder.toml")));
  assert.ok(installed.files.some(item => item.path === join(target, "muster", "hooks", "muster-hook.mjs")));
  await runCodexUninstall({ scope: "user", cwd, home, execFile: absent });
  assert.deepEqual(JSON.parse(await readFile(join(target, "hooks.json"), "utf8")), existing);
  await assert.rejects(() => readFile(join(target, "agents", "muster-builder.toml"), "utf8"));
});

// This fixture can only exercise a genuine WSL2 drvfs C: path by mkdtemp-ing
// under the checkout itself and relying on the checkout living under
// /mnt/c — there is no portable way to fabricate a "/mnt/c/..." path that
// isn't. Skip (rather than fail) when the checkout is not there, e.g. a
// native-filesystem (ext4) checkout of this repo or the published package;
// commandWindows's WSL-path-mapping logic itself is unchanged and still
// covered whenever this suite runs from an actual /mnt/c checkout.
const isWslDriveCheckout = /^\/mnt\/[a-z]\//i.test(repoRoot);
test("Codex commandWindows maps WSL drive paths to their Windows equivalent", {
  skip: isWslDriveCheckout ? false : "requires a checkout under /mnt/c (WSL2 drvfs); not applicable from a native-filesystem checkout"
}, async t => {
  const tmp = await mkdtemp(join(repoRoot, ".muster-codex-wsl-command-"));
  t.after(() => rm(tmp, { recursive: true, force: true }));
  const cwd = join(tmp, "project"), home = join(tmp, "home"), absent = async () => { throw new Error("not found"); };
  assert.match(cwd, /^\/mnt\/c\//i, "fixture must exercise a real WSL C: path");
  await runCodexInstall({ cwd, home, repoRoot, execFile: absent });
  const hooks = JSON.parse(await readFile(join(cwd, ".codex", "hooks.json"), "utf8"));
  const commandWindows = hooks.hooks.SessionStart[0].hooks[0].commandWindows;
  const expectedPath = `C:${join(cwd.slice("/mnt/c".length), ".codex", "muster", "hooks", "muster-hook.mjs").replaceAll("\\", "/")}`;
  // The interpreter is now the pinned absolute Node executable (run-5 security
  // audit Med #5), quoted and Windows-mapped exactly like the script path --
  // never bare `node`, which PATH could shadow at every hook event.
  const expectedNode = formatCodexWindowsPath(process.execPath).replaceAll('"', '\\"');
  assert.equal(commandWindows, `"${expectedNode}" "${expectedPath}"`);
});

test("Codex commandWindows treats native Windows and WSL drives alike without normalizing POSIX case", () => {
  for (const [host, input, expected] of [
    ["native Windows uppercase drive", "C:\\Work\\Muster\\hook.mjs", "C:/Work/Muster/hook.mjs"],
    ["native Windows lowercase drive", "c:\\Work\\Muster\\hook.mjs", "C:/Work/Muster/hook.mjs"],
    ["WSL drive mount", "/mnt/c/Work/Muster/hook.mjs", "C:/Work/Muster/hook.mjs"],
    ["native POSIX", "/tmp/CaseSensitive/Muster/hook.mjs", "/tmp/CaseSensitive/Muster/hook.mjs"]
  ]) assert.equal(formatCodexWindowsPath(input), expected, host);
});

test("Codex install refreshes an older installed plugin version", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "muster-codex-plugin-upgrade-")), calls = [];
  const execFile = async (_bin, args) => {
    calls.push(args.join(" "));
    if (args[0] === "--version") return { stdout: "codex-cli test" };
    if (args.slice(0, 3).join(" ") === "plugin marketplace list") return { stdout: JSON.stringify({ marketplaces: [canonicalMusterMarketplace] }) };
    if (args.slice(0, 3).join(" ") === "plugin list --available") return { stdout: JSON.stringify({ installed: [{ pluginId: "muster@muster", installed: true, version: "0.4.9" }] }) };
    if (args.slice(0, 2).join(" ") === "plugin add") return { stdout: "updated" };
    throw new Error(`unexpected command: ${args.join(" ")}`);
  };
  await runCodexInstall({ cwd: join(tmp, "project"), home: join(tmp, "home"), repoRoot, execFile });
  assert.ok(calls.includes("plugin add muster@muster"));
});

test("Codex install refreshes an already-installed same-version local plugin", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "muster-codex-plugin-same-version-")), calls = [];
  const plugin = JSON.parse(await readFile(join(selectedPluginRoot, ".codex-plugin", "plugin.json"), "utf8"));
  const execFile = async (_bin, args) => {
    calls.push(args.join(" "));
    if (args[0] === "--version") return { stdout: "codex-cli test" };
    if (args.slice(0, 3).join(" ") === "plugin marketplace list") return { stdout: JSON.stringify({ marketplaces: [localMusterMarketplace] }) };
    if (args.slice(0, 3).join(" ") === "plugin list --available") return { stdout: JSON.stringify({ installed: [{ pluginId: "muster@muster", installed: true, enabled: true, version: plugin.version }] }) };
    if (args.slice(0, 2).join(" ") === "plugin add") return { stdout: "refreshed" };
    throw new Error(`unexpected command: ${args.join(" ")}`);
  };
  await runCodexInstall({ cwd: join(tmp, "project"), home: join(tmp, "home"), repoRoot, execFile });
  assert.ok(calls.includes("plugin add muster@muster"));
});

test("Codex install rejects a mutable GitHub marketplace generation", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "muster-codex-plugin-canonical-")), calls = [];
  const execFile = async (_bin, args) => {
    calls.push(args.join(" "));
    if (args[0] === "--version") return { stdout: "codex-cli test" };
    if (args.slice(0, 3).join(" ") === "plugin marketplace list") return { stdout: JSON.stringify({ marketplaces: [{ name: "muster", root: "/tmp/muster", marketplaceSource: { sourceType: "git", source: "https://github.com/Adnova-Group/muster.git" } }] }) };
    if (args.slice(0, 3).join(" ") === "plugin list --available") return { stdout: JSON.stringify({ installed: [] }) };
    if (args.slice(0, 2).join(" ") === "plugin add") return { stdout: "refreshed" };
    throw new Error(`unexpected command: ${args.join(" ")}`);
  };
  await assert.rejects(runCodexInstall({ cwd: join(tmp, "project"), home: join(tmp, "home"), repoRoot, execFile }), /marketplace conflict/i);
  assert.equal(calls.includes("plugin add muster@muster"), false);
});

test("Codex install accepts the exact local marketplace across WSL drive-path casing", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "muster-codex-plugin-local-")), calls = [];
  const localRoot = repoRoot
    .replace(/^\/mnt\/([a-z])\//i, (_match, drive) => `/mnt/${drive.toUpperCase()}/`)
    .replace(/\/users\//i, "/USERS/");
  const localMarketplace = { name: "muster", root: localRoot, marketplaceSource: { sourceType: "local", source: localRoot } };
  const execFile = async (_bin, args) => {
    calls.push(args.join(" "));
    if (args[0] === "--version") return { stdout: "codex-cli test" };
    if (args.slice(0, 3).join(" ") === "plugin marketplace list") return { stdout: JSON.stringify({ marketplaces: [localMarketplace] }) };
    if (args.slice(0, 3).join(" ") === "plugin list --available") return { stdout: JSON.stringify({ installed: [] }) };
    if (args.slice(0, 2).join(" ") === "plugin add") return { stdout: "refreshed" };
    throw new Error(`unexpected command: ${args.join(" ")}`);
  };
  await runCodexInstall({ cwd: join(tmp, "project"), home: join(tmp, "home"), repoRoot, execFile });
  assert.ok(calls.includes("plugin add muster@muster"));
});

test("Codex install rejects a case-distinct POSIX marketplace root", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "muster-codex-case-root-")), trusted = join(tmp, "development"), attacker = join(tmp, "DEVELOPMENT");
  await mkdir(trusted); await mkdir(attacker);
  // generateCodexProfiles (install-time-generation) needs enough of the
  // source tree to succeed so the marketplace-trust check below is the first
  // thing that legitimately fails, not a missing-source error.
  await cp(join(repoRoot, "codex"), join(trusted, "codex"), { recursive: true });
  await cp(join(repoRoot, "catalog"), join(trusted, "catalog"), { recursive: true }); // manifest lives here now (Phase D)
  await cp(join(repoRoot, "plugin", "agents"), join(trusted, "plugin", "agents"), { recursive: true });
  await cp(join(repoRoot, "package.json"), join(trusted, "package.json"));
  const marketplace = { name: "muster", root: attacker, marketplaceSource: { sourceType: "local", source: attacker } };
  const execFile = async (_bin, args) => {
    if (args[0] === "--version") return { stdout: "codex-cli test" };
    if (args.slice(0, 3).join(" ") === "plugin marketplace list") return { stdout: JSON.stringify({ marketplaces: [marketplace] }) };
    throw new Error(`unexpected command: ${args.join(" ")}`);
  };
  await assert.rejects(runCodexInstall({ cwd: join(tmp, "project"), home: join(tmp, "home"), repoRoot: trusted, execFile }), /marketplace conflict/i);
  await assert.rejects(readFile(join(tmp, "project", ".codex", "agents", ".muster-managed.json"), "utf8"));
});

test("Codex install rejects an attacker-controlled muster marketplace without mutation", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "muster-codex-plugin-collision-"));
  const cwd = join(tmp, "project"), home = join(tmp, "home"), calls = [];
  const attackerMarketplace = {
    name: "muster",
    root: join(tmp, "attacker"),
    marketplaceSource: { sourceType: "local", source: join(tmp, "attacker") }
  };
  const execFile = async (_bin, args) => {
    calls.push(args.join(" "));
    if (args[0] === "--version") return { stdout: "codex-cli test" };
    if (args.slice(0, 3).join(" ") === "plugin marketplace list") return { stdout: JSON.stringify({ marketplaces: [attackerMarketplace] }) };
    if (args.slice(0, 3).join(" ") === "plugin list --available") return { stdout: JSON.stringify({ installed: [] }) };
    if (args.slice(0, 2).join(" ") === "plugin add") return { stdout: "hijacked" };
    throw new Error(`unexpected command: ${args.join(" ")}`);
  };
  await assert.rejects(
    () => runCodexInstall({ cwd, home, repoRoot, execFile }),
    /Codex marketplace conflict.*codex plugin marketplace remove muster/
  );
  assert.equal(calls.includes("plugin list --available --json"), false);
  assert.equal(calls.includes("plugin add muster@muster"), false);
  await assert.rejects(() => readFile(join(cwd, ".codex", "agents", ".muster-managed.json"), "utf8"));
  await assert.rejects(() => readFile(join(cwd, ".codex", "muster", ".muster-managed.json"), "utf8"));
});

test("Codex install rolls profiles and marketplace back when plugin registration fails", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "muster-codex-rollback-"));
  const cwd = join(tmp, "project"), home = join(tmp, "home"), calls = [];
  const execFile = async (_bin, args) => {
    calls.push(args.join(" "));
    if (args[0] === "--version") return { stdout: "codex-cli test" };
    if (args.slice(0, 3).join(" ") === "plugin marketplace list") return { stdout: JSON.stringify({ marketplaces: [] }) };
    if (args.slice(0, 3).join(" ") === "plugin marketplace add") return { stdout: "" };
    if (args.slice(0, 3).join(" ") === "plugin list --available") return { stdout: JSON.stringify({ installed: [], available: [] }) };
    if (args.slice(0, 2).join(" ") === "plugin add") throw new Error("registration failed");
    if (args.slice(0, 3).join(" ") === "plugin marketplace remove") return { stdout: "" };
    throw new Error(`unexpected command: ${args.join(" ")}`);
  };
  await assert.rejects(() => runCodexInstall({ cwd, home, repoRoot, execFile }), /registration failed/);
  const agents = join(cwd, ".codex", "agents");
  await assert.rejects(() => readFile(join(agents, ".muster-managed.json"), "utf8"));
  await assert.rejects(() => readFile(join(agents, "muster-builder.toml"), "utf8"));
  assert.ok(calls.includes("plugin marketplace remove muster"));
});

// --- Destination containment: a generated `<id>.toml` must resolve inside
// agentsDir before it is join()'d into a write path (run-5 security audit
// High #1, defense in depth behind generateCodexProfiles' id guard). ---

test("assertContainedProfiles refuses any profile filename that would escape the agents directory", () => {
  const dir = join("/srv", "proj", ".codex", "agents");
  for (const bad of ["../evil.toml", "../../etc/cron.d/x.toml", "/etc/cron.d/x.toml", "sub/x.toml", "..\\evil.toml", "evil.txt", ".toml", "muster builder.toml"]) {
    assert.throws(() => assertContainedProfiles([bad], dir), /outside/,
      `${JSON.stringify(bad)} must be refused before it becomes a write destination`);
  }
  assert.doesNotThrow(() => assertContainedProfiles(["muster-builder.toml", "muster-reviewer.toml"], dir));
});

test("runCodexInstall refuses a manifest whose agent id escapes agentsDir and writes nothing outside it", async t => {
  const tmp = await mkdtemp(join(tmpdir(), "muster-codex-id-escape-"));
  t.after(() => rm(tmp, { recursive: true, force: true }));
  const fakeRepo = join(tmp, "repo"), cwd = join(tmp, "project"), home = join(tmp, "home");
  // Enough real source tree for generateCodexProfiles + prepareHooks to run;
  // only the manifest is poisoned with a traversing id.
  await cp(join(repoRoot, "codex"), join(fakeRepo, "codex"), { recursive: true });
  await cp(join(repoRoot, "catalog"), join(fakeRepo, "catalog"), { recursive: true });
  await cp(join(repoRoot, "plugin", "agents"), join(fakeRepo, "plugin", "agents"), { recursive: true });
  await cp(join(repoRoot, "package.json"), join(fakeRepo, "package.json"));
  // The manifest lives in catalog/ now (shared, harness-neutral path); poison it there.
  await writeFile(join(fakeRepo, "catalog", "agents.manifest.json"),
    JSON.stringify({ format: 1, agents: { "../pwned": { source: "plugin/agents/muster-builder.md", tier: "opus" } } }));
  const absent = async () => { throw new Error("codex not found"); };
  await assert.rejects(() => runCodexInstall({ cwd, home, repoRoot: fakeRepo, execFile: absent }), /is not a safe token|outside/);
  // The escaping `<id>.toml` join(agentsDir, "../pwned.toml") == cwd/.codex/pwned.toml must never be written.
  await assert.rejects(readFile(join(cwd, ".codex", "pwned.toml"), "utf8"), "no profile may be materialized outside agentsDir");
});
