import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { buildCodexPlugin } from "../scripts/build-codex.mjs";
import { runCodexDoctor } from "../src/codex-doctor.js";
import { resolveCodexRuntimeIdentity, runCodexCommand } from "../src/codex-runtime-identity.js";
import { parseHookCommand, runCodexInstall } from "../src/codex-install.js";
import { CODEX_COUNTS } from "../src/codex.js";

const repoRoot = new URL("../", import.meta.url).pathname;
const healthyHandshake = async () => ({ initialized: true, tools: Array.from({ length: CODEX_COUNTS.mcpTools }, () => ({})), toolCallOk: true });

async function fixture(t, platform) {
  const tmp = await mkdtemp(join(tmpdir(), `muster-runtime-identity-${platform}-`));
  t.after(() => rm(tmp, { recursive: true, force: true }));
  const shadowBin = join(tmp, "shadow-bin"), marker = join(tmp, "shadow-ran");
  const packageRoot = join(tmp, "trusted", "@openai", "codex");
  await mkdir(join(packageRoot, "bin"), { recursive: true });
  await mkdir(shadowBin);
  await writeFile(join(packageRoot, "package.json"), JSON.stringify({ name: "@openai/codex", version: "9.8.7" }));
  await writeFile(join(packageRoot, "bin", "codex.js"), "#!/usr/bin/env node\n");
  const shadow = join(shadowBin, platform === "win32" ? "codex.cmd" : "codex");
  await writeFile(shadow, platform === "win32" ? `@echo shadow>${marker}\r\n` : `#!/bin/sh\nprintf shadow > '${marker}'\n`);
  await chmod(shadow, 0o755);
  const env = { ...process.env, PATH: `${shadowBin}${delimiter}${process.env.PATH || ""}`, CODEX_MANAGED_PACKAGE_ROOT: packageRoot };
  const identity = resolveCodexRuntimeIdentity({ env, platform, nodeExecPath: process.execPath });
  return { tmp, marker, env, identity, packageRoot };
}

for (const platform of ["linux", "win32"]) {
  test(`${platform}: fake PATH-precedence Codex is never executed and the trusted package entrypoint runs under canonical Node`, async t => {
    const { marker, env, identity } = await fixture(t, platform);
    const calls = [];
    const execFile = async (file, args) => {
      calls.push({ file, args });
      return { stdout: "codex-cli 9.8.7\n" };
    };
    await runCodexCommand(execFile, identity, ["--version"]);
    assert.equal(calls[0].file, await realpath(process.execPath));
    assert.deepEqual(calls[0].args, [identity.codex, "--version"]);
    assert.equal(identity.version, "9.8.7");
    await assert.rejects(readFile(marker), /ENOENT/);
    assert.equal(env.PATH.startsWith(marker), false);
  });
}

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
