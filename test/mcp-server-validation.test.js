import { test } from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("../", import.meta.url));
const serverPath = path.join(repoRoot, "cowork", "mcp-server.mjs");
const INIT = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } } };

function rpc(requests, { env = process.env } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [serverPath], { cwd: repoRoot, env, stdio: ["pipe", "pipe", "pipe"] });
    const wanted = new Set(requests.filter((request) => Object.hasOwn(request, "id")).map((request) => request.id));
    const responses = new Map();
    let stdout = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("MCP response timeout"));
    }, 20_000);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      let newline;
      while ((newline = stdout.indexOf("\n")) >= 0) {
        const line = stdout.slice(0, newline).trim();
        stdout = stdout.slice(newline + 1);
        if (!line) continue;
        const response = JSON.parse(line);
        responses.set(response.id, response);
        wanted.delete(response.id);
        if (wanted.size === 0) {
          clearTimeout(timer);
          child.stdin.end();
          resolve(responses);
        }
      }
    });
    child.on("error", reject);
    for (const request of requests) child.stdin.write(JSON.stringify(request) + "\n");
  });
}

test("MCP rejects invalid envelopes and params with JSON-RPC errors", async () => {
  const responses = await rpc([
    INIT,
    { id: 2, method: "ping" },
    { jsonrpc: "2.0", id: 3, method: "tools/call", params: [] },
  ]);
  assert.deepEqual(responses.get(2).error, { code: -32600, message: "Invalid Request" });
  assert.deepEqual(responses.get(3).error, { code: -32602, message: "Invalid params" });
});

test("tools/call enforces enum, additional-property, and array-bound constraints from advertised schemas", async () => {
  const tooManyReceipts = Array.from({ length: 10_001 }, (_, index) => ({
    id: `r${index}`, itemId: "item", phase: "review", status: "completed",
  }));
  const responses = await rpc([
    INIT,
    { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "muster_prioritize", arguments: { items: [], model: "bogus" } } },
    { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "muster_design", arguments: { action: "status", dir: repoRoot, planted: true } } },
    { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "muster_sprint_reconcile", arguments: { plan: {}, receipts: tooManyReceipts, inFlight: [] } } },
  ]);
  for (const id of [2, 3, 4]) {
    assert.equal(responses.get(id).error.code, -32602);
    assert.match(responses.get(id).error.message, /^Invalid params:/);
  }
});

test("CLI dispatch uses process.execPath, preserves Windows runtime variables, and excludes unrelated host variables", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "muster-mcp-runtime-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const fakeCli = path.join(dir, "fake-cli.mjs");
  const shadowNode = path.join(dir, process.platform === "win32" ? "node.cmd" : "node");
  await writeFile(fakeCli, "console.log(JSON.stringify({runtime:process.execPath,canary:process.env.UNRELATED_SECRET??null,systemRoot:process.env.SystemRoot??null,comSpec:process.env.ComSpec??null}))\n");
  await writeFile(shadowNode, process.platform === "win32" ? "@echo SHADOWED\r\n" : "#!/bin/sh\necho SHADOWED\n");
  if (process.platform !== "win32") await chmod(shadowNode, 0o755);
  const responses = await rpc([
    INIT,
    { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "muster_detect", arguments: { dir: repoRoot } } },
  ], {
    env: {
      ...process.env,
      PATH: dir,
      NODE_ENV: "test",
      SystemRoot: "C:\\Windows",
      ComSpec: "C:\\Windows\\System32\\cmd.exe",
      MUSTER_COWORK_TEST_CLI: fakeCli,
      UNRELATED_SECRET: "must-not-cross",
    },
  });
  const result = responses.get(2).result;
  assert.equal(result.isError, false);
  assert.deepEqual(JSON.parse(result.content[0].text), {
    runtime: process.execPath,
    canary: null,
    systemRoot: "C:\\Windows",
    comSpec: "C:\\Windows\\System32\\cmd.exe",
  });
});
