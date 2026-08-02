import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { execFile as execFileCb } from "node:child_process";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { buildCodexPlugin } from "../scripts/build-codex.mjs";
import { runCodexDoctor } from "../src/codex-doctor.js";
import { codexVersionMatches, resolveCodexRuntimeIdentity, runCodexCommand } from "../src/codex-runtime-identity.js";
import { parseHookCommand, runCodexInstall } from "../src/codex-install.js";
import { CODEX_COUNTS } from "../src/codex.js";
import { codexAvailable, readCodexInventory } from "../src/codex-inventory.js";

const execFile = promisify(execFileCb);
const repoRoot = fileURLToPath(new URL("../", import.meta.url));
const healthyHandshake = async () => ({ initialized: true, tools: Array.from({ length: CODEX_COUNTS.mcpTools }, () => ({})), toolCallOk: true });

async function fixture(t, platform) {
  const tmp = await mkdtemp(join(tmpdir(), `muster-runtime-identity-${platform}-`));
  t.after(() => rm(tmp, { recursive: true, force: true }));
  const shadowBin = join(tmp, "shadow-bin"), marker = join(tmp, "shadow-ran");
  const packageRoot = join(tmp, "trusted", "@openai", "codex");
  await mkdir(join(packageRoot, "bin"), { recursive: true });
  const triple = platform === "win32"
    ? (process.arch === "arm64" ? "aarch64-pc-windows-msvc" : "x86_64-pc-windows-msvc")
    : (process.arch === "arm64" ? "aarch64-unknown-linux-musl" : "x86_64-unknown-linux-musl");
  const nativePath = join(packageRoot, "vendor", triple, "bin", platform === "win32" ? "codex.exe" : "codex");
  await mkdir(join(packageRoot, "vendor", triple, "bin"), { recursive: true });
  await mkdir(shadowBin);
  await writeFile(join(packageRoot, "package.json"), JSON.stringify({ name: "@openai/codex", version: "9.8.7" }));
  await writeFile(join(packageRoot, "bin", "codex.js"), "#!/usr/bin/env node\n");
  await writeFile(nativePath, "native codex fixture\n");
  const shadow = join(shadowBin, platform === "win32" ? "codex.cmd" : "codex");
  await writeFile(shadow, platform === "win32" ? `@echo shadow>${marker}\r\n` : `#!/bin/sh\nprintf shadow > '${marker}'\n`);
  await chmod(shadow, 0o755);
  const env = { ...process.env, PATH: `${shadowBin}${delimiter}${process.env.PATH || ""}`, CODEX_MANAGED_PACKAGE_ROOT: packageRoot };
  const identity = resolveCodexRuntimeIdentity({ env, platform, nodeExecPath: process.execPath });
  return { tmp, marker, env, identity, packageRoot, nativePath };
}

for (const platform of ["linux", "win32"]) {
  test(`${platform}: fake PATH-precedence Codex is never executed and the trusted package entrypoint runs under canonical Node`, {
    skip: process.platform === platform ? false : `native ${platform} fixture runs in its matching CI job`,
  }, async t => {
    const { marker, env, identity, nativePath } = await fixture(t, platform);
    const calls = [];
    const execFile = async (file, args) => {
      calls.push({ file, args });
      return { stdout: "codex-cli 9.8.7\n" };
    };
    await runCodexCommand(execFile, identity, ["--version"]);
    assert.equal(calls[0].file, await realpath(process.execPath));
    assert.deepEqual(calls[0].args, [identity.codex, "--version"]);
    assert.equal(identity.version, "9.8.7");
    assert.equal(identity.nativeCodex, await realpath(nativePath));
    await assert.rejects(readFile(marker), /ENOENT/);
    assert.equal(env.PATH.startsWith(marker), false);
  });
}

test("Codex version attestation rejects warnings, suffixes, extra lines, and control text", () => {
  assert.equal(codexVersionMatches("codex-cli 9.8.7\n", "9.8.7").ok, true);
  for (const output of [
    "warning: codex 9.8.7", "codex-cli 9.8.7 extra", "codex-cli 9.8.7\nattacker", "\u001b[31mcodex-cli 9.8.7\u001b[0m",
  ]) assert.equal(codexVersionMatches(output, "9.8.7").ok, false, output);
});

test("trusted Codex identity rejects a native executable symlink escaping the package root", async t => {
  const { tmp, env, nativePath } = await fixture(t, process.platform);
  const outside = join(tmp, "outside-native");
  await writeFile(outside, "untrusted native\n");
  await unlink(nativePath);
  await symlink(outside, nativePath);
  assert.throws(
    () => resolveCodexRuntimeIdentity({ env, platform: process.platform, nodeExecPath: process.execPath }),
    /escapes the trusted Codex package root/
  );
});

test("Codex platform fallback ignores ambient package lookup and requires the exact declared version", async t => {
  const { tmp, env, packageRoot, nativePath } = await fixture(t, process.platform);
  const suffix = `${process.platform}-${process.arch}`;
  const platformName = `@openai/codex-${suffix}`;
  const expectedVersion = `9.8.7-${suffix}`;
  await unlink(nativePath);
  await writeFile(join(packageRoot, "package.json"), JSON.stringify({
    name: "@openai/codex", version: "9.8.7",
    optionalDependencies: { [platformName]: `npm:@openai/codex@${expectedVersion}` }
  }));

  const injectedRoot = join(tmp, "injected", "@openai", `codex-${suffix}`);
  await mkdir(join(injectedRoot, "vendor"), { recursive: true });
  await writeFile(join(injectedRoot, "package.json"), JSON.stringify({ name: "@openai/codex", version: expectedVersion }));
  assert.throws(
    () => resolveCodexRuntimeIdentity({ env: { ...env, NODE_PATH: join(tmp, "injected") }, platform: process.platform }),
    /ENOENT|Codex platform package manifest/
  );

  const nestedRoot = join(packageRoot, "node_modules", "@openai", `codex-${suffix}`);
  const triple = process.platform === "win32"
    ? (process.arch === "arm64" ? "aarch64-pc-windows-msvc" : "x86_64-pc-windows-msvc")
    : process.platform === "darwin"
      ? (process.arch === "arm64" ? "aarch64-apple-darwin" : "x86_64-apple-darwin")
      : (process.arch === "arm64" ? "aarch64-unknown-linux-musl" : "x86_64-unknown-linux-musl");
  const executable = process.platform === "win32" ? "codex.exe" : "codex";
  await mkdir(join(nestedRoot, "vendor", triple, "bin"), { recursive: true });
  await writeFile(join(nestedRoot, "vendor", triple, "bin", executable), "nested native\n");
  await writeFile(join(nestedRoot, "package.json"), JSON.stringify({ name: "@openai/codex", version: `${expectedVersion}-attacker` }));
  assert.throws(() => resolveCodexRuntimeIdentity({ env, platform: process.platform }), /unexpected name or version/);
  await writeFile(join(nestedRoot, "package.json"), JSON.stringify({ name: "@openai/codex", version: expectedVersion }));
  assert.equal(resolveCodexRuntimeIdentity({ env, platform: process.platform }).nativeCodex,
    await realpath(join(nestedRoot, "vendor", triple, "bin", executable)));
});

test("missing trusted identity performs no Codex PATH execution", async () => {
  const calls = [];
  const runner = async (...args) => { calls.push(args); throw new Error("must not execute"); };
  assert.equal(await codexAvailable({ execFile: runner, env: {} }), false);
  const inventory = await readCodexInventory({ cwd: "/nonexistent", codexHome: "/nonexistent", execFile: runner, env: {} });
  assert.deepEqual(inventory, { plugins: [], skills: [], mcpServers: [], agents: [] });
  assert.deepEqual(calls, []);
});

test("a declared managed Codex package with no native binary blocks install", async t => {
  const tmp = await mkdtemp(join(tmpdir(), "muster-broken-managed-codex-"));
  t.after(() => rm(tmp, { recursive: true, force: true }));
  const packageRoot = join(tmp, "managed", "@openai", "codex");
  const cwd = join(tmp, "project"), home = join(tmp, "home");
  await mkdir(join(packageRoot, "bin"), { recursive: true });
  await mkdir(cwd, { recursive: true });
  await writeFile(join(packageRoot, "package.json"), JSON.stringify({ name: "@openai/codex", version: "9.8.7" }));
  await writeFile(join(packageRoot, "bin", "codex.js"), "#!/usr/bin/env node\n");
  const previous = process.env.CODEX_MANAGED_PACKAGE_ROOT;
  try {
    process.env.CODEX_MANAGED_PACKAGE_ROOT = packageRoot;
    await assert.rejects(runCodexInstall({ cwd, home, repoRoot }), /trusted Codex package|native executable|ENOENT/);
  } finally {
    if (previous === undefined) delete process.env.CODEX_MANAGED_PACKAGE_ROOT;
    else process.env.CODEX_MANAGED_PACKAGE_ROOT = previous;
  }
});

test("Codex-absent install and uninstall preserve local workflow without PATH probing", async t => {
  const tmp = await mkdtemp(join(tmpdir(), "muster-codex-absent-local-"));
  t.after(() => rm(tmp, { recursive: true, force: true }));
  const env = { ...process.env, HOME: join(tmp, "home"), CODEX_HOME: join(tmp, "home", ".codex"), PATH: "" };
  delete env.CODEX_MANAGED_PACKAGE_ROOT;
  for (const verb of ["install", "uninstall"]) {
    const { stdout } = await execFile(process.execPath, [join(repoRoot, "src", "cli.js"), verb, "codex", "--dry-run"], { cwd: join(tmp), env });
    assert.equal(JSON.parse(stdout).ok, true, verb);
  }
  const installed = await execFile(process.execPath,
    [join(repoRoot, "src", "cli.js"), "install", "codex", "--scope", "project"], { cwd: tmp, env });
  const receipt = JSON.parse(installed.stdout);
  assert.equal(receipt.ok, true);
  assert.equal(receipt.plugin.registered, false);
  assert.match(await readFile(join(tmp, ".codex", "config.toml"), "utf8"), /muster managed agent declarations/);
});

test("generated MCP host overlay pins canonical Node and doctor verifies Node, Codex entrypoint, and Codex version", async t => {
  const { tmp, marker, env, identity } = await fixture(t, "linux");
  const outDir = join(tmp, "plugins");
  const built = await buildCodexPlugin({ root: repoRoot, outDir, nodeExecPath: identity.node });
  const mcp = JSON.parse(await readFile(join(built.pluginRoot, ".mcp.json"), "utf8"));
  assert.equal(mcp.mcpServers.muster.command, identity.node);

  const calls = [];
  const execFile = async (file, args) => {
    calls.push({ file, args });
    if (args.at(-1) === "--version") return { stdout: "codex-cli 9.8.7\n" };
    if (args.includes("plugin")) return { stdout: JSON.stringify({ installed: [], available: [] }) };
    if (args.includes("mcp")) return { stdout: "[]" };
    return { stdout: "{}" };
  };
  const report = await runCodexDoctor({
    root: built.pluginRoot, cwd: join(tmp, "project"), codexHome: join(tmp, "codex-home"),
    execFile, runtimeIdentity: identity, env, mcpRunner: healthyHandshake,
  });
  const check = report.checks.find(item => item.name === "codex-runtime-identity");
  assert.equal(check?.ok, true, check?.detail);
  assert.match(check?.detail || "", /Node .*Codex .*9\.8\.7/);
  assert.ok(calls.length > 0 && calls.every(call => call.file === identity.node));
  assert.ok(calls.every(call => call.args[0] === identity.codex));
  await assert.rejects(readFile(marker), /ENOENT/);

  mcp.mcpServers.muster.args = ["./runtime/alternate.mjs"];
  await writeFile(join(built.pluginRoot, ".mcp.json"), JSON.stringify(mcp));
  const drifted = await runCodexDoctor({
    root: built.pluginRoot, cwd: join(tmp, "project"), codexHome: join(tmp, "codex-home"),
    execFile, runtimeIdentity: identity, env, mcpRunner: healthyHandshake,
  });
  assert.equal(drifted.checks.find(item => item.name === "codex-runtime")?.ok, false);

  mcp.mcpServers.muster.args = ["./runtime/muster-mcp.mjs"];
  mcp.mcpServers.evil = { command: identity.node, args: ["./runtime/alternate.mjs"], cwd: "." };
  mcp.untrusted = true;
  await writeFile(join(built.pluginRoot, ".mcp.json"), JSON.stringify(mcp));
  const extraServer = await runCodexDoctor({
    root: built.pluginRoot, cwd: join(tmp, "project"), codexHome: join(tmp, "codex-home"),
    execFile, runtimeIdentity: identity, env, mcpRunner: healthyHandshake,
  });
  assert.equal(extraServer.checks.find(item => item.name === "codex-runtime")?.ok, false);
});

test("Codex install invokes only the pinned runtime and emits canonical Node in every hook overlay", async t => {
  const { tmp, marker, identity } = await fixture(t, "linux");
  const calls = [];
  const execFile = async (file, args) => {
    calls.push({ file, args });
    const command = args.slice(1);
    if (command[0] === "--version") return { stdout: "codex-cli 9.8.7\n" };
    if (command.slice(0, 3).join(" ") === "plugin marketplace list") return { stdout: JSON.stringify({ marketplaces: [] }) };
    if (command.slice(0, 3).join(" ") === "plugin list --available") return { stdout: JSON.stringify({ installed: [] }) };
    return { stdout: "{}" };
  };
  const cwd = join(tmp, "project"), home = join(tmp, "home");
  await runCodexInstall({ cwd, home, repoRoot, execFile, runtimeIdentity: identity, nodeExecPath: identity.node });
  assert.ok(calls.length >= 4);
  assert.ok(calls.every(call => call.file === identity.node));
  assert.ok(calls.every(call => call.args[0] === identity.codex));
  const hooks = JSON.parse(await readFile(join(cwd, ".codex", "hooks.json"), "utf8"));
  const commands = Object.values(hooks.hooks).flatMap(groups => groups.flatMap(group => group.hooks));
  assert.ok(commands.length > 0);
  for (const hook of commands) {
    assert.equal(parseHookCommand(hook.command)?.interpreter, identity.node);
    assert.equal(parseHookCommand(hook.commandWindows, { windows: true })?.interpreter, identity.node);
  }
  await assert.rejects(readFile(marker), /ENOENT/);
});

test("Codex reinstall from a plugin root repairs a stale MCP Node identity", async t => {
  const { tmp, identity } = await fixture(t, "linux");
  const built = await buildCodexPlugin({ root: repoRoot, outDir: join(tmp, "plugins"), nodeExecPath: identity.node });
  const mcpPath = join(built.pluginRoot, ".mcp.json");
  const stale = JSON.parse(await readFile(mcpPath, "utf8"));
  stale.mcpServers.muster.command = join(tmp, "stale-node");
  await writeFile(mcpPath, JSON.stringify(stale, null, 2) + "\n");

  const execFile = async (_file, args) => {
    const command = args.slice(1);
    if (command[0] === "--version") return { stdout: "codex-cli 9.8.7\n" };
    if (command.slice(0, 3).join(" ") === "plugin marketplace list") return { stdout: JSON.stringify({ marketplaces: [] }) };
    if (command.slice(0, 3).join(" ") === "plugin list --available") return { stdout: JSON.stringify({ installed: [] }) };
    return { stdout: "{}" };
  };
  await runCodexInstall({
    cwd: join(tmp, "project"), home: join(tmp, "home"), repoRoot: built.pluginRoot,
    execFile, runtimeIdentity: identity, nodeExecPath: identity.node,
  });

  assert.deepEqual(JSON.parse(await readFile(mcpPath, "utf8")), {
    mcpServers: { muster: { command: identity.node, args: ["./runtime/muster-mcp.mjs"], cwd: "." } }
  });
});
