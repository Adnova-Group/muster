import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { writeFile, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const pexec = promisify(execFile);
const CLI = fileURLToPath(new URL("../src/cli.js", import.meta.url));
const run = (args) => pexec("node", [CLI, ...args]).then(r => JSON.parse(r.stdout));

let dir;
test("setup tmp dir", async () => { dir = await mkdtemp(join(tmpdir(), "muster-cli-")); });

test("humanize-score CLI: file arg + --threshold flow through", async () => {
  const f = join(dir, "txt.md");
  await writeFile(f, "Moreover, we leverage a robust, seamless tapestry — a testament to synergy.");
  const r = await run(["humanize-score", f]);
  assert.equal(typeof r.score, "number");
  assert.equal(r.passing, false, "slop should fail the default threshold");
  const r2 = await run(["humanize-score", f, "--threshold", "1"]);
  assert.equal(r2.threshold, 1);
  assert.equal(r2.passing, true, "threshold flows through");
});

for (const threshold of ["-1", "101", "NaN", "Infinity", "wat"]) {
  test(`humanize-score CLI rejects invalid threshold ${threshold}`, async () => {
    const f = join(dir, "plain.txt");
    await writeFile(f, "Plain text.");
    await assert.rejects(
      () => pexec("node", [CLI, "humanize-score", f, "--threshold", threshold]),
      /humanize-score --threshold must be a finite number between 0 and 100/
    );
  });
}

test("prompt lint --chat CLI parses a messages file", async () => {
  const f = join(dir, "chat.json");
  await writeFile(f, JSON.stringify([{ role: "user", content: "hi" }, { role: "system", content: "be terse" }]));
  const r = await run(["prompt", "lint", "--chat", f]);
  assert.ok(r.findings.some(x => x.id === "LINT-ROLE-011"), "system-not-first flagged via CLI");
});

test("prompt lint --workflow CLI parses a prompts file", async () => {
  const f = join(dir, "wf.json");
  await writeFile(f, JSON.stringify([{ id: "a", text: "write state.json" }, { id: "b", text: "read state.json" }]));
  const r = await run(["prompt", "lint", "--workflow", f]);
  assert.ok(r.findings.some(x => x.id === "LINT-CTX-020"), "shared state.json flagged via CLI");
});

test("prompt lint --tool-schema CLI: both array and {tools} shapes", async () => {
  // Provide the prompt text via a file (rest[1]) so the command doesn't read stdin. The prompt names
  // neither the tool nor its field, so LINT-SCHEMA-003 must fire — proving the schema is wired in.
  const promptFile = join(dir, "agent.txt");
  await writeFile(promptFile, "You are an agent. Complete the task and stop when done.");
  const arr = join(dir, "schema-arr.json");
  await writeFile(arr, JSON.stringify([{ name: "search", inputSchema: { required: ["query"] } }]));
  const blind = await run(["prompt", "lint", promptFile, "--tool-schema", arr]);
  assert.ok(blind.findings.some(x => x.id === "LINT-SCHEMA-003"), "schema rule wired via CLI (array shape)");
  const obj = join(dir, "schema-obj.json");
  await writeFile(obj, JSON.stringify({ tools: [{ name: "search", inputSchema: { required: ["query"] } }] }));
  const blind2 = await run(["prompt", "lint", promptFile, "--tool-schema", obj]);
  assert.ok(blind2.findings.some(x => x.id === "LINT-SCHEMA-003"), "{tools} shape also parses");
});

test("prompt eval CLI grades a suite file", async () => {
  const f = join(dir, "suite.json");
  await writeFile(f, JSON.stringify({ dataset: [{ output: '{"a":1}', format: "json" }], passThreshold: 7 }));
  const r = await run(["prompt", "eval", f]);
  assert.ok(typeof r.averageScore === "number" || typeof r.accuracy === "number", "eval returns a report");
});

test("prompt optimize CLI selects a winner from a candidates file", async () => {
  const f = join(dir, "cand.json");
  await writeFile(f, JSON.stringify({ candidates: [
    { id: "baseline", total: 8, passing: true },
    { id: "v1", total: 11, passing: true },
  ] }));
  const r = await run(["prompt", "optimize", f]);
  assert.equal(r.winner, "v1");
});

test("prompt eval CLI without a file exits non-zero (usage error path)", async () => {
  await assert.rejects(() => pexec("node", [CLI, "prompt", "eval"]), /./);
});
