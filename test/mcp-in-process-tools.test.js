import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import { computeSprintWaves } from "../src/sprint-waves.js";

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

test("mutating MCP tools retain the CLI process boundary", async () => {
  const fixture = await mkdtemp(join(tmpdir(), "muster-mcp-mutation-"));
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
