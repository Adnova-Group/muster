#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";

const outputIndex = process.argv.indexOf("--output");
const outputPath = outputIndex >= 0 ? process.argv[outputIndex + 1] : null;
const casesIndex = process.argv.indexOf("--cases");
const caseCount = casesIndex >= 0 ? Number(process.argv[casesIndex + 1]) : 10;
if (!outputPath) throw new Error("--output <path> is required");
if (!Number.isInteger(caseCount) || caseCount < 1 || caseCount > 10) throw new Error("--cases must be an integer from 1 to 10");

const MODEL = "gpt-5.6-sol";
const REASONING = "medium";
const tasks = [
  ["add_offset", "return value + 7", "return value - 7", 5, 12],
  ["subtract_offset", "return value - 4", "return value + 4", 13, 9],
  ["double_value", "return value * 2", "return value + 2", 8, 16],
  ["triple_value", "return value * 3", "return value * 2", 6, 18],
  ["square_value", "return value * value", "return value + value", 7, 49],
  ["absolute_value", "return Math.abs(value)", "return -value", -11, 11],
  ["floor_value", "return Math.floor(value)", "return Math.ceil(value)", 4.8, 4],
  ["ceil_value", "return Math.ceil(value)", "return Math.floor(value)", 4.2, 5],
  ["bounded_value", "return Math.min(10, Math.max(0, value))", "return Math.max(10, value)", 14, 10],
  ["negate_value", "return -value", "return value", 9, -9]
];

function run(command, argv, options = {}) {
  const result = spawnSync(command, argv, { encoding: "utf8", ...options });
  if (result.status !== 0) throw new Error(`${command} ${argv.join(" ")} failed:\n${result.stderr || result.stdout}`);
  return result.stdout;
}

function runCodex(argv, cwd) {
  return new Promise((resolve, reject) => {
    const started = performance.now();
    const child = spawn("codex", argv, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", chunk => { stdout += chunk; });
    child.stderr.on("data", chunk => { stderr += chunk; });
    child.on("error", reject);
    child.on("exit", code => {
      const wallTimeMs = performance.now() - started;
      const events = stdout.split("\n").filter(Boolean).map(line => JSON.parse(line));
      const threadId = events.find(event => event.type === "thread.started")?.thread_id;
      const usage = events.filter(event => event.type === "turn.completed").at(-1)?.usage;
      if (code !== 0 || !threadId || !usage) {
        reject(new Error(`codex ${argv.join(" ")} failed (${code}):\n${stderr}\n${stdout}`));
        return;
      }
      resolve({ type: "turn.completed", threadId, usage, wallTimeMs });
    });
  });
}

function initializeRepo(repo, task) {
  const [name, _correct, wrong, input, expected] = task;
  return Promise.all([
    mkdir(join(repo, "src"), { recursive: true }),
    mkdir(join(repo, "test"), { recursive: true })
  ]).then(async () => {
    await writeFile(join(repo, "src", "operation.js"), `export function ${name}(value) {\n  ${wrong};\n}\n`);
    await writeFile(join(repo, "test", "operation.test.js"), [
      'import test from "node:test";',
      'import assert from "node:assert/strict";',
      `import { ${name} } from "../src/operation.js";`,
      "",
      `test("${name} returns the required value", () => {`,
      `  assert.equal(${name}(${JSON.stringify(input)}), ${JSON.stringify(expected)});`,
      "});",
      ""
    ].join("\n"));
    await writeFile(join(repo, "package.json"), '{"type":"module"}\n');
    run("git", ["init", "-q"], { cwd: repo });
    run("git", ["-c", "user.name=Benchmark", "-c", "user.email=benchmark@example.invalid", "add", "."], { cwd: repo });
    run("git", ["-c", "user.name=Benchmark", "-c", "user.email=benchmark@example.invalid", "commit", "-qm", "fixture"], { cwd: repo });
  });
}

function verify(repo) {
  const output = run(process.execPath, ["--test", "test/operation.test.js"], { cwd: repo });
  return { passed: true, command: "node --test test/operation.test.js", output };
}

function totalUsage(cases) {
  const totals = { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 };
  for (const entry of cases) {
    for (const turn of [entry.seed, entry.fresh, entry.continued]) {
      totals.inputTokens += turn.usage.input_tokens;
      totals.cachedInputTokens += turn.usage.cached_input_tokens ?? 0;
      totals.outputTokens += turn.usage.output_tokens;
    }
  }
  return totals;
}

const benchmarkRoot = await mkdtemp(join(tmpdir(), "muster-codex-fix-loop-"));
const evidence = {
  harness: "real Codex fresh-dispatch vs exact-thread-id resume coding fix benchmark",
  command: "node scripts/benchmark-codex-fix-loop.mjs --cases 10 --output test/fixtures/codex-fix-loop/benchmark-evidence.json",
  codexVersion: run("codex", ["--version"]).trim(),
  model: MODEL,
  reasoningEffort: REASONING,
  generatedAt: new Date().toISOString(),
  metric: "input tokens = native turn.completed.usage.input_tokens; time-to-fix = Codex invocation start through post-fix test pass; uncached input tokens are retained as supplemental evidence",
  cases: []
};

try {
  for (const [index, task] of tasks.slice(0, caseCount).entries()) {
    const [name, correct, _wrong, input, expected] = task;
    const pairRoot = join(benchmarkRoot, `${String(index + 1).padStart(2, "0")}-${name}`);
    const resumedRepo = join(pairRoot, "resumed");
    const freshRepo = join(pairRoot, "fresh");
    await Promise.all([initializeRepo(resumedRepo, task), initializeRepo(freshRepo, task)]);

    const uniqueContext = Array.from({ length: 80 }, (_, line) =>
      `${name}-constraint-${line + 1}: preserve the exported function name, make the smallest correct edit, and keep the node:test regression green.`
    ).join("\n");
    const taskPrompt = [
      `You are the implementer for benchmark case ${name}.`,
      `Outcome: src/operation.js must implement ${correct}; ${name}(${JSON.stringify(input)}) must equal ${JSON.stringify(expected)}.`,
      "Inspect the repository and retain this task context. Do not edit files and do not run tests yet.",
      "A reviewer will next send only a blocker delta. When it arrives, fix that blocker and run node --test test/operation.test.js.",
      uniqueContext,
      "Reply READY after inspection."
    ].join("\n");
    const blocker = `[blocker] test/operation.test.js: ${name}(${JSON.stringify(input)}) must return ${JSON.stringify(expected)}; fix the implementation and run the focused test.`;

    const seed = await runCodex([
      "exec", "--json", "-C", resumedRepo, "-m", MODEL,
      "-c", `model_reasoning_effort="${REASONING}"`, taskPrompt
    ], resumedRepo);

    let fresh, continued;
    const runFresh = async () => {
      const started = performance.now();
      const turn = await runCodex([
        "exec", "--json", "--ephemeral", "-C", freshRepo, "-m", MODEL,
        "-c", `model_reasoning_effort="${REASONING}"`,
        `${taskPrompt}\n\nReviewer blocker:\n${blocker}\nFix it now and run the focused test.`
      ], freshRepo);
      return { ...turn, wallTimeMs: performance.now() - started, verification: verify(freshRepo) };
    };
    const runContinued = async () => {
      const started = performance.now();
      const turn = await runCodex([
        "exec", "resume", "--json", "-m", MODEL,
        "-c", `model_reasoning_effort="${REASONING}"`, seed.threadId, blocker
      ], resumedRepo);
      return { ...turn, wallTimeMs: performance.now() - started, verification: verify(resumedRepo) };
    };
    if (index % 2 === 0) {
      fresh = await runFresh();
      continued = await runContinued();
    } else {
      continued = await runContinued();
      fresh = await runFresh();
    }
    evidence.cases.push({
      case: name,
      fixtureSha256: createHash("sha256").update(await readFile(join(freshRepo, "test", "operation.test.js"))).digest("hex"),
      seed,
      fresh,
      continued
    });
    process.stderr.write(`completed ${index + 1}/${caseCount}: ${name}\n`);
  }
  evidence.totalUsage = totalUsage(evidence.cases);
  evidence.cost = {
    amountUsd: null,
    note: "Codex turn.completed.usage exposes tokens, not billed USD; use the account billing ledger for exact cost."
  };
  await writeFile(outputPath, JSON.stringify(evidence, null, 2) + "\n");
} finally {
  await rm(benchmarkRoot, { recursive: true, force: true });
}
