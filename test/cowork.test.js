import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const root = new URL("../", import.meta.url);
const read = (p) => readFile(new URL(p, root), "utf8");
const rootDir = fileURLToPath(root);
const execFileP = promisify(execFile);

// Drive the MCP server over stdio: send requests, resolve a map of id -> response
// once every id with an `id` has replied. Notifications (no id) expect no reply.
function rpc(requests, { timeout = 30_000 } = {}) {
  return new Promise((resolve, reject) => {
    const srv = spawn("node", [path.join(rootDir, "cowork", "mcp-server.mjs")], { cwd: rootDir, stdio: ["pipe", "pipe", "inherit"] });
    const want = new Set(requests.filter((r) => r.id != null).map((r) => r.id));
    const got = {};
    let buf = "";
    const timer = setTimeout(() => { srv.kill(); reject(new Error("rpc timeout")); }, timeout);
    srv.stdout.setEncoding("utf8");
    srv.stdout.on("data", (d) => {
      buf += d;
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        const msg = JSON.parse(line);
        if (msg.id != null) { got[msg.id] = msg; want.delete(msg.id); }
        if (want.size === 0) { clearTimeout(timer); srv.stdin.end(); resolve(got); }
      }
    });
    srv.on("error", reject);
    for (const r of requests) srv.stdin.write(JSON.stringify(r) + "\n");
  });
}

const INIT = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } } };

test("initialize: serverInfo.version matches package.json, instructions carry muster principles", async () => {
  const pkg = JSON.parse(await read("package.json"));
  const r = await rpc([INIT]);
  const res = r[1].result;
  assert.equal(res.serverInfo.name, "muster");
  assert.equal(res.serverInfo.version, pkg.version, "MCP serverInfo.version must track package.json");
  assert.ok(res.capabilities.tools, "advertises tools capability");
  assert.match(res.instructions, /muster principles/, "instructions inject guidance.js principles (hook replacement)");
});

test("instructions carry a Cowork execution protocol with the sequential (no-fan-out) fallback", async () => {
  const r = await rpc([INIT]);
  const instr = r[1].result.instructions;
  // Cowork has no orchestrator skill, so the server must teach the loop itself.
  assert.match(instr, /muster_detect/, "names the detect step");
  assert.match(instr, /muster_wave/, "names the wave step");
  assert.match(instr, /muster_manifest_validate/, "names the validate step");
  assert.match(instr, /sequential/i, "spells out the sequential fallback when fan-out is unavailable");
});

test("tools/list exposes exactly the 16 brain verbs, matching the MCPB manifest", async () => {
  const manifest = JSON.parse(await read("cowork/manifest.json"));
  const r = await rpc([INIT, { jsonrpc: "2.0", id: 2, method: "tools/list" }]);
  const served = r[2].result.tools.map((t) => t.name).sort();
  const declared = manifest.tools.map((t) => t.name).sort();
  assert.equal(served.length, 17, "17 tools served");
  assert.deepEqual(served, declared, "manifest tool list must match the server's actual tools (drift guard)");
  for (const t of r[2].result.tools) assert.ok(t.description && t.inputSchema, `${t.name} has description + inputSchema`);
});

test("string verb: muster_route returns valid JSON with a domain", async () => {
  const r = await rpc([INIT, { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "muster_route", arguments: { outcome: "fix a failing test" } } }]);
  const res = r[2].result;
  assert.equal(res.isError, false);
  assert.ok("domain" in JSON.parse(res.content[0].text), "route output parses to an object with a domain");
});

test("json verb: muster_wave computes dependency-ordered waves (diamond)", async () => {
  const manifest = { plan: [{ id: "a", deps: [] }, { id: "b", deps: ["a"] }, { id: "c", deps: ["a"] }] };
  const r = await rpc([INIT, { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "muster_wave", arguments: { manifest } } }]);
  const waves = JSON.parse(r[2].result.content[0].text);
  assert.equal(r[2].result.isError, false);
  assert.equal(waves.length, 2, "diamond collapses to 2 waves");
  assert.deepEqual(waves[0].map((s) => s.id), ["a"]);
  assert.deepEqual(waves[1].map((s) => s.id).sort(), ["b", "c"]);
});

test("json verb: muster_next drives sequentially (completed ids -> next runnable task)", async () => {
  const manifest = { plan: [{ id: "a", deps: [] }, { id: "b", deps: ["a"] }, { id: "c", deps: ["a"] }, { id: "d", deps: ["b", "c"] }] };
  const r = await rpc([INIT, { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "muster_next", arguments: { manifest, completed: ["a", "b", "c"] } } }]);
  const res = JSON.parse(r[2].result.content[0].text);
  assert.equal(r[2].result.isError, false);
  assert.equal(res.next.id, "d", "with a,b,c done the only runnable task is d");
  assert.equal(res.done, false);
});

test("error path: a CLI failure surfaces as isError, not a crash", async () => {
  const r = await rpc([INIT, { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "muster_route", arguments: {} } }]);
  assert.equal(r[2].result.isError, true, "missing required arg → isError");
  assert.match(r[2].result.content[0].text, /missing outcome/);
});

test("unknown method returns JSON-RPC method-not-found", async () => {
  const r = await rpc([INIT, { jsonrpc: "2.0", id: 2, method: "no/such/method" }]);
  assert.equal(r[2].error.code, -32601);
});

test("cowork/manifest.json version tracks package.json", async () => {
  const pkg = JSON.parse(await read("package.json"));
  const manifest = JSON.parse(await read("cowork/manifest.json"));
  assert.equal(manifest.version, pkg.version, "MCPB manifest version must match package.json");
});

// --- probe ---------------------------------------------------------------------

test("cowork-probe: phases 1+2 pass against this checkout (CLI portable, contract holds)", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "probe-spec-"));
  const probe = path.join(rootDir, "scripts", "cowork-probe.mjs");
  try {
    // --spec-out into a temp dir so the emitted phase-3 spec never pollutes the repo.
    const { stdout } = await execFileP("node", [probe, "--json", "--spec-out", path.join(dir, "spec.json")], { cwd: rootDir });
    const { results } = JSON.parse(stdout);
    const selfVerifying = results.filter((r) => r.phase === "cli" || r.phase === "contract");
    const fails = selfVerifying.filter((r) => r.status === "fail");
    assert.equal(fails.length, 0, `cli+contract phases must pass; failures: ${JSON.stringify(fails)}`);
    assert.ok(selfVerifying.some((r) => r.phase === "cli" && r.status === "pass"), "ran CLI probes");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("cowork-probe: grader rejects a bad dispatch run (exit 1)", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "probe-test-"));
  const file = path.join(dir, "bad.json");
  writeFileSync(file, JSON.stringify({ parallel: false, results: [{ id: "a", output: "ALPHA" }, { id: "b", output: "wrong" }, { id: "c", output: "GAMMA", modelReported: "sonnet" }] }));
  try {
    await execFileP("node", [path.join(rootDir, "scripts", "cowork-probe.mjs"), "--dispatch-results", file], { cwd: rootDir });
    assert.fail("probe should exit nonzero on a failing dispatch run");
  } catch (e) {
    assert.equal(e.code, 1, "nonzero exit on dispatch failure");
    assert.match(e.stdout, /per-call model override honored.*FAIL|FAIL.*model override/s);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
