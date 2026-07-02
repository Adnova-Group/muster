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
  assert.match(instr, /muster_next.*fan-out is unavailable|fan-out is unavailable/i, "spells out the no-fan-out fallback via muster_next");
});

test("instructions cover the full autopilot/audit/diagnose lifecycle (dispatch confirmed on Cowork)", async () => {
  const r = await rpc([INIT]);
  const instr = r[1].result.instructions;
  assert.match(instr, /parallel/i, "leads with parallel fan-out now that dispatch is confirmed");
  assert.match(instr, /branch/i, "autopilot branches first");
  assert.match(instr, /commit/i, "commits per wave");
  assert.match(instr, /merge/i, "presents the merge decision");
  assert.match(instr, /muster_fuse/, "fusion gate via muster_fuse (muster_pick may appear as fallback ranker)");
  assert.match(instr, /muster_tally/, "review gate via muster_tally");
  assert.match(instr, /audit/i, "audit mode described");
  assert.match(instr, /diagnose/i, "diagnose mode described");
});

test("tools/list exposes exactly the 19 brain verbs, matching the MCPB manifest", async () => {
  const manifest = JSON.parse(await read("cowork/manifest.json"));
  const r = await rpc([INIT, { jsonrpc: "2.0", id: 2, method: "tools/list" }]);
  const served = r[2].result.tools.map((t) => t.name).sort();
  const declared = manifest.tools.map((t) => t.name).sort();
  assert.equal(served.length, 19, "19 tools served");
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

test("tools/call: muster_advise validates an advice-request and returns advisorModel", async () => {
  const request = { question: "Should we add caching here?", context: "Hot path, called 1000x/s.", decisionType: "architecture" };
  const r = await rpc([INIT, { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "muster_advise", arguments: { request } } }]);
  const res = r[2].result;
  assert.equal(res.isError, false, "valid advice-request must not error");
  const out = JSON.parse(res.content[0].text);
  assert.ok("advisorModel" in out, "output must contain advisorModel");
});

test("tools/call: muster_fuse validates candidates+fusion-map and returns a mode field", async () => {
  const candidates = [
    { id: "a", total: 3, passing: true, content: "Alpha answer" },
    { id: "b", total: 3, passing: true, content: "Beta answer" },
  ];
  const fusionMap = {
    consensus: ["Both use caching"],
    contradictions: ["Alpha prefers Redis; Beta prefers in-memory"],
    partialCoverage: [],
    uniqueInsights: [],
    blindSpots: [],
  };
  const r = await rpc([INIT, { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "muster_fuse", arguments: { candidates, fusionMap } } }]);
  const res = r[2].result;
  assert.equal(res.isError, false, "valid fuse call must not error");
  const out = JSON.parse(res.content[0].text);
  assert.ok("mode" in out, "fuse output must contain a mode field");
  assert.equal(out.mode, "fuse", `fusionMap with contradictions + 2 passing candidates must reach mode:fuse, not fallback (got: ${out.mode})`);
  assert.ok(Array.isArray(out.synthesizerInput?.references), "synthesizerInput.references must be an array");
  assert.ok(out.synthesizerInput?.fusionMap, "synthesizerInput.fusionMap must be present");
});

test("tools/call: muster_audit (kind=none) returns non-error JSON", async () => {
  const r = await rpc([INIT, { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "muster_audit", arguments: {} } }]);
  const res = r[2].result;
  assert.equal(res.isError, false, "muster_audit must not error");
  assert.doesNotThrow(() => JSON.parse(res.content[0].text), "muster_audit output must be valid JSON");
});

test("ping returns an empty result object", async () => {
  const r = await rpc([INIT, { jsonrpc: "2.0", id: 2, method: "ping" }]);
  assert.deepEqual(r[2].result, {}, "ping result must be {}");
});

test("notifications/initialized produces no spurious reply", async () => {
  const r = await rpc([
    INIT,
    { jsonrpc: "2.0", method: "notifications/initialized" }, // notification: no id, server must not reply
    { jsonrpc: "2.0", id: 2, method: "ping" },
  ]);
  assert.deepEqual(Object.keys(r).sort(), ["1", "2"], "server must not emit a reply to the notification");
  assert.deepEqual(r[2].result, {}, "server continues to handle requests normally after notification");
});

// ── A-SEC6: stdin buffer overflow guard ─────────────────────────────────────
// The stdin accumulator is unbounded; a client that sends >4 MB without a
// newline would exhaust the server's heap. The cap must cause a clean exit
// (not an uncaught exception crash) before the newline arrives.
test("A-SEC6: stdin buffer >4 MB without newline causes clean non-zero exit", async () => {
  const LIMIT = 4 * 1024 * 1024;
  const OVER = LIMIT + 1;
  const chunk = Buffer.alloc(OVER, 0x78); // 0x78 = 'x', no newline

  const exitCode = await new Promise((resolve, reject) => {
    const srv = spawn("node", [path.join(rootDir, "cowork", "mcp-server.mjs")], {
      cwd: rootDir,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const timer = setTimeout(() => { srv.kill("SIGKILL"); reject(new Error("A-SEC6 test timeout")); }, 8000);
    srv.on("exit", (code) => { clearTimeout(timer); resolve(code); });
    srv.on("error", (e) => { clearTimeout(timer); reject(e); });
    // Write the oversized chunk without a newline so it accumulates in buffer.
    srv.stdin.write(chunk);
    // Leave stdin open — the server must self-terminate on overflow.
  });

  // Must exit non-zero (cap triggered) and with a code < 128 (not a signal kill).
  assert.ok(exitCode !== null, "server must exit, not hang");
  assert.notEqual(exitCode, 0, "overflow must cause non-zero exit (cap enforced)");
  assert.ok(exitCode < 128, `expected a clean exit code < 128, got ${exitCode}`);
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
