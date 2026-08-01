import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { mkdtempSync, writeFileSync, readFileSync, rmSync, renameSync, readdirSync, mkdirSync, copyFileSync } from "node:fs";
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
function rpc(requests, { timeout = 30_000, env = {}, serverPath, cwd } = {}) {
  return new Promise((resolve, reject) => {
    const srv = spawn("node", [serverPath || path.join(rootDir, "cowork", "mcp-server.mjs")], {
      cwd: cwd || rootDir,
      env: { ...process.env, ...env },
      stdio: ["pipe", "pipe", "inherit"],
    });
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

test("MCP architecture uses one neutral core and thin explicit host adapters", async () => {
  const [core, coworkShim, workShim, codexAdapter, workAdapter] = await Promise.all([
    read("mcp/server.mjs"),
    read("cowork/mcp-server.mjs"),
    read("cowork/chatgpt-work-server.mjs"),
    read("mcp/codex-server.mjs"),
    read("mcp/chatgpt-work-server.mjs"),
  ]);
  assert.match(core, /export\s+(?:async\s+)?function startMusterMcpServer/);
  assert.match(core, /const TOOLS =/);
  assert.doesNotMatch(core, /MUSTER_MCP_HOST|MUSTER_MCP_TOOL_PROFILE/, "core does not infer host or profile from env");
  assert.doesNotMatch(core, /MUSTER_CHATGPT_WORK_PROBE_ATTESTATION_PATH/, "Work startup policy stays in its adapter");
  for (const [name, source] of [["cowork shim", coworkShim], ["work shim", workShim], ["codex adapter", codexAdapter]]) {
    assert.doesNotMatch(source, /const TOOLS =|class WorkLimiter/, `${name} does not fork the core`);
  }
  for (const [name, source] of [["cowork adapter", coworkShim], ["codex adapter", codexAdapter], ["work adapter", workAdapter]]) {
    assert.match(source, /startMusterMcpServer\s*\(\s*\{/, `${name} explicitly starts the factory`);
    assert.match(source, /protocol\s*:/, `${name} supplies its protocol`);
    assert.match(source, /mapArgv\s*:/, `${name} supplies argv mapping`);
    assert.match(source, /authorizeTools\s*:/, `${name} supplies tool authorization`);
    assert.match(source, /runtimeIdentity\s*:/, `${name} supplies runtime identity`);
  }
  assert.match(workShim, /\.\.\/mcp\/chatgpt-work-server\.mjs/, "legacy Work entrypoint remains a thin compatibility shim");

  const direct = await execFileP(process.execPath, [path.join(rootDir, "mcp", "server.mjs")]);
  assert.equal(direct.stdout, "", "direct core execution is inert");
  assert.equal(direct.stderr, "", "direct core execution emits no startup diagnostic");
});

test("Codex adapter output is byte-isolated from Cowork argv and Work probe machinery", async () => {
  const r = await rpc([
    INIT,
    { jsonrpc: "2.0", id: 2, method: "tools/list" },
  ], { serverPath: path.join(rootDir, "mcp", "codex-server.mjs") });
  const bytes = JSON.stringify(r);
  assert.doesNotMatch(bytes, /Cowork|--cowork|WORK_WEB_PROBE|probe attestation/i);
  assert.match(bytes, /Codex/);
});

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
  const serverSrc = await read("mcp/server.mjs");
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
  assert.match(instr, /default[\s\S]{0,120}muster_next|muster_next[\s\S]{0,120}default/i, "defaults to the verified sequential driver");
  assert.match(instr, /phase-?3[\s\S]{0,180}parallel/i, "requires phase-3 evidence before optional fan-out");
  assert.doesNotMatch(instr, /parallel fan-out and per-call model override both work|confirmed to support parallel/i);
});

test("instructions cover the seven-mode MCP protocol subset and sequential fallback", async () => {
  const r = await rpc([INIT]);
  const instr = r[1].result.instructions;
  assert.match(instr, /parallel/i, "documents the phase-3-gated optional fan-out");
  assert.match(instr, /branch/i, "autopilot branches first");
  assert.match(instr, /commit/i, "commits per wave");
  assert.match(instr, /merge/i, "presents the merge decision");
  assert.match(instr, /muster_fuse/, "fusion gate via muster_fuse (muster_pick may appear as fallback ranker)");
  assert.match(instr, /muster_tally/, "review gate via muster_tally");
  assert.match(instr, /audit/i, "audit mode described");
  assert.match(instr, /diagnose/i, "diagnose mode described");
});

test("instructions document both CLI-only surface gaps: muster_match_skills' --stack override and codex-conformance", async () => {
  const r = await rpc([INIT]);
  const instr = r[1].result.instructions;
  assert.match(instr, /CLI-only/i, "names a CLI-only operations note");
  assert.match(instr, /--stack/, "names the un-exposed --stack override");
  assert.match(instr, /codex-conformance/, "names codex-conformance as CLI-only");
});

// ── verb rename: cowork/mcp-server.mjs, cowork/sprint-protocol.md, cowork/README.md ─────────
// These three surfaces enumerated the pre-rename verbs (autopilot/audit/diagnose/run) with no
// plan/go/plan-backlog/go-backlog anywhere, and sprint-protocol.md cited plugin/commands/sprint.md
// (now a minimal delegation stub) as the source of "the full autopilot lifecycle" instead of citing
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
  assert.match(norm, /driving every item through the full go lifecycle/, "'go lifecycle', not 'autopilot lifecycle'");
  assert.match(norm, /single go pass/, "'go pass', not 'autopilot pass'");
  assert.match(norm, /There is no `\/muster:go-backlog` grammar/, "no-slash-verbs bullet cites the current verb name");
  assert.match(norm, /the "Degradation" path in `go-backlog\.md`/, "Degradation citation repoints to go-backlog.md");
  assert.match(norm, /`\/muster:sprint` still works as the legacy alias of `\/muster:go-backlog`/, "alias noted once");
  assert.match(text, /## Sprint/, "the '## Sprint' STATE-heading cross-repo convention stays untouched");
});

test("Cowork sprint protocol consumes the emitted build/barrier/integration schedule", async () => {
  const text = await read("cowork/sprint-protocol.md");
  const norm = text.replace(/\s+/g, " ");
  assert.match(norm, /schedule\.waves/, "annotated mode must consume the emitted per-wave schedule");
  assert.match(norm, /buildReview\.batches/, "the emitted cap-sized build batches are authoritative");
  assert.match(norm, /sequential-isolated/, "Cowork degradation must preserve isolated build/review legs");
  assert.match(norm, /all-build-review-complete/, "integration must wait for the emitted build/review barrier");
  assert.match(norm, /integration\.itemIds/, "only the emitted ordered integration ids may touch the base");
  assert.match(norm, /annotated:false.*flat.*sequential/i, "plain backlogs must retain the flat sequential path");
  assert.doesNotMatch(
    norm,
    /every wave executed sequentially, one item at a time, in the main tree/,
    "Cowork must not collapse isolated build/review and integration into one main-tree loop",
  );
});

test("verb-rename: README.md enumeration uses plan/go/plan-backlog/go-backlog and cites /muster:go-backlog", async () => {
  const text = await read("cowork/README.md");
  const norm = text.replace(/\s+/g, " ");
  assert.match(norm, /seven-mode MCP protocol subset \(Plan, Go, Plan-backlog, Go-backlog, Diagnose, Audit, and Design\)/, "MCP protocol subset uses the new lexicon");
  assert.doesNotMatch(norm, /\(autopilot, audit, diagnose\)/, "no pre-rename enumeration");
  assert.match(norm, /the core loop plus the Plan\/Go\/Plan-backlog\/Go-backlog\/Diagnose\/Audit\/Design lifecycles/, "protocol-summary sentence uses the exact seven-mode subset");
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

test("tools/list exposes exactly the 31 brain verbs, matching the MCPB manifest", async () => {
  const manifest = JSON.parse(await read("cowork/manifest.json"));
  const r = await rpc([INIT, { jsonrpc: "2.0", id: 2, method: "tools/list" }]);
  const served = r[2].result.tools.map((t) => t.name).sort();
  const declared = manifest.tools.map((t) => t.name).sort();
  assert.equal(served.length, 31, "31 tools served");
  assert.deepEqual(served, declared, "manifest tool list must match the server's actual tools (drift guard)");
  for (const t of r[2].result.tools) assert.ok(t.description && t.inputSchema, `${t.name} has description + inputSchema`);
});

test("empty ChatGPT profile preserves default initialize, list, and call responses exactly", async () => {
  const requests = [
    INIT,
    { jsonrpc: "2.0", id: 2, method: "tools/list" },
    {
      jsonrpc: "2.0", id: 3, method: "tools/call",
      params: { name: "muster_prioritize", arguments: { items: [{ name: "a", reach: 1, impact: 1, confidence: 1, effort: 1 }] } },
    },
  ];
  const [baseline, empty] = await Promise.all([
    rpc(requests),
    rpc(requests, { env: { MUSTER_MCP_TOOL_PROFILE: "" } }),
  ]);
  assert.deepEqual(empty, baseline);
});

test("ChatGPT Work pro-safe profile exposes exact titled annotated prioritize descriptor and rejects all other calls", async () => {
  const env = { MUSTER_CHATGPT_WORK_PROFILE: "pro-safe" };
  const r = await rpc([
    INIT,
    { jsonrpc: "2.0", id: 2, method: "tools/list" },
    { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "muster_detect", arguments: {} } },
  ], { env, serverPath: path.join(rootDir, "cowork", "chatgpt-work-server.mjs") });
  assert.deepEqual(r[2].result.tools, [{
    name: "muster_prioritize",
    title: "Prioritize backlog items",
    description: r[2].result.tools[0].description,
    inputSchema: r[2].result.tools[0].inputSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  }]);
  assert.equal(r[3].result.isError, true);
  assert.match(r[3].result.content[0].text, /not available/);
});

test("host environment cannot reconfigure the Cowork adapter's authorized tool surface", async () => {
  const [normal, unchanged] = await Promise.all([
    rpc([INIT, { jsonrpc: "2.0", id: 2, method: "tools/list" }]),
    rpc([INIT, { jsonrpc: "2.0", id: 2, method: "tools/list" }], {
      env: {
        MUSTER_MCP_TOOL_PROFILE: "chatgpt-work-full",
        MUSTER_CHATGPT_WORK_PROFILE: "full",
      },
    }),
  ]);
  assert.deepEqual(unchanged, normal);
});

test("ChatGPT Work probe locks descriptor, exact call, one invocation, and server attestation", async t => {
  const nonce = "b".repeat(32);
  const dir = mkdtempSync(path.join(tmpdir(), "muster-work-probe-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const attestationPath = path.join(dir, "server-attestation.json");
  const appPath = path.join(dir, ".app.json");
  const connectionId = "asdk_app_ProbeIdentity1";
  const appBytes = JSON.stringify({ apps: { muster: { id: connectionId } } }, null, 2) + "\n";
  writeFileSync(appPath, appBytes, { mode: 0o600 });
  const request = {
    items: [{
      name: `WORK_WEB_PROBE_${nonce}`,
      reach: 2, impact: 3, confidence: 1, effort: 2,
    }],
    model: "rice",
  };
  const env = {
    MUSTER_CHATGPT_WORK_PROFILE: "pro-safe",
    MUSTER_CHATGPT_WORK_PROBE_NONCE: nonce,
    MUSTER_CHATGPT_WORK_PROBE_ATTESTATION_PATH: attestationPath,
    MUSTER_CHATGPT_WORK_CONNECTION_ID: connectionId,
    MUSTER_CHATGPT_WORK_APP_JSON_PATH: appPath,
    MUSTER_CHATGPT_WORK_PLUGIN_VERSION: "0.5.0",
    MUSTER_CHATGPT_WORK_CONNECTION_LABEL: "Muster Probe",
  };
  const r = await rpc([
    INIT,
    { jsonrpc: "2.0", id: 2, method: "tools/list" },
    { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "muster_detect", arguments: {} } },
    {
      jsonrpc: "2.0", id: 4, method: "tools/call",
      params: { name: "muster_prioritize", arguments: { ...request, model: "ice" } },
    },
    { jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "muster_prioritize", arguments: request } },
    { jsonrpc: "2.0", id: 6, method: "tools/call", params: { name: "muster_prioritize", arguments: request } },
  ], {
    serverPath: path.join(rootDir, "cowork", "chatgpt-work-server.mjs"),
    env,
  });

  const [descriptor] = r[2].result.tools;
  assert.equal(descriptor.name, "muster_prioritize");
  assert.equal(descriptor.title, "Prioritize backlog items");
  assert.deepEqual(descriptor.annotations, {
    readOnlyHint: true, destructiveHint: false, openWorldHint: false,
  });
  assert.equal(descriptor.inputSchema.additionalProperties, false);
  assert.equal(descriptor.inputSchema.properties.model.const, "rice");
  assert.equal(descriptor.inputSchema.properties.items.items.properties.name.const, `WORK_WEB_PROBE_${nonce}`);
  assert.equal(r[3].result.isError, true, "wrong tool rejected");
  assert.equal(r[4].error.code, -32602, "wrong args rejected before dispatch");
  assert.equal(r[5].result.isError, false, "one exact invocation succeeds");
  assert.equal(r[6].result.isError, true, "second exact invocation rejected");

  const attestation = JSON.parse(await readFile(attestationPath, "utf8"));
  assert.deepEqual(attestation, {
    attestationType: "muster-work-native-server-attestation",
    source: "server",
    nonce,
    tool: "muster_prioritize",
    request,
    result: [{ ...request.items[0], score: 3, rank: 1 }],
    identity: {
      connectionIdSha256: createHash("sha256").update(connectionId).digest("hex"),
      pluginAppSha256: createHash("sha256").update(appBytes).digest("hex"),
      pluginName: "muster",
      pluginVersion: "0.5.0",
      connectionLabel: "Muster Probe",
    },
    serverInstanceId: attestation.serverInstanceId,
    invocationCount: 1,
    timestamp: attestation.timestamp,
  });
  assert.equal(new Date(attestation.timestamp).toISOString(), attestation.timestamp);
});

test("ChatGPT Work probe rejects wrong arguments before CLI dispatch and creates no attestation", async t => {
  const nonce = "c".repeat(32);
  const dir = mkdtempSync(path.join(tmpdir(), "muster-work-probe-wrong-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const attestationPath = path.join(dir, "server-attestation.json");
  const appPath = path.join(dir, ".app.json");
  const connectionId = "asdk_app_ProbeWrong1";
  writeFileSync(appPath, JSON.stringify({ apps: { muster: { id: connectionId } } }) + "\n", { mode: 0o600 });
  const r = await rpc([
    INIT,
    {
      jsonrpc: "2.0", id: 2, method: "tools/call",
      params: {
        name: "muster_prioritize",
        arguments: {
          items: [{ name: `WORK_WEB_PROBE_${nonce}`, reach: 2, impact: 3, confidence: 1, effort: 2 }],
          model: "ice",
        },
      },
    },
  ], {
    serverPath: path.join(rootDir, "cowork", "chatgpt-work-server.mjs"),
    env: {
      MUSTER_CHATGPT_WORK_PROFILE: "pro-safe",
      MUSTER_CHATGPT_WORK_PROBE_NONCE: nonce,
      MUSTER_CHATGPT_WORK_PROBE_ATTESTATION_PATH: attestationPath,
      MUSTER_CHATGPT_WORK_CONNECTION_ID: connectionId,
      MUSTER_CHATGPT_WORK_APP_JSON_PATH: appPath,
      MUSTER_CHATGPT_WORK_PLUGIN_VERSION: "0.5.0",
      MUSTER_CHATGPT_WORK_CONNECTION_LABEL: "Muster Probe",
      NODE_ENV: "test",
      MUSTER_COWORK_TEST_CLI: path.join(rootDir, "definitely-missing-cli.mjs"),
    },
  });
  assert.equal(r[2].error.code, -32602);
  assert.match(r[2].error.message, /arguments\.model must equal "rice"/);
  await assert.rejects(readFile(attestationPath, "utf8"), /ENOENT/);
});

test("Cowork distribution metadata and README document the exact MCP-only support contract", async () => {
  const pkg = JSON.parse(await read("package.json"));
  const manifest = JSON.parse(await read("cowork/manifest.json"));
  const text = await read("cowork/README.md");
  const [rootLicense, packedLicense, rootNotice, packedNotice] = await Promise.all([
    read("LICENSE"),
    read("cowork/LICENSE"),
    read("NOTICE"),
    read("cowork/NOTICE"),
  ]);
  const norm = text.replace(/\s+/g, " ");

  assert.equal(pkg.license, "Apache-2.0");
  assert.equal(manifest.license, pkg.license, "MCPB license must match the package license");
  assert.equal(packedLicense, rootLicense, "the packed cowork/ tree must carry the repository license");
  assert.equal(packedNotice, rootNotice, "the packed cowork/ tree must carry repository attributions");
  assert.equal(manifest.tools.length, 31, "MCPB manifest declares the complete deterministic tool surface");
  assert.match(manifest.long_description, /31 deterministic MCP tools/);
  assert.match(manifest.long_description, /Plan, Go, Plan-backlog, Go-backlog, Diagnose, Audit, and Design/);
  assert.equal(manifest.server.entry_point, "mcp-server.mjs", "MCPB entry point is relative to the packed cowork/ root");
  assert.deepEqual(manifest.server.mcp_config.args, ["${__dirname}/mcp-server.mjs"]);
  assert.match(manifest.long_description, /not self-contained/i);
  assert.match(manifest.long_description, /Route A/i);

  assert.match(norm, /ten canonical product modes/i);
  assert.match(norm, /seven-mode MCP protocol subset \(Plan, Go, Plan-backlog, Go-backlog, Diagnose, Audit, and Design\)/);
  assert.doesNotMatch(norm, /full orchestration lifecycle is available/i);
  for (const [mode, status] of [
    ["Plan", "MCP protocol"],
    ["Go", "MCP protocol"],
    ["Plan-backlog", "MCP protocol"],
    ["Go-backlog", "MCP protocol"],
    ["Diagnose", "MCP protocol"],
    ["Audit", "MCP protocol"],
    ["Runner", "Not provided"],
    ["Capture", "Not provided"],
    ["Init", "CLI-only"],
  ]) {
    assert.match(norm, new RegExp(`\\| ${mode} \\| ${status.replace("-", "\\-")}`), `${mode} support status is explicit`);
  }

  assert.match(norm, /`muster_sprint_protocol` is a protocol-content tool, not an MCP wrapper for a same-name CLI command/);
  assert.match(norm, /MCP-only route has no lifecycle-hook enforcement/i);
  assert.match(norm, /native plugin ride remains conditional and unverified/i);
  assert.doesNotMatch(norm, /Dispatch is confirmed working|Dispatch is already confirmed on Cowork/i);
  assert.match(norm, /phase-3 probe[\s\S]{0,180}no live phase-3 receipt/i);
  assert.match(norm, /Phase 3[\s\S]{0,180}Require that receipt before enabling the parallel path/i);
  assert.match(norm, /@anthropic-ai\/mcpb@2\.1\.2/);
  const packageVersion = JSON.parse(await read("package.json")).version;
  assert.match(norm, new RegExp(`@adnova-group/muster@${packageVersion.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
  assert.match(norm, /Route B[\s\S]{0,220}not installable/i);
  assert.match(norm, /archive is not self-contained/i);
  assert.match(norm, /Do not install `muster\.mcpb`/i);
});

// MCPB validators may reject a ${user_config.X} substitution for a key that is
// not declared in user_config -- pin that every substituted key IS declared,
// and the apex/legacy-fable key shapes the server's precedence shim relies on
// (enable_apex: no default, so "unset" stays distinguishable from an explicit
// "false"; enable_fable: declared, marked deprecated/hidden in its prose --
// the manifest schema has no dedicated deprecated/hidden field).
test("manifest: every user_config substitution is declared; apex/legacy keys carry the shapes the shim relies on", async () => {
  const manifest = JSON.parse(await read("cowork/manifest.json"));
  const declared = new Set(Object.keys(manifest.user_config || {}));
  for (const [envName, value] of Object.entries(manifest.server.mcp_config.env || {})) {
    for (const m of String(value).matchAll(/\$\{user_config\.([A-Za-z0-9_]+)\}/g)) {
      assert.ok(declared.has(m[1]), `${envName} substitutes undeclared user_config key "${m[1]}"`);
    }
  }
  assert.ok(!("default" in manifest.user_config.enable_apex),
    "enable_apex must declare no default -- a false-by-default boolean makes 'unset' indistinguishable from an explicit disable");
  const fable = manifest.user_config.enable_fable;
  assert.ok(fable, "the legacy enable_fable key must stay declared for its env substitution");
  assert.equal(fable.type, "boolean");
  assert.match(`${fable.title} ${fable.description}`, /deprecat/i, "enable_fable must be marked deprecated");
});

// ── codex-mcp-surface-gaps: 4 deterministic ops the 2026-07-19 Codex dogfood ──
// fell back to the bundled CLI for, closed as real MCP tools (receipt-verify,
// roles-only capabilities, skill matching, gate-cadence) — see the per-op
// rationale on each TOOLS entry in cowork/mcp-server.mjs.
test("tools/call: muster_capabilities_roles returns ONLY the lighter {roles} capture, no skills/providers", async () => {
  const r = await rpc([INIT, { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "muster_capabilities_roles", arguments: {} } }]);
  const res = r[2].result;
  assert.equal(res.isError, false, "muster_capabilities_roles must not error");
  const body = JSON.parse(res.content[0].text);
  assert.ok(body.roles && typeof body.roles === "object", "roles map present");
  assert.ok(body.roles.debug, "a known role resolves");
  assert.equal(body.skills, undefined, "roles-only capture omits skills");
  assert.equal(body.installedRaw, undefined, "roles-only capture omits installedRaw");
});

test("tools/call: muster_match_skills ranks the live skills inventory and suggests stack-derived skills", async () => {
  const r = await rpc([INIT, { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "muster_match_skills", arguments: { task: "review this pull request for security issues" } } }]);
  const res = r[2].result;
  assert.equal(res.isError, false, "muster_match_skills must not error");
  const body = JSON.parse(res.content[0].text);
  assert.ok(Array.isArray(body.ranked), "ranked skills array present");
  assert.ok(Array.isArray(body.suggested), "suggested skills array present");
});

test("json verb: muster_gate_cadence computes spec/review-gate cadence from a manifest's waves", async () => {
  const manifest = { plan: [{ id: "a", deps: [] }, { id: "b", deps: ["a"] }, { id: "c", deps: ["a"] }] };
  const r = await rpc([INIT, { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "muster_gate_cadence", arguments: { manifest } } }]);
  const res = r[2].result;
  assert.equal(res.isError, false, "muster_gate_cadence must not error");
  const body = JSON.parse(res.content[0].text);
  assert.equal(body.taskCount, 3);
  assert.equal(body.reviewerCount, undefined, "changedLines omitted -> no reviewerCount field");
});

test("json verb: muster_gate_cadence with changedLines also folds in reviewerCount + reviewerReasoning", async () => {
  const manifest = { plan: [{ id: "a", deps: [] }] };
  const r = await rpc([INIT, { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "muster_gate_cadence", arguments: { manifest, changedLines: 50 } } }]);
  const res = r[2].result;
  assert.equal(res.isError, false);
  const body = JSON.parse(res.content[0].text);
  assert.equal(body.reviewerCount, 1, "50 changed lines is under the default 200-line threshold");
  assert.equal(body.reviewerReasoning, "medium");
});

test("tools/call: muster_receipt_verify -- a REAL SHA from this checkout verifies true", async () => {
  const { stdout } = await execFileP("git", ["rev-parse", "HEAD"], { cwd: rootDir });
  const sha = stdout.trim();
  const r = await rpc([INIT, { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "muster_receipt_verify", arguments: { sha, cwd: rootDir } } }]);
  const res = r[2].result;
  assert.equal(res.isError, false, "a real SHA must not error");
  const body = JSON.parse(res.content[0].text);
  assert.equal(body.verified, true);
  assert.equal(body.mechanism, "git-object");
  assert.equal(body.sha, sha);
});

test("tools/call: muster_receipt_verify -- a fabricated well-formed SHA verifies false and surfaces isError", async () => {
  const fabricated = "f".repeat(40);
  const r = await rpc([INIT, { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "muster_receipt_verify", arguments: { sha: fabricated, cwd: rootDir } } }]);
  const res = r[2].result;
  assert.equal(res.isError, true, "an unverified SHA's non-zero CLI exit surfaces as isError, matching muster_sprint_waves' ok:false convention");
  const body = JSON.parse(res.content[0].text);
  assert.equal(body.verified, false);
});

// Review-gate fix: omitting the required `sha` while `cwd` is present must NOT let the
// "str" kind's trailing `flags` (--cwd <repo>) shift into the sha's positional slot --
// that produced a misleading `{"sha":"--cwd","cwd":...,"verified":false}` diagnostic that
// falsely implied a real git-object verification attempt occurred, instead of the CLI's
// own clean "missing sha" usage error.
test("tools/call: muster_receipt_verify -- omitting required sha is rejected before CLI dispatch", async () => {
  const r = await rpc([INIT, { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "muster_receipt_verify", arguments: { cwd: rootDir } } }]);
  assert.equal(r[2].error.code, -32602);
  assert.match(r[2].error.message, /arguments\.sha is required/);
});

// ── codex-mcp-surface-gaps round 2: 3 more deterministic ops the 2026-07-19 clean ──
// Codex run's residual CLI-only list named (scope, fast-path, plan-checklist) — see
// the per-op rationale on each TOOLS entry in cowork/mcp-server.mjs. codex-conformance,
// the 4th residual op, was judged CLI-only and is documented in COWORK_PROTOCOL instead.
test("tools/call: muster_scope classifies a single-item outcome (item) and a bare invocation (ambiguous, no live backlog)", async () => {
  const item = await rpc([INIT, { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "muster_scope", arguments: { text: "fix a typo in the README" } } }]);
  assert.equal(item[2].result.isError, false, "muster_scope must not error");
  const itemBody = JSON.parse(item[2].result.content[0].text);
  assert.equal(itemBody.scope, "item");

  // Hermetic cwd: the repo checkout may legitimately carry a live (untracked)
  // .muster/backlog.md, which makes a bare invocation resolve scope "backlog"
  // instead of "ambiguous" -- spawn from an empty tmp dir so the no-backlog
  // branch is what's actually under test (caught 2026-07-19: passed in a fresh
  // worktree, failed in a working checkout).
  const bareCwd = mkdtempSync(path.join(tmpdir(), "muster-scope-bare-"));
  try {
    const bare = await rpc([INIT, { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "muster_scope", arguments: {} } }], { cwd: bareCwd });
    assert.equal(bare[2].result.isError, false, "an omitted text arg is a valid bare invocation, not an error");
    const bareBody = JSON.parse(bare[2].result.content[0].text);
    assert.equal(bareBody.scope, "ambiguous", "no .muster/backlog.md at the cwd -- bare invocation is genuinely ambiguous");
  } finally {
    rmSync(bareCwd, { recursive: true, force: true });
  }
});

test("tools/call: muster_fast_path scores eligibility with no capabilities arg (bare form)", async () => {
  const r = await rpc([INIT, { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "muster_fast_path", arguments: { outcome: "fix a typo in the README" } } }]);
  const res = r[2].result;
  assert.equal(res.isError, false, "muster_fast_path must not error");
  const body = JSON.parse(res.content[0].text);
  assert.equal(body.eligible, true);
  assert.equal(body.manifest, undefined, "no capabilities arg -> score only, no manifest");
});

test("tools/call: muster_fast_path with capabilities (the muster_capabilities_roles {roles} shape) also emits the minimal builder+reviewer manifest", async () => {
  const capsRun = await rpc([INIT, { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "muster_capabilities_roles", arguments: {} } }]);
  const capabilities = JSON.parse(capsRun[2].result.content[0].text);

  const r = await rpc([INIT, { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "muster_fast_path", arguments: { outcome: "fix a typo in the README", capabilities } } }]);
  const res = r[2].result;
  assert.equal(res.isError, false, "muster_fast_path must not error");
  const body = JSON.parse(res.content[0].text);
  assert.equal(body.eligible, true);
  assert.ok(body.manifest, "eligible outcome + capabilities -> manifest present");
  assert.equal(body.manifest.crew.length, 2, "builder + one reviewer only");
  assert.equal(body.manifest.plan[0].task, "fix a typo in the README");
});

test("tools/call: muster_fast_path -- missing outcome errors instead of silently scoring an empty string", async () => {
  const r = await rpc([INIT, { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "muster_fast_path", arguments: {} } }]);
  assert.equal(r[2].error.code, -32602);
  assert.match(r[2].error.message, /arguments\.outcome is required/);
});

test("tools/call: muster_plan_checklist renders a manifest's plan as a markdown checklist", async () => {
  const manifest = { plan: [{ id: "a", task: "Add X", deps: [] }, { id: "b", task: "Add Y", deps: ["a"] }] };
  const r = await rpc([INIT, { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "muster_plan_checklist", arguments: { manifest } } }]);
  const res = r[2].result;
  assert.equal(res.isError, false, "muster_plan_checklist must not error");
  assert.equal(res.content[0].text, "- [ ] a — Add X\n- [ ] b — Add Y");
});

test("tools/call: muster_plan_checklist marks the given ids done", async () => {
  const manifest = { plan: [{ id: "a", task: "Add X", deps: [] }, { id: "b", task: "Add Y", deps: ["a"] }] };
  const r = await rpc([INIT, { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "muster_plan_checklist", arguments: { manifest, done: ["a"] } } }]);
  const res = r[2].result;
  assert.equal(res.isError, false);
  assert.equal(res.content[0].text, "- [x] a — Add X\n- [ ] b — Add Y");
});

// ── audit-mcp-backlog-mode: muster_audit gains `backlog` + `paths`, exposing the
// $muster-audit skill's read-only backlog sweep (plugin/commands/audit.md) at the MCP
// surface. Previously the tool always returned a whole-codebase remediation manifest
// (fix + verify) regardless of a scoped read-only request, so Codex backlog mode had to
// drive the sweep via skill prose. Same tool (count unchanged at CODEX_COUNTS.mcpTools);
// two new OPTIONAL params on the existing `target` kind.
test("tools/call: muster_audit default -> whole-codebase remediation manifest (fix + verify)", async () => {
  const r = await rpc([INIT, { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "muster_audit", arguments: { dir: rootDir } } }]);
  const res = r[2].result;
  assert.equal(res.isError, false, "muster_audit must not error");
  const ids = JSON.parse(res.content[0].text).plan.map((p) => p.id);
  assert.ok(ids.includes("fix"), "default manifest keeps the fix stage");
  assert.ok(ids.includes("verify"), "default manifest keeps the verify stage");
  assert.ok(!ids.includes("capture"), "default manifest has no capture stage");
});

test("tools/call: muster_audit backlog:true -> read-only manifest, no fix/verify, a capture stage", async () => {
  const r = await rpc([INIT, { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "muster_audit", arguments: { dir: rootDir, backlog: true } } }]);
  const res = r[2].result;
  assert.equal(res.isError, false, "muster_audit backlog must not error");
  const ids = JSON.parse(res.content[0].text).plan.map((p) => p.id);
  assert.ok(!ids.includes("fix"), "backlog manifest drops the fix stage");
  assert.ok(!ids.includes("verify"), "backlog manifest drops the verify stage");
  assert.ok(ids.includes("capture"), "backlog manifest carries the read-only capture stage");
});

test("tools/call: muster_audit paths -> manifest scoped to the requested paths", async () => {
  const r = await rpc([INIT, { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "muster_audit", arguments: { dir: rootDir, paths: ["src/audit.js"] } } }]);
  const res = r[2].result;
  assert.equal(res.isError, false, "muster_audit paths must not error");
  const m = JSON.parse(res.content[0].text);
  assert.match(m.outcome, /src\/audit\.js/, "scope names the requested path in the outcome");
  assert.match(m.plan.find((p) => p.id === "audit-security").task, /src\/audit\.js/, "scope reaches the audit tasks");
});

test("tools/call: muster_design exposes pinned workflows and canonical context receipts", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "muster-design-mcp-"));
  writeFileSync(path.join(dir, "DESIGN.md"), "# Design\n\n## Direction\nClear.\n");
  const r = await rpc([
    INIT,
    { jsonrpc: "2.0", id: 2, method: "tools/call", params: {
      name: "muster_design",
      arguments: { action: "workflows", dir },
    } },
    { jsonrpc: "2.0", id: 3, method: "tools/call", params: {
      name: "muster_design",
      arguments: { action: "run", workflow: "polish", dir, target: "src/App.tsx" },
    } },
  ]);
  const workflows = JSON.parse(r[2].result.content[0].text);
  const packet = JSON.parse(r[3].result.content[0].text);
  assert.equal(workflows.workflows.length, 23);
  assert.equal(packet.workflow, "polish");
  assert.match(packet.context.digest, /^[a-f0-9]{64}$/);
});

// A `paths` entry is spread as a positional CLI arg, and the CLI's flag scans (--help/-h,
// --codex, --backlog) read the WHOLE argv -- so a "-"-leading path would masquerade as a
// flag: paths:["-h"] would print the global USAGE string (not JSON, breaking every
// JSON.parse caller), and paths:["--backlog"] would silently flip the mode with `backlog`
// omitted. Path scopes are filesystem paths/subsystems and never start with "-"; reject
// such an entry at the trust boundary instead of letting it reach argv.
test("tools/call: muster_audit rejects a `-h` path scope (no USAGE leak) instead of shifting it into a flag slot", async () => {
  const r = await rpc([INIT, { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "muster_audit", arguments: { dir: rootDir, paths: ["-h"] } } }]);
  const res = r[2].result;
  assert.equal(res.isError, true, "a -h path scope must error, not print USAGE");
  assert.match(res.content[0].text, /path scope/i, "message names the offending path scope");
  assert.doesNotMatch(res.content[0].text, /Usage: muster/, "must never leak the global USAGE string");
});

test("tools/call: muster_audit rejects a `--backlog` path scope instead of silently flipping the mode", async () => {
  const r = await rpc([INIT, { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "muster_audit", arguments: { dir: rootDir, paths: ["--backlog"] } } }]);
  const res = r[2].result;
  assert.equal(res.isError, true, "a --backlog path scope must error, never masquerade as the backlog flag");
  assert.match(res.content[0].text, /path scope/i);
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

test("F3: missing cowork/sprint-protocol.md at module load does not crash the server; muster_sprint_protocol surfaces isError naming the file", async (t) => {
  // Isolated temp copy, never the real repo tree: an earlier version of this test renamed the
  // real cowork/sprint-protocol.md in place for the call's duration. Under concurrent test
  // execution that raced with anything scanning the whole working tree at the same moment
  // (e.g. codex.test.js's `npm pack --dry-run`, which walks the live filesystem) -- an ENOENT
  // on the transient backup name once npm's own directory walk observed it mid-rename. Building
  // a throwaway copy of just the files mcp-server.mjs needs (itself, guidance.js, a stub
  // package.json) and omitting sprint-protocol.md from it reproduces the exact missing-file
  // scenario without ever mutating the shared repo tree, so no other concurrently-running test
  // can observe the absence.
  const tmp = mkdtempSync(path.join(tmpdir(), "muster-cowork-f3-"));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  mkdirSync(path.join(tmp, "cowork"), { recursive: true });
  mkdirSync(path.join(tmp, "mcp"), { recursive: true });
  mkdirSync(path.join(tmp, "src"), { recursive: true });
  mkdirSync(path.join(tmp, "plugin", "hooks"), { recursive: true });
  copyFileSync(path.join(rootDir, "cowork", "mcp-server.mjs"), path.join(tmp, "cowork", "mcp-server.mjs"));
  copyFileSync(path.join(rootDir, "mcp", "server.mjs"), path.join(tmp, "mcp", "server.mjs"));
  copyFileSync(path.join(rootDir, "src", "backlog-publication.js"), path.join(tmp, "src", "backlog-publication.js"));
  copyFileSync(path.join(rootDir, "plugin", "hooks", "guidance.js"), path.join(tmp, "plugin", "hooks", "guidance.js"));
  writeFileSync(path.join(tmp, "package.json"), JSON.stringify({ version: "0.0.0-test", type: "module" }));
  // Deliberately no cowork/sprint-protocol.md written into the temp copy -- this omission IS
  // the missing-file case under test.

  // Server must still start and answer other requests (ping) with the file gone.
  const r = await rpc([
    INIT,
    { jsonrpc: "2.0", id: 2, method: "ping" },
    { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "muster_sprint_protocol", arguments: {} } },
  ], { serverPath: path.join(tmp, "cowork", "mcp-server.mjs"), cwd: tmp });
  assert.deepEqual(r[2].result, {}, "server stays alive and answers unrelated requests");
  const res = r[3].result;
  assert.equal(res.isError, true, "missing sprint-protocol.md must surface as isError, not crash the server");
  assert.match(res.content[0].text, /sprint-protocol\.md/, "error text names the missing file");
});

test("string verb: muster_route returns valid JSON with a domain", async () => {
  const r = await rpc([INIT, { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "muster_route", arguments: { outcome: "fix a failing test" } } }]);
  const res = r[2].result;
  assert.equal(res.isError, false);
  assert.ok("domain" in JSON.parse(res.content[0].text), "route output parses to an object with a domain");
});

// ── native-plugin-ride capability check ─────────────────────────────────────
// Whether Cowork's own plugin loader (docs/research/claude-cowork.md section 3d)
// actually accepts muster's plugin/ tree is unverified without a live Cowork
// session; there is no on-disk/protocol signal this server can inspect to
// auto-detect it, so it is a DECLARED capability check
// (MUSTER_COWORK_NATIVE_PLUGIN, passed through this server's env-forwarding
// runCli spawn -- same declare-not-discover shape as MUSTER_COWORK_CONNECTORS).
// End-to-end through the actual MCP tool call, not just the direct CLI.
test("tools/call: muster_capabilities respects MUSTER_COWORK_NATIVE_PLUGIN end to end (declared capability check, not a probe)", async () => {
  const bareRun = await rpc([INIT, { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "muster_capabilities", arguments: {} } }]);
  const bare = JSON.parse(bareRun[2].result.content[0].text);
  assert.equal(bare.roles.debug.chosen.id, "inline", "default (undeclared) Cowork resolution over MCP stays MCP-only");

  const nativeRun = await rpc(
    [INIT, { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "muster_capabilities", arguments: {} } }],
    { env: { MUSTER_COWORK_NATIVE_PLUGIN: "1" } },
  );
  const native = JSON.parse(nativeRun[2].result.content[0].text);
  assert.equal(native.roles.debug.chosen.id, "wsh-debugger", "declared native plugin ride resolves the builtin agent through the MCP server, same as the direct CLI");
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

test("file verb: muster_sprint_waves exposes build concurrency and post-barrier integration order", async () => {
  const backlog = [
    "- [ ] Merge locally {id: local} {deps: none} {disposition: merge-local}",
    "- [ ] Open PR {id: pr} {deps: none} {disposition: pr}",
    "- [ ] Merge and push {id: push} {deps: none} {disposition: merge-push}",
  ].join("\n");
  const r = await rpc(
    [INIT, { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "muster_sprint_waves", arguments: { backlog } } }],
    { env: { MUSTER_SPRINT_PARALLEL: "2" } },
  );
  const res = JSON.parse(r[2].result.content[0].text);
  assert.equal(r[2].result.isError, false);
  assert.deepEqual(res.schedule.waves[0].buildReview.batches, [["local", "pr"], ["push"]]);
  assert.deepEqual(res.schedule.waves[0].integration.itemIds, ["local", "pr", "push"]);
  assert.equal(res.schedule.degradation.buildReviewMode, "sequential-isolated");
});

test("json verb: muster_sprint_reconcile drains a completion wake and exposes review without a user turn", async () => {
  const backlog = "- [ ] Open PR {id: a} {deps: none} {disposition: pr}";
  const planned = await rpc([
    INIT,
    { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "muster_sprint_waves", arguments: { backlog } } },
  ]);
  const plan = JSON.parse(planned[2].result.content[0].text);
  const reconciled = await rpc([
    INIT,
    {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: {
        name: "muster_sprint_reconcile",
        arguments: {
          plan,
          inFlight: [{ itemId: "a", phase: "implementation", attempt: 1 }],
          receipts: [{ id: "impl-a", itemId: "a", phase: "implementation", status: "completed" }],
        },
      },
    },
  ]);
  const res = JSON.parse(reconciled[2].result.content[0].text);

  assert.equal(reconciled[2].result.isError, false);
  assert.equal(res.next, "dispatch");
  assert.deepEqual(res.actions, [{ type: "dispatch", itemId: "a", phase: "review", wave: 1 }]);
  assert.equal(res.wait.eligible, false);
});

test("json verb: muster_sprint_reconcile returns isError with structured validation errors for a forged plan", async () => {
  const backlog = "- [ ] Open PR {id: a} {deps: none} {disposition: pr}";
  const planned = await rpc([
    INIT,
    { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "muster_sprint_waves", arguments: { backlog } } },
  ]);
  const plan = JSON.parse(planned[2].result.content[0].text);
  plan.schedule.buildReview.maxConcurrency = 999;
  const reconciled = await rpc([
    INIT,
    {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: {
        name: "muster_sprint_reconcile",
        arguments: { plan, receipts: [], inFlight: [] },
      },
    },
  ]);
  const res = JSON.parse(reconciled[2].result.content[0].text);

  assert.equal(reconciled[2].result.isError, true);
  assert.equal(res.ok, false);
  assert.match(res.errors.join(" | "), /maxConcurrency/);
  assert.notEqual(res.wait?.eligible, true);
});

test("MCP backlog publisher performs a bounded CAS write inside an explicit project root", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "muster-mcp-backlog-publish-"));
  const backlog = path.join(dir, "backlog.md");
  writeFileSync(backlog, "original\n");
  const expectedSha256 = createHash("sha256").update("original\n").digest("hex");
  const r = await rpc([
    INIT,
    {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: {
        name: "muster_backlog_publish",
        arguments: { dir, path: "backlog.md", expectedSha256, content: "updated\n" },
      },
    },
  ]);
  const res = JSON.parse(r[2].result.content[0].text);
  assert.equal(r[2].result.isError, false);
  assert.equal(res.ok, true);
  assert.equal(readFileSync(backlog, "utf8"), "updated\n");
});

test("MCP and CLI backlog publishers share the 16 MiB envelope and contain oversized calls", async () => {
  const cliDir = mkdtempSync(path.join(tmpdir(), "muster-cli-backlog-envelope-"));
  const mcpDir = mkdtempSync(path.join(tmpdir(), "muster-mcp-backlog-envelope-"));
  const content = `${"x".repeat(1_048_576)}\nabove-one-mib\n`;
  const expectedDigest = createHash("sha256").update(content).digest("hex");
  const cliResult = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(rootDir, "src", "cli.js"), "backlog-publish", "backlog.md", "--expect", "absent"], {
      cwd: cliDir, stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => code === 0 ? resolve(JSON.parse(stdout)) : reject(new Error(stderr)));
    child.stdin.end(content);
  });

  const r = await rpc([
    INIT,
    {
      jsonrpc: "2.0", id: 2, method: "tools/call", params: {
        name: "muster_backlog_publish",
        arguments: { dir: mcpDir, path: "backlog.md", expectedSha256: "absent", content },
      },
    },
    {
      jsonrpc: "2.0", id: 3, method: "tools/call", params: {
        name: "muster_backlog_publish",
        arguments: {
          dir: mcpDir,
          path: "oversized.md",
          expectedSha256: "absent",
          content: "x".repeat(16 * 1_048_576 + 1),
        },
      },
    },
    { jsonrpc: "2.0", id: 4, method: "ping" },
  ], { timeout: 60_000 });
  const mcpResult = JSON.parse(r[2].result.content[0].text);

  assert.equal(cliResult.sha256, expectedDigest);
  assert.equal(mcpResult.sha256, expectedDigest);
  assert.equal(readFileSync(path.join(cliDir, "backlog.md"), "utf8"), content);
  assert.equal(readFileSync(path.join(mcpDir, "backlog.md"), "utf8"), content);
  assert.equal(r[3].result.isError, true);
  assert.match(r[3].result.content[0].text, /content exceeds 16777216 byte limit/);
  assert.deepEqual(r[4].result, {}, "server remains responsive after the oversized tool call");
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

test("error path: missing required arguments are rejected before CLI dispatch", async () => {
  const r = await rpc([INIT, { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "muster_route", arguments: {} } }]);
  assert.equal(r[2].error.code, -32602);
  assert.match(r[2].error.message, /arguments\.outcome is required/);
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

// Legacy apex opt-in shim (the startup env-merge in cowork/mcp-server.mjs):
// enable_apex SET TO EITHER VALUE always wins; a stale legacy enable_fable=true
// applies only when enable_apex is unset ("" is what MCPB substitutes for an
// unset no-default key). Observed through muster_advise's advisorModel
// ("advisor" is an apex role: modelForRole returns "apex" only when enabled,
// else its prime fallback).
test("apex opt-in precedence: enable_apex set to either value always wins; legacy enable_fable applies only when enable_apex is unset", async () => {
  const request = { question: "q?", context: "c", decisionType: "architecture" };
  const advisorModel = async (env) => {
    const r = await rpc([INIT, { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "muster_advise", arguments: { request } } }], { env });
    const res = r[2].result;
    assert.equal(res.isError, false);
    return JSON.parse(res.content[0].text).advisorModel;
  };
  assert.equal(
    await advisorModel({ MUSTER_ENABLE_APEX: "", MUSTER_ENABLE_FABLE: "true" }), "apex",
    "enable_apex unset + legacy enable_fable=true -> the legacy opt-in still applies",
  );
  assert.equal(
    await advisorModel({ MUSTER_ENABLE_APEX: "true", MUSTER_ENABLE_FABLE: "false" }), "apex",
    "explicit enable_apex=true wins",
  );
  assert.notEqual(
    await advisorModel({ MUSTER_ENABLE_APEX: "false", MUSTER_ENABLE_FABLE: "true" }), "apex",
    "explicit enable_apex=false beats a stale legacy enable_fable=true",
  );
  assert.notEqual(
    await advisorModel({ MUSTER_ENABLE_APEX: "", MUSTER_ENABLE_FABLE: "" }), "apex",
    "both unset -> apex off",
  );
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

test("tools/call: muster_audit requires and analyzes its explicit target directory", async () => {
  const plain = mkdtempSync(path.join(tmpdir(), "cowork-audit-plain-"));
  const prompting = mkdtempSync(path.join(tmpdir(), "cowork-audit-prompting-"));
  writeFileSync(path.join(plain, "package.json"), JSON.stringify({ dependencies: {} }));
  writeFileSync(path.join(prompting, "package.json"), JSON.stringify({ dependencies: { openai: "latest" } }));
  try {
    const r = await rpc([
      INIT,
      { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "muster_audit", arguments: {} } },
      { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "muster_audit", arguments: { dir: plain } } },
      { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "muster_audit", arguments: { dir: prompting } } },
    ]);
    assert.equal(r[2].error.code, -32602, "omitting the target must not silently audit the server cwd");
    assert.match(r[2].error.message, /arguments\.dir is required/);
    const plainManifest = JSON.parse(r[3].result.content[0].text);
    const promptingManifest = JSON.parse(r[4].result.content[0].text);
    assert.equal(plainManifest.plan.some(({ id }) => id === "audit-prompt-quality"), false);
    assert.equal(promptingManifest.plan.some(({ id }) => id === "audit-prompt-quality"), true);
    assert.ok(
      promptingManifest.crew.every(({ provider }) => provider === "inline" || provider === "serena"),
      "Cowork audit must inherit the runtime-aware provider contract",
    );
  } finally {
    rmSync(plain, { recursive: true, force: true });
    rmSync(prompting, { recursive: true, force: true });
  }
});

test("tools/call bounds in-flight work, rejects overload, and cancels children plus temp dirs", async () => {
  const fixture = mkdtempSync(path.join(tmpdir(), "cowork-concurrency-"));
  const childTmp = path.join(fixture, "tmp");
  const fakeCli = path.join(fixture, "slow-cli.mjs");
  writeFileSync(fakeCli, [
    'import { writeFileSync } from "node:fs";',
    'import path from "node:path";',
    'writeFileSync(path.join(process.env.MUSTER_TEST_MARKERS, `started-${process.pid}`), process.argv.slice(2).join("\\n"));',
    'setInterval(() => {}, 1000);',
  ].join("\n"));
  writeFileSync(path.join(fixture, "package.json"), JSON.stringify({ dependencies: {} }));
  await import("node:fs/promises").then(({ mkdir }) => mkdir(childTmp));

  const responses = await new Promise((resolve, reject) => {
    const srv = spawn(process.execPath, [path.join(rootDir, "cowork", "mcp-server.mjs")], {
      cwd: rootDir,
      env: {
        ...process.env,
        NODE_ENV: "test",
        TMPDIR: childTmp,
        MUSTER_COWORK_TEST_CLI: fakeCli,
        MUSTER_COWORK_MAX_INFLIGHT: "1",
        MUSTER_COWORK_MAX_QUEUE: "1",
        MUSTER_TEST_MARKERS: fixture,
      },
      stdio: ["pipe", "pipe", "inherit"],
    });
    const got = {};
    let cancellationScheduled = false;
    let buf = "";
    const timer = setTimeout(() => {
      srv.kill("SIGKILL");
      reject(new Error(`bounded concurrency test timeout; replies=${JSON.stringify(got)}`));
    }, 5_000);
    srv.stdout.setEncoding("utf8");
    srv.stdout.on("data", (data) => {
      buf += data;
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        const msg = JSON.parse(line);
        if (msg.id != null) got[msg.id] = msg;
        if (msg.id === 4 && !cancellationScheduled) {
          cancellationScheduled = true;
          const cancelAfterChildStarts = () => {
            if (!readdirSync(fixture).some((name) => name.startsWith("started-"))) {
              setTimeout(cancelAfterChildStarts, 10);
              return;
            }
            srv.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 2 } }) + "\n");
            srv.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 3 } }) + "\n");
          };
          cancelAfterChildStarts();
        }
        if (got[2] && got[3] && got[4]) {
          clearTimeout(timer);
          srv.stdin.end();
          resolve(got);
        }
      }
    });
    srv.on("error", reject);
    srv.stdin.write(JSON.stringify(INIT) + "\n");
    for (const id of [2, 3, 4]) {
      srv.stdin.write(JSON.stringify({
        jsonrpc: "2.0", id, method: "tools/call",
        params: { name: "muster_wave", arguments: { manifest: { plan: [{ id: `task-${id}`, deps: [] }] } } },
      }) + "\n");
    }
  });

  try {
    assert.equal(responses[4].result.isError, true);
    assert.match(responses[4].result.content[0].text, /overloaded.*queue/i);
    for (const id of [2, 3]) {
      assert.equal(responses[id].result.isError, true);
      assert.match(responses[id].result.content[0].text, /cancelled/i);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
    const { readdir } = await import("node:fs/promises");
    assert.deepEqual(await readdir(childTmp), [], "cancelled work must remove every request temp directory");
    const markerNames = (await readdir(fixture)).filter((name) => name.startsWith("started-"));
    assert.equal(markerNames.length, 1, "only the single active slot may spawn a child");
    const pid = Number(markerNames[0].slice("started-".length));
    assert.throws(() => process.kill(pid, 0), /ESRCH/, "the active child must be terminated on cancellation");
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
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

test("request ids reject null, preserve absent-id notifications, and accept strings and numbers", async () => {
  const messages = await new Promise((resolve, reject) => {
    const srv = spawn(process.execPath, [path.join(rootDir, "cowork", "mcp-server.mjs")], {
      cwd: rootDir,
      stdio: ["pipe", "pipe", "inherit"],
    });
    const got = [];
    let buf = "";
    let settled = false;
    const timer = setTimeout(() => {
      settled = true;
      srv.kill("SIGKILL");
      reject(new Error(`method notification timeout; replies=${JSON.stringify(got)}`));
    }, 3_000);
    srv.stdout.setEncoding("utf8");
    srv.stdout.on("data", (data) => {
      buf += data;
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        const msg = JSON.parse(line);
        got.push(msg);
        if (!settled && msg.id === 2) {
          settled = true;
          setTimeout(() => {
            clearTimeout(timer);
            srv.stdin.end();
            resolve(got);
          }, 50);
        }
      }
    });
    srv.on("error", reject);
    for (const message of [
      INIT,
      { jsonrpc: "2.0", method: "initialize", params: {} },
      { jsonrpc: "2.0", method: "ping" },
      { jsonrpc: "2.0", method: "tools/list" },
      { jsonrpc: "2.0", method: "notifications/unknown" },
      { jsonrpc: "2.0", id: null, method: "ping" },
      { jsonrpc: "2.0", id: "request-2", method: "ping" },
      { jsonrpc: "2.0", id: 2, method: "ping" },
    ]) {
      srv.stdin.write(JSON.stringify(message) + "\n");
    }
  });

  assert.deepEqual(
    messages.map((msg) => msg.id),
    [1, null, "request-2", 2],
    "absent-id notifications stay silent while null, string, and number request ids receive responses",
  );
  assert.deepEqual(
    messages[1],
    { jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid Request" } },
    "an explicit null id is an invalid JSON-RPC request",
  );
  assert.deepEqual(messages[2].result, {}, "string request ids remain valid");
  assert.deepEqual(messages[3].result, {}, "number request ids remain valid");
});

test("tools/call notifications execute without replies, undefined-id collisions, or cancellation", async () => {
  const fixture = mkdtempSync(path.join(tmpdir(), "cowork-tool-notifications-"));
  const fakeCli = path.join(fixture, "recording-cli.mjs");
  const marker = path.join(fixture, "calls.log");
  writeFileSync(fakeCli, [
    'import { appendFileSync } from "node:fs";',
    'appendFileSync(process.env.MUSTER_TEST_MARKER, "started\\n");',
    'await new Promise((resolve) => setTimeout(resolve, 100));',
    'appendFileSync(process.env.MUSTER_TEST_MARKER, "completed\\n");',
    'process.stdout.write("ok");',
  ].join("\n"));

  try {
    const messages = await new Promise((resolve, reject) => {
      const srv = spawn(process.execPath, [path.join(rootDir, "cowork", "mcp-server.mjs")], {
        cwd: rootDir,
        env: {
          ...process.env,
          NODE_ENV: "test",
          MUSTER_COWORK_TEST_CLI: fakeCli,
          MUSTER_TEST_MARKER: marker,
        },
        stdio: ["pipe", "pipe", "inherit"],
      });
      const got = [];
      let buf = "";
      let settled = false;
      let completionScheduled = false;
      const timer = setTimeout(() => {
        settled = true;
        srv.kill("SIGKILL");
        reject(new Error(`tools/call notification timeout; replies=${JSON.stringify(got)}`));
      }, 3_000);
      const finishWhenComplete = () => {
        if (settled) return;
        let completed = 0;
        try {
          completed = readFileSync(marker, "utf8").split("\n").filter((line) => line === "completed").length;
        } catch {}
        if (completed < 2 || !got.some((msg) => msg.id === 2)) {
          setTimeout(finishWhenComplete, 10);
          return;
        }
        if (!completionScheduled) {
          completionScheduled = true;
          setTimeout(() => {
            settled = true;
            clearTimeout(timer);
            srv.stdin.end();
            resolve(got);
          }, 50);
        }
      };
      srv.stdout.setEncoding("utf8");
      srv.stdout.on("data", (data) => {
        buf += data;
        let nl;
        while ((nl = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (line) got.push(JSON.parse(line));
        }
      });
      srv.on("error", reject);
      srv.stdin.write(JSON.stringify(INIT) + "\n");
      srv.stdin.write(JSON.stringify({
        jsonrpc: "2.0", method: "tools/call",
        params: { name: "muster_detect", arguments: {} },
      }) + "\n");
      srv.stdin.write(JSON.stringify({
        jsonrpc: "2.0", method: "notifications/cancelled", params: {},
      }) + "\n");
      srv.stdin.write(JSON.stringify({
        jsonrpc: "2.0", method: "tools/call",
        params: { name: "muster_detect", arguments: {} },
      }) + "\n");
      srv.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "ping" }) + "\n");
      finishWhenComplete();
    });

    assert.deepEqual(messages.map((msg) => msg.id).sort(), [1, 2], "tools/call notifications must emit no response");
    assert.deepEqual(messages.find((msg) => msg.id === 2)?.result, {}, "a subsequent ping request stays healthy");
    assert.equal(
      readFileSync(marker, "utf8").split("\n").filter((line) => line === "completed").length,
      2,
      "both notifications execute without colliding or being cancelled via an undefined id",
    );
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

// ── A-SEC6: stdin buffer overflow guard ─────────────────────────────────────
// An unterminated request must remain bounded without taking down the process;
// once its delimiter arrives, the server rejects that request and resumes.
test("A-SEC6: an oversized unterminated request is discarded without killing the server", async () => {
  const REQUEST_LIMIT = 17 * 1_048_576;
  const pingId = 42;
  const responses = await new Promise((resolve, reject) => {
    const srv = spawn("node", [path.join(rootDir, "cowork", "mcp-server.mjs")], {
      cwd: rootDir,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const got = {};
    let buf = "";
    const timer = setTimeout(() => { srv.kill("SIGKILL"); reject(new Error("A-SEC6 test timeout")); }, 15_000);
    srv.stdout.setEncoding("utf8");
    srv.stdout.on("data", (chunk) => {
      buf += chunk;
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        const message = JSON.parse(line);
        got[message.id] = message;
        if (got[41] && got[pingId]) {
          clearTimeout(timer);
          srv.stdin.end();
          resolve(got);
        }
      }
    });
    srv.on("error", (e) => { clearTimeout(timer); reject(e); });
    const prefix = '{"jsonrpc":"2.0","id":41,"method":"ping","padding":"';
    srv.stdin.write(prefix + "x".repeat(REQUEST_LIMIT + 1));
    srv.stdin.write('"}\n');
    srv.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: pingId, method: "ping" }) + "\n");
  });

  assert.equal(responses[41].error.code, -32600);
  assert.match(responses[41].error.message, /Request exceeds 17825792 byte limit/);
  assert.deepEqual(responses[pingId].result, {});
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
