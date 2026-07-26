import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmod, cp, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildCodexPlugin } from "../scripts/build-codex.mjs";
import { runCodexDoctor } from "../src/codex-doctor.js";
import { CODEX_COUNTS } from "../src/codex.js";

const repoRoot = fileURLToPath(new URL("../", import.meta.url));
const absentCodex = async () => { throw new Error("codex absent"); };
const healthyHandshake = async () => ({
  initialized: true,
  tools: new Array(CODEX_COUNTS.mcpTools).fill({}),
  toolCallOk: true
});

async function buildFixture(t) {
  const tmp = await mkdtemp(join(tmpdir(), "muster-codex-mcp-node-pin-"));
  t.after(() => import("node:fs/promises").then(({ rm }) => rm(tmp, { recursive: true, force: true })));
  const outDir = join(tmp, ".agents", "plugins");
  const built = await buildCodexPlugin({ root: repoRoot, outDir, nodeExecPath: process.execPath });
  return { tmp, outDir, plugin: built.pluginRoot };
}

async function doctorRuntime(plugin, tmp, platform = process.platform) {
  const report = await runCodexDoctor({
    root: plugin,
    cwd: join(tmp, "project"),
    codexHome: join(tmp, "home", ".codex"),
    execFile: absentCodex,
    mcpRunner: healthyHandshake,
    nodeExecPath: process.execPath,
    platform
  });
  return report.checks.find(check => check.name === "codex-runtime");
}

test("Linux/current: generated Codex MCP config pins the current canonical process.execPath", async t => {
  const { plugin, tmp } = await buildFixture(t);
  const mcp = JSON.parse(await readFile(join(plugin, ".mcp.json"), "utf8"));
  assert.equal(mcp.mcpServers.muster.command, process.execPath);
  assert.equal((await doctorRuntime(plugin, tmp, "linux"))?.ok, true);
});

test("Windows/missing: doctor rejects a vanished pinned MCP Node executable", async t => {
  const { plugin, tmp } = await buildFixture(t);
  const configPath = join(plugin, ".mcp.json");
  const mcp = JSON.parse(await readFile(configPath, "utf8"));
  mcp.mcpServers.muster.command = join(tmp, "missing", "node.exe");
  await writeFile(configPath, JSON.stringify(mcp, null, 2) + "\n");
  const runtime = await doctorRuntime(plugin, tmp, "win32");
  assert.equal(runtime?.ok, false);
  assert.match(runtime?.detail || "", /MCP Node executable.*missing|missing.*MCP Node executable/i);
});

test("Windows/stale: reinstall replaces an existing non-current MCP Node and is idempotent", async t => {
  const { plugin, tmp, outDir } = await buildFixture(t);
  const configPath = join(plugin, ".mcp.json");
  const staleNode = join(tmp, "stale-node.exe");
  await cp(process.execPath, staleNode);
  const mcp = JSON.parse(await readFile(configPath, "utf8"));
  mcp.mcpServers.muster.command = staleNode;
  await writeFile(configPath, JSON.stringify(mcp, null, 2) + "\n");

  const stale = await doctorRuntime(plugin, tmp, "win32");
  assert.equal(stale?.ok, false);
  assert.match(stale?.detail || "", /canonical identity|current Node/i);

  await buildCodexPlugin({ root: repoRoot, outDir, nodeExecPath: process.execPath });
  assert.equal(JSON.parse(await readFile(configPath, "utf8")).mcpServers.muster.command, process.execPath);
  const before = await stat(configPath);
  await buildCodexPlugin({ root: repoRoot, outDir, nodeExecPath: process.execPath });
  const after = await stat(configPath);
  assert.equal(after.mtimeMs, before.mtimeMs, "a current reinstall must be a byte-preserving cache hit");
});

test("Linux/malicious PATH shadow: MCP startup and nested CLI launch never execute bare node", async t => {
  const { plugin, tmp } = await buildFixture(t);
  const bin = join(tmp, "bin");
  const marker = join(tmp, "shadow-executed");
  await import("node:fs/promises").then(({ mkdir }) => mkdir(bin));
  const shadow = join(bin, "node");
  await writeFile(shadow, `#!/bin/sh\nprintf shadow > '${marker}'\nexit 97\n`);
  await chmod(shadow, 0o755);

  const entry = join(plugin, "runtime", "muster-mcp.mjs");
  const child = spawn(process.execPath, [entry], {
    cwd: tmp,
    env: { ...process.env, PATH: `${bin}:${process.env.PATH || ""}` },
    stdio: ["pipe", "pipe", "pipe"]
  });
  t.after(() => { if (!child.killed) child.kill("SIGKILL"); });
  let stdout = "", stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", chunk => { stdout += chunk; });
  child.stderr.on("data", chunk => { stderr += chunk; });
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }) + "\n");
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized", params: {} }) + "\n");
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "muster_detect", arguments: { dir: tmp } } }) + "\n");

  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`timed out waiting for MCP response; stdout=${stdout}; stderr=${stderr}`)), 10_000);
    const inspect = () => {
      if (!stdout.split("\n").some(line => line.includes('"id":2'))) return;
      clearTimeout(timeout);
      resolve();
    };
    child.stdout.on("data", inspect);
    child.once("error", reject);
    child.once("exit", code => code !== null && reject(new Error(`MCP exited ${code}; stdout=${stdout}; stderr=${stderr}`)));
  });
  child.kill();
  await assert.rejects(readFile(marker), /ENOENT/, "the PATH-shadow node must never execute");
});
