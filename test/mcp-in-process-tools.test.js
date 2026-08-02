import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import { computeSprintWaves } from "../src/sprint-waves.js";
import { invokeInProcessTool } from "../mcp/in-process-tools.mjs";

const execFileP = promisify(execFile);
const rootDir = fileURLToPath(new URL("../", import.meta.url));
const serverPath = join(rootDir, "cowork", "mcp-server.mjs");
const cliPath = join(rootDir, "src", "cli.js");
const INIT = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0" } } };

function rpc(requests, { env = {} } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [serverPath], {
      cwd: rootDir,
      env: { ...process.env, ...env },
      stdio: ["pipe", "pipe", "inherit"],
    });
    const pending = new Set(requests.filter((request) => request.id != null).map((request) => request.id));
    const responses = new Map();
    let buffer = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("MCP response timeout"));
    }, 15_000);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      buffer += chunk;
      let newline;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (!line) continue;
        const message = JSON.parse(line);
        if (message.id != null) {
          responses.set(message.id, message);
          pending.delete(message.id);
        }
        if (pending.size === 0) {
          clearTimeout(timer);
          child.stdin.end();
          resolve(responses);
        }
      }
    });
    child.on("error", reject);
    for (const request of requests) child.stdin.write(`${JSON.stringify(request)}\n`);
  });
}

const call = (id, name, args) => ({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } });

test("twelve deterministic read-only MCP calls stay byte-equivalent without invoking the CLI", async (t) => {
  const fixture = await mkdtemp(join(tmpdir(), "muster-mcp-pure-"));
  t.after(() => rm(fixture, { recursive: true, force: true }));
  const plan = {
    plan: [
      { id: "a", task: "Build", mode: "single", deps: [] },
      { id: "b", task: "Review", mode: "single", deps: ["a"] },
    ],
  };
  const sprintPlan = computeSprintWaves("- [ ] Build {id: a} {deps: none} {disposition: pr}");
  const inputs = {
    manifest: plan,
    progress: { plan: sprintPlan, receipts: [], inFlight: [] },
    score: { scores: { correctness: 3, clarity: 2 }, gate: { floor: 2, pass_total: 5 } },
    items: [{ name: "A", reach: 10, impact: 2, confidence: 0.8, effort: 2 }],
    candidates: [{ id: "a", total: 9, passing: true }, { id: "b", total: 8, passing: true }],
    verdicts: [{ reviewer: "code", findings: [] }],
    advice: { question: "Choose?", context: "A bounded choice", decisionType: "architecture", options: ["A", "B"] },
    fusionMap: { consensus: [], contradictions: ["x"], partialCoverage: [], uniqueInsights: [], blindSpots: [] },
  };
  await Promise.all(Object.entries(inputs).map(async ([name, value]) => {
    await writeFile(join(fixture, `${name}.json`), JSON.stringify(value));
  }));

  const cases = [
    ["muster_wave", { manifest: plan }, ["wave", join(fixture, "manifest.json")]],
    ["muster_next", { manifest: plan, completed: ["a"] }, ["next", join(fixture, "manifest.json"), "--done", "a"]],
    ["muster_gate_cadence", { manifest: plan, changedLines: 12 }, ["gate-cadence", join(fixture, "manifest.json"), "--changed-lines", "12"]],
    ["muster_sprint_reconcile", inputs.progress, ["sprint-reconcile", join(fixture, "progress.json")]],
    ["muster_score", inputs.score, ["score", join(fixture, "score.json")]],
    ["muster_prioritize", { items: inputs.items, model: "rice" }, ["prioritize", join(fixture, "items.json"), "--model", "rice"]],
    ["muster_pick", { candidates: inputs.candidates }, ["pick", join(fixture, "candidates.json")]],
    ["muster_tally", { verdicts: inputs.verdicts }, ["tally", join(fixture, "verdicts.json")]],
    ["muster_advise", { request: inputs.advice }, ["advise", join(fixture, "advice.json")]],
    ["muster_fuse", { candidates: inputs.candidates, fusionMap: inputs.fusionMap }, ["fuse", join(fixture, "candidates.json"), join(fixture, "fusionMap.json")]],
    ["muster_fast_path", { outcome: "fix typo" }, ["fast-path", "fix typo"]],
    ["muster_plan_checklist", { manifest: plan, done: ["a"] }, ["plan-checklist", join(fixture, "manifest.json"), "--done", "a"]],
  ];

  const expected = await Promise.all(cases.map(async ([, , argv]) => {
    const { stdout } = await execFileP(process.execPath, [cliPath, ...argv], { cwd: rootDir });
    return stdout.trim();
  }));

  const forbiddenCli = join(fixture, "forbidden-cli.mjs");
  await writeFile(forbiddenCli, "throw new Error('pure MCP call crossed the process boundary');\n");
  const responses = await rpc([
    INIT,
    ...cases.map(([name, args], index) => call(index + 2, name, args)),
  ], { env: { NODE_ENV: "test", MUSTER_COWORK_TEST_CLI: forbiddenCli } });

  cases.forEach(([name], index) => {
    const response = responses.get(index + 2).result;
    assert.equal(response.isError, false, name);
    assert.equal(response.content[0].text, expected[index], `${name} output bytes`);
  });
});

test("an immediately cancelled in-process pure call preserves the cancellation bytes", async () => {
  const manifest = { plan: [{ id: "a", task: "Build", mode: "single", deps: [] }] };
  const responses = await rpc([
    INIT,
    call(2, "muster_wave", { manifest }),
    { jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 2 } },
  ]);
  assert.deepEqual(responses.get(2).result, {
    content: [{ type: "text", text: "muster MCP request cancelled" }],
    isError: true,
  });
});

test("mutating MCP tools retain the CLI process boundary", async (t) => {
  const fixture = await mkdtemp(join(tmpdir(), "muster-mcp-mutation-"));
  t.after(() => rm(fixture, { recursive: true, force: true }));
  const marker = join(fixture, "cli-marker.txt");
  const fakeCli = join(fixture, "fake-cli.mjs");
  await writeFile(fakeCli, [
    'import { writeFile } from "node:fs/promises";',
    'await writeFile(process.env.MUSTER_TEST_MARKER, process.argv.slice(2).join(" "));',
    'process.stdin.resume();',
    'await new Promise(resolve => process.stdin.on("end", resolve));',
    'process.stdout.write("{\\"ok\\":true}\\n");',
  ].join("\n"));
  const responses = await rpc([
    INIT,
    call(2, "muster_backlog_publish", { dir: fixture, path: "backlog.md", expectedSha256: "absent", content: "next\n" }),
  ], { env: { NODE_ENV: "test", MUSTER_COWORK_TEST_CLI: fakeCli, MUSTER_TEST_MARKER: marker } });
  assert.equal(responses.get(2).result.isError, false);
  assert.match(await readFile(marker, "utf8"), /^backlog-publish backlog\.md --expect absent$/);
});

test("comma-containing completed and done ids retain the CLI argv join/split bytes", async (t) => {
  const fixture = await mkdtemp(join(tmpdir(), "muster-mcp-comma-"));
  t.after(() => rm(fixture, { recursive: true, force: true }));
  const manifest = { plan: [{ id: "a,b", task: "Comma", mode: "single", deps: [] }] };
  const file = join(fixture, "manifest.json");
  await writeFile(file, JSON.stringify(manifest));
  const [nextCli, checklistCli] = await Promise.all([
    execFileP(process.execPath, [cliPath, "next", file, "--done", "a,b"], { cwd: rootDir }),
    execFileP(process.execPath, [cliPath, "plan-checklist", file, "--done", "a,b"], { cwd: rootDir }),
  ]);
  const responses = await rpc([
    INIT,
    call(2, "muster_next", { manifest, completed: ["a,b"] }),
    call(3, "muster_plan_checklist", { manifest, done: ["a,b"] }),
  ]);
  assert.equal(responses.get(2).result.content[0].text, nextCli.stdout.trim());
  assert.equal(responses.get(3).result.content[0].text, checklistCli.stdout.trim());
});

test("negative changedLines retains the legacy CLI error bytes", async () => {
  const manifest = { plan: [{ id: "a", task: "Build", mode: "single", deps: [] }] };
  const responses = await rpc([INIT, call(2, "muster_gate_cadence", { manifest, changedLines: -1 })]);
  assert.deepEqual(responses.get(2).result, {
    content: [{ type: "text", text: "muster: gate-cadence --changed-lines must be a non-negative finite number" }],
    isError: true,
  });
});

test("a pure call can be cancelled after computation starts without blocking the MCP event loop", async () => {
  const plan = Array.from({ length: 12_000 }, (_, index) => ({
    id: `task-${index}`,
    task: "Work",
    mode: "single",
    deps: index === 0 ? [] : [`task-${index - 1}`],
  }));
  const responses = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [serverPath], { cwd: rootDir, env: process.env, stdio: ["pipe", "pipe", "inherit"] });
    let buffer = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("mid-computation cancellation timeout"));
    }, 5_000);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      buffer += chunk;
      let newline;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (!line) continue;
        const message = JSON.parse(line);
        if (message.id === 2) {
          clearTimeout(timer);
          child.stdin.end();
          resolve(message);
        }
      }
    });
    child.on("error", reject);
    child.stdin.write(`${JSON.stringify(INIT)}\n`);
    child.stdin.write(`${JSON.stringify(call(2, "muster_wave", { manifest: { plan } }))}\n`);
    setTimeout(() => {
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 2 } })}\n`);
    }, 100);
  });
  assert.equal(responses.result.isError, true);
  assert.equal(responses.result.content[0].text, "muster MCP request cancelled");
});

test("fusion reads only the injected sanitized environment", async () => {
  const prior = process.env.MUSTER_FUSE_TOPK;
  process.env.MUSTER_FUSE_TOPK = "1";
  try {
    const candidates = [1, 2, 3].map((id) => ({ id: String(id), total: 10 - id, passing: true, content: String(id) }));
    const fusionMap = { consensus: [], contradictions: ["x"], partialCoverage: [], uniqueInsights: [], blindSpots: [] };
    const response = await invokeInProcessTool("muster_fuse", { candidates, fusionMap }, { environment: {} });
    assert.equal(JSON.parse(response.result.text).topK.length, 3);
  } finally {
    if (prior === undefined) delete process.env.MUSTER_FUSE_TOPK;
    else process.env.MUSTER_FUSE_TOPK = prior;
  }
});

test("in-process workers ignore hostile inherited execArgv", async () => {
  const prior = [...process.execArgv];
  process.execArgv.push("--input-type=module");
  try {
    const manifest = { plan: [{ id: "a", task: "Build", mode: "single", deps: [] }] };
    const response = await invokeInProcessTool("muster_wave", { manifest }, { environment: {} });
    assert.equal(response.result.ok, true, response.result.text);
  } finally {
    process.execArgv.splice(0, process.execArgv.length, ...prior);
  }
});
