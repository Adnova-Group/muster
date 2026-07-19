// codex-mcp-surface-gaps: the 2026-07-19 Codex dogfood fell back to the bundled CLI for
// 4 deterministic ops with no muster_* MCP equivalent (roles-only capabilities, skill
// matching, gate-cadence, receipt-verify). This is the end-to-end proof, through the
// BUILT Codex plugin's MCP server (mirrors test/codex-mcp-runtime-env.test.js's spawn
// pattern), that the new tools ride the actual bundle Codex loads, not just the shared
// cowork/mcp-server.mjs source.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile as execFileCb, spawn } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";
import { CODEX_COUNTS } from "../src/codex.js";
import { execFile, repoRoot, selectedPluginRoot } from "../test-support/codex-helpers.js";

const execFileP = promisify(execFileCb);

function rpc(entry, requests, { cwd = repoRoot, timeout = 15_000 } = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [entry], { cwd, stdio: ["pipe", "pipe", "pipe"] });
    const want = new Set(requests.filter((r) => r.id != null).map((r) => r.id));
    const got = {};
    let buf = "", stderr = "";
    const timer = setTimeout(() => { child.kill(); reject(new Error(`MCP rpc timed out: ${stderr}`)); }, timeout);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      buf += chunk;
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        const msg = JSON.parse(line);
        if (msg.id != null) { got[msg.id] = msg; want.delete(msg.id); }
        if (want.size === 0) { clearTimeout(timer); child.kill(); resolvePromise(got); }
      }
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", (error) => { clearTimeout(timer); reject(error); });
    for (const r of requests) child.stdin.write(JSON.stringify(r) + "\n");
  });
}

const INIT = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "surface-gaps-test", version: "1" } } };
const entry = () => join(selectedPluginRoot, "runtime", "muster-mcp.mjs");

test("built Codex plugin's MCP server: tools/list carries the 4 new tools and the new total count", async () => {
  const r = await rpc(entry(), [INIT, { jsonrpc: "2.0", id: 2, method: "tools/list" }]);
  const names = r[2].result.tools.map((t) => t.name);
  assert.equal(names.length, CODEX_COUNTS.mcpTools);
  for (const name of ["muster_receipt_verify", "muster_capabilities_roles", "muster_match_skills", "muster_gate_cadence"]) {
    assert.ok(names.includes(name), `tools/list must include ${name}`);
  }
});

test("built Codex plugin's MCP server: muster_capabilities_roles resolves against the Codex catalog, not inline (same --cowork -> --codex adapter as muster_capabilities)", async () => {
  // Functional companion to the tools/list presence check above: proves the
  // build-codex.mjs `--cowork` -> `--codex` swap actually took effect at
  // runtime for this NEW sibling tool, not just that the source text contains
  // the right substring (scripts/check-codex.mjs / build-codex.mjs's own
  // assertions only prove the latter). Without the swap this tool would
  // resolve every role through Cowork's registry inside the Codex-bundled
  // server -- the exact class of regression test/codex-mcp-runtime-env.test.js
  // already guards for muster_capabilities/muster_assess.
  const r = await rpc(entry(), [INIT, { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "muster_capabilities_roles", arguments: {} } }]);
  const res = r[2].result;
  assert.ok(res, "tools/call returned no result");
  assert.equal(res.isError, false, `muster_capabilities_roles errored: ${JSON.stringify(res?.content)}`);
  const body = JSON.parse(res.content[0].text);
  assert.equal(body.roles?.implement?.chosen?.id, "muster-builder", `implement must resolve to the named Codex profile, got ${JSON.stringify(body.roles?.implement?.chosen)}`);
  assert.notEqual(body.roles?.implement?.chosen?.source, "inline", "must not fall back to inline (the --cowork/--codex swap missing on this tool)");
  assert.equal(body.skills, undefined, "roles-only capture omits skills");
});

test("built Codex plugin's MCP server: muster_receipt_verify -- a REAL SHA from this checkout verifies true", async () => {
  const { stdout } = await execFileP("git", ["rev-parse", "HEAD"], { cwd: repoRoot });
  const sha = stdout.trim();
  const r = await rpc(entry(), [INIT, { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "muster_receipt_verify", arguments: { sha, cwd: repoRoot } } }]);
  const res = r[2].result;
  assert.ok(res, "tools/call returned no result");
  assert.equal(res.isError, false, `real SHA must not error: ${JSON.stringify(res.content)}`);
  const body = JSON.parse(res.content[0].text);
  assert.equal(body.verified, true);
  assert.equal(body.sha, sha);
});

test("built Codex plugin's MCP server: muster_receipt_verify -- a fabricated well-formed SHA verifies false", async () => {
  const fabricated = "f".repeat(40);
  const r = await rpc(entry(), [INIT, { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "muster_receipt_verify", arguments: { sha: fabricated, cwd: repoRoot } } }]);
  const res = r[2].result;
  assert.ok(res, "tools/call returned no result");
  assert.equal(res.isError, true, "an unverified SHA's non-zero CLI exit surfaces as isError");
  const body = JSON.parse(res.content[0].text);
  assert.equal(body.verified, false);
});

test("packaged Codex build script keeps check-codex.mjs's MCP tool-count regex coherent", async () => {
  const { stdout } = await execFile(process.execPath, [join(repoRoot, "scripts", "check-codex.mjs")], { cwd: repoRoot });
  const result = JSON.parse(stdout);
  assert.equal(result.ok, true, `check-codex.mjs must report ok:true: ${stdout}`);
  assert.equal(result.counts.mcpTools, CODEX_COUNTS.mcpTools);
});
