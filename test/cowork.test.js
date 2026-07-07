import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { mkdtempSync, writeFileSync, rmSync, renameSync } from "node:fs";
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

// ── P1-8: contract pin — cowork→guidance coupling ───────────────────────────
// mcp-server.mjs serves guidance-derived content (the `instructions` field above
// is built from PRINCIPLES/VERBS/ROUTING_POLICY) by importing those named bindings
// directly from plugin/hooks/guidance.js. If a hook refactor renames or drops one
// of those exports, mcp-server.mjs breaks silently with no test naming the gap.
// Import BOTH sides and compare: parse mcp-server.mjs's actual import statement,
// then check every named import is really exported by guidance.js — a hook
// refactor that drops/renames one of these fails this test loudly, by name.
test("contract pin: mcp-server.mjs's guidance.js imports all exist in guidance.js's export surface", async () => {
  const serverSrc = await read("cowork/mcp-server.mjs");
  const importLine = serverSrc.match(/import\s*\{([^}]+)\}\s*from\s*["']\.\.\/plugin\/hooks\/guidance\.js["'];/);
  assert.ok(importLine, "mcp-server.mjs must import named bindings from plugin/hooks/guidance.js");
  const names = importLine[1].split(",").map((s) => s.trim()).filter(Boolean);
  assert.ok(names.length > 0, "mcp-server.mjs must import at least one named binding from guidance.js");
  const guidance = await import("../plugin/hooks/guidance.js");
  for (const name of names) {
    assert.ok(name in guidance, `guidance.js must export "${name}" (imported by mcp-server.mjs) — a hook refactor dropped/renamed it`);
  }
  // Pin today's exact set so a silent rename is caught even if the property check above
  // would otherwise pass against some unrelated re-export.
  assert.deepEqual(
    names.slice().sort(),
    ["PRINCIPLES", "ROUTING_POLICY", "VERBS"],
    "mcp-server.mjs's guidance.js import set must stay exactly this triple",
  );
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

// ── verb rename: cowork/mcp-server.mjs, cowork/sprint-protocol.md, cowork/README.md ─────────
// These three surfaces enumerated the pre-rename verbs (autopilot/audit/diagnose/run) with no
// plan/go/plan-backlog/go-backlog anywhere, and sprint-protocol.md cited plugin/commands/sprint.md
// (now an 8-line alias stub) as the source of "the full autopilot lifecycle" instead of citing
// go-backlog.md where that content now lives. Pin the new lexicon so a future rename regression
// is caught by name, not just by a stale-prose report.
test("verb-rename: COWORK_PROTOCOL's By-intent list uses plan/go/plan-backlog/go-backlog, not the pre-rename autopilot/run bullets", async () => {
  const r = await rpc([INIT]);
  const instr = r[1].result.instructions;
  assert.match(instr, /- plan \(approve-first\)/, "plan bullet present");
  assert.match(instr, /- go \(hands-off\)/, "go bullet present");
  assert.match(instr, /plan-backlog/, "plan-backlog named in the by-intent list");
  assert.match(instr, /go-backlog/, "go-backlog named in the by-intent list");
  assert.doesNotMatch(instr, /- autopilot \(/, "no pre-rename autopilot bullet");
  assert.doesNotMatch(instr, /- run: do the core loop/, "no pre-rename run bullet");
  assert.match(
    instr,
    /Legacy aliases still work: run -> plan, autopilot -> go, sprint -> go-backlog\./,
    "aliases noted once, matching guidance.js's convention",
  );
});

test("verb-rename: sprint-protocol.md cites go-backlog.md (not the sprint.md alias stub) and uses go, not autopilot", async () => {
  const text = await read("cowork/sprint-protocol.md");
  const norm = text.replace(/\s+/g, " ");
  assert.match(norm, /port of `\/muster:go-backlog`'s lifecycle \(`plugin\/commands\/go-backlog\.md`\)/, "citation repoints to go-backlog.md");
  assert.doesNotMatch(text, /plugin\/commands\/sprint\.md/, "no more citation of the alias-stub sprint.md");
  assert.match(norm, /driving the full go lifecycle sequentially/, "'go lifecycle', not 'autopilot lifecycle'");
  assert.match(norm, /single go pass/, "'go pass', not 'autopilot pass'");
  assert.match(norm, /There is no `\/muster:go-backlog` grammar/, "no-slash-verbs bullet cites the current verb name");
  assert.match(norm, /the "Degradation" path in `go-backlog\.md`/, "Degradation citation repoints to go-backlog.md");
  assert.match(norm, /`\/muster:sprint` still works as the legacy alias of `\/muster:go-backlog`/, "alias noted once");
  assert.match(text, /## Sprint/, "the '## Sprint' STATE-heading cross-repo convention stays untouched");
});

test("verb-rename: README.md enumeration uses plan/go/plan-backlog/go-backlog and cites /muster:go-backlog", async () => {
  const text = await read("cowork/README.md");
  const norm = text.replace(/\s+/g, " ");
  assert.match(norm, /full orchestration lifecycle \(plan, go, plan-backlog, diagnose, audit, go-backlog\)/, "lifecycle enumeration uses the new lexicon");
  assert.doesNotMatch(norm, /\(autopilot, audit, diagnose\)/, "no pre-rename enumeration");
  assert.match(norm, /the core loop plus the plan\/go\/plan-backlog\/diagnose\/audit\/go-backlog lifecycles/, "protocol-summary sentence uses the new lexicon");
  assert.doesNotMatch(norm, /autopilot\/audit\/diagnose\/run lifecycles/, "no pre-rename lifecycle slash-list");
  assert.match(norm, /Claude Code plugin's `\/muster:go-backlog` lifecycle/, "sprint citation repoints to /muster:go-backlog");
  assert.doesNotMatch(norm, /Claude Code plugin's `\/muster:sprint` lifecycle/, "no more citation of the pre-rename /muster:sprint verb");
  assert.match(norm, /the per-item go lifecycle/, "per-item lifecycle uses go, not autopilot");
  assert.doesNotMatch(norm, /the per-item autopilot lifecycle/, "no pre-rename per-item autopilot phrase");
  assert.match(norm, /legacy aliases/i, "aliases noted once");
});

test("verb-rename: zero pre-rename verb-name citations remain in the 3 cowork surfaces outside their one alias note", async () => {
  const files = ["cowork/mcp-server.mjs", "cowork/sprint-protocol.md", "cowork/README.md"];
  for (const f of files) {
    const raw = await read(f);
    // Drop the line(s) whose whole purpose is noting the still-working legacy aliases -- those
    // are allowed, and required, to name the pre-rename verbs exactly once.
    const withoutAliasNotes = raw.split("\n").filter((line) => !/legacy alias/i.test(line)).join("\n");
    assert.doesNotMatch(withoutAliasNotes, /\bautopilot\b/i, `${f}: no bare "autopilot" outside the alias note`);
    assert.doesNotMatch(withoutAliasNotes, /plugin\/commands\/sprint\.md/, `${f}: no citation of the alias-stub sprint.md`);
    assert.doesNotMatch(withoutAliasNotes, /`\/muster:sprint`/, `${f}: no bare /muster:sprint citation outside the alias note`);
  }
});

test("tools/list exposes exactly the 21 brain verbs, matching the MCPB manifest", async () => {
  const manifest = JSON.parse(await read("cowork/manifest.json"));
  const r = await rpc([INIT, { jsonrpc: "2.0", id: 2, method: "tools/list" }]);
  const served = r[2].result.tools.map((t) => t.name).sort();
  const declared = manifest.tools.map((t) => t.name).sort();
  assert.equal(served.length, 21, "21 tools served");
  assert.deepEqual(served, declared, "manifest tool list must match the server's actual tools (drift guard)");
  for (const t of r[2].result.tools) assert.ok(t.description && t.inputSchema, `${t.name} has description + inputSchema`);
});

test("tools/call: muster_sprint_protocol returns the sprint playbook text with key protocol markers", async () => {
  const r = await rpc([INIT, { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "muster_sprint_protocol", arguments: {} } }]);
  const res = r[2].result;
  assert.equal(res.isError, false, "muster_sprint_protocol must not error");
  const text = res.content[0].text;
  assert.match(text, /wave/i, "mentions wave-mode execution");
  assert.match(text, /claim/i, "mentions claim discipline");
  assert.match(text, /\bpr\b/i, "mentions the pr disposition");
  const onDisk = await read("cowork/sprint-protocol.md");
  assert.equal(text, onDisk.trim(), "served text must match the checked-in cowork/sprint-protocol.md verbatim (drift guard)");
});

test("F3: missing cowork/sprint-protocol.md at module load does not crash the server; muster_sprint_protocol surfaces isError naming the file", async () => {
  const protocolPath = path.join(rootDir, "cowork", "sprint-protocol.md");
  const backupPath = path.join(rootDir, "cowork", "sprint-protocol.md.f3-test-bak");
  renameSync(protocolPath, backupPath);
  try {
    // Server must still start and answer other requests (ping) with the file gone.
    const r = await rpc([
      INIT,
      { jsonrpc: "2.0", id: 2, method: "ping" },
      { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "muster_sprint_protocol", arguments: {} } },
    ]);
    assert.deepEqual(r[2].result, {}, "server stays alive and answers unrelated requests");
    const res = r[3].result;
    assert.equal(res.isError, true, "missing sprint-protocol.md must surface as isError, not crash the server");
    assert.match(res.content[0].text, /sprint-protocol\.md/, "error text names the missing file");
  } finally {
    renameSync(backupPath, protocolPath);
  }
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

test("file verb: muster_sprint_waves computes dependency-ordered waves from a backlog's {id}/{deps} annotations", async () => {
  const backlog = [
    "- [ ] Task A {id: a}",
    "- [ ] Task B {id: b} {deps: a}",
    "- [ ] Task C {id: c} {deps: a}",
  ].join("\n");
  const r = await rpc([INIT, { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "muster_sprint_waves", arguments: { backlog } } }]);
  const res = JSON.parse(r[2].result.content[0].text);
  assert.equal(r[2].result.isError, false);
  assert.equal(res.ok, true);
  assert.equal(res.annotated, true, "explicit {id}/{deps} annotations mark the backlog annotated");
  assert.deepEqual(res.waves[0], ["a"]);
  assert.deepEqual(res.waves[1].sort(), ["b", "c"]);
});

test("file verb: muster_sprint_waves on an unannotated backlog returns annotated:false, sequential waves", async () => {
  const backlog = ["- [ ] Do first", "- [ ] Do second"].join("\n");
  const r = await rpc([INIT, { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "muster_sprint_waves", arguments: { backlog } } }]);
  const res = JSON.parse(r[2].result.content[0].text);
  assert.equal(r[2].result.isError, false);
  assert.equal(res.ok, true);
  assert.equal(res.annotated, false, "no {id}/{deps} annotations -> unannotated/sequential");
  assert.deepEqual(res.waves, [["item-1"], ["item-2"]]);
});

test("file verb: muster_sprint_waves surfaces ok:false backlog errors (exit 2) the same way manifest_validate does", async () => {
  const backlog = "- [ ] Task A {id: not valid!}";
  const r = await rpc([INIT, { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "muster_sprint_waves", arguments: { backlog } } }]);
  // Sibling behavior (muster_manifest_validate): the CLI exits 2 on ok:false, execFile
  // rejects, and the server surfaces that as isError:true — the JSON payload (still
  // parseable, still carrying ok:false + errors) rides in the error text verbatim.
  const res = JSON.parse(r[2].result.content[0].text);
  assert.equal(r[2].result.isError, true, "CLI exit 2 on ok:false surfaces as isError:true, matching muster_manifest_validate");
  assert.equal(res.ok, false);
  assert.ok(res.errors.length > 0, "invalid id annotation reported in errors");
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

// ── P2-20: 'str' kind, omitted optional arg hits the no-value argv branch ──
// callTool's `kind === "str"` branch: `v != null && v !== "" ? [...tool.argv, String(v)] : tool.argv`.
// muster_detect's `dir` prop is optional (S(..., "dir", false)) — omitting it must take the
// `: tool.argv` side (no value appended), invoking the CLI with just ["detect"].
test("tools/call: muster_detect with omitted optional dir arg hits the no-value argv branch (str kind)", async () => {
  const r = await rpc([INIT, { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "muster_detect", arguments: {} } }]);
  const res = r[2].result;
  assert.equal(res.isError, false, "omitted optional str arg must not error");
  const detected = JSON.parse(res.content[0].text);
  assert.ok(detected && typeof detected === "object", "detect output parses to an object (server's own cwd, no dir arg passed)");
});

// ── P2-20: an unknown-method NOTIFICATION (no id) is a silent no-op ─────────
// `handle`'s default case only calls err() `if (!isNotification)` — an unrecognized
// method arriving as a notification (no id) must produce no reply at all, and the
// server must keep handling subsequent requests normally (mirrors the
// notifications/initialized no-op test above, but for an unknown method).
test("unknown-method notification (no id) produces no reply and the server keeps handling requests", async () => {
  const r = await rpc([
    INIT,
    { jsonrpc: "2.0", method: "notifications/some-unknown-thing" }, // notification: no id, unrecognized method
    { jsonrpc: "2.0", id: 2, method: "ping" },
  ]);
  assert.deepEqual(Object.keys(r).sort(), ["1", "2"], "server must not emit a reply to the unknown-method notification");
  assert.deepEqual(r[2].result, {}, "server continues to handle requests normally after the notification");
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

// ── B-C4: unknown tool name ───────────────────────────────────────────────────
test("B-C4: tools/call with unknown tool name returns isError:true and 'unknown tool'", async () => {
  const r = await rpc([INIT, {
    jsonrpc: "2.0", id: 2, method: "tools/call",
    params: { name: "muster_does_not_exist", arguments: {} },
  }]);
  const res = r[2].result;
  assert.equal(res.isError, true, "unknown tool must return isError:true");
  assert.match(res.content[0].text, /unknown tool/, "error text must mention 'unknown tool'");
});

// ── B-C6: garbled non-JSON line survival ─────────────────────────────────────
// Server skips unparseable lines (continue in catch); valid subsequent request
// must still be processed normally (the server must not crash).
test("B-C6: garbled non-JSON line before a valid ping — server survives and replies", async () => {
  const pingId = 42;
  const result = await new Promise((resolve, reject) => {
    const srv = spawn("node", [path.join(rootDir, "cowork", "mcp-server.mjs")], {
      cwd: rootDir, stdio: ["pipe", "pipe", "inherit"],
    });
    let buf = "";
    const timer = setTimeout(() => { srv.kill(); reject(new Error("B-C6 timeout")); }, 15_000);
    srv.stdout.setEncoding("utf8");
    srv.stdout.on("data", (d) => {
      buf += d;
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        try {
          const msg = JSON.parse(line);
          if (msg.id === pingId) { clearTimeout(timer); srv.stdin.end(); resolve(msg); }
        } catch { /* non-JSON output — ignore */ }
      }
    });
    srv.on("error", reject);
    // Send: INIT (required), then a garbled line, then a valid ping.
    srv.stdin.write(JSON.stringify(INIT) + "\n");
    srv.stdin.write("}{garbled non-JSON line that must be skipped\n");
    srv.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: pingId, method: "ping" }) + "\n");
  });
  assert.deepEqual(result.result, {}, "ping reply must arrive after the garbled line is skipped");
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
