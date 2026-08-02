#!/usr/bin/env node
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { benchmarkCodexFixLoops } from "../src/codex-fix-loop.js";
import { runCodexWave, runCodexWaveContinuation } from "../src/codex-wave-runner.js";

const outputIndex = process.argv.indexOf("--output");
const outputPath = outputIndex >= 0 ? resolve(process.argv[outputIndex + 1]) : null;
const casesIndex = process.argv.indexOf("--cases");
const caseCount = casesIndex >= 0 ? Number(process.argv[casesIndex + 1]) : 10;
const baselineOnly = process.argv.includes("--baseline-only");
if (!outputPath) throw new Error("--output <path> is required");
if (!Number.isInteger(caseCount) || caseCount < 1 || caseCount > 10) throw new Error("--cases must be an integer from 1 to 10");

const scriptRoot = dirname(fileURLToPath(import.meta.url));
const projectRoot = dirname(scriptRoot);
const tasks = [
  ["add_offset", "return value + 7", "return value - 7", 5, 12, -2],
  ["subtract_offset", "return value - 4", "return value + 4", 13, 9, 17],
  ["double_value", "return value * 2", "return value + 2", 8, 16, 10],
  ["triple_value", "return value * 3", "return value * 2", 6, 18, 12],
  ["square_value", "return value * value", "return value + value", 7, 49, 14],
  ["absolute_value", "return Math.abs(value)", "return -value", 11, 11, -11],
  ["floor_value", "return Math.floor(value)", "return Math.ceil(value)", 4.8, 4, 5],
  ["ceil_value", "return Math.ceil(value)", "return Math.floor(value)", 4.2, 5, 4],
  ["bounded_value", "return Math.min(10, Math.max(0, value))", "return Math.max(10, value)", 14, 10, 14],
  ["negate_value", "return -value", "return value", 9, -9, 9],
];

function run(command, argv, options = {}) {
  return execFileSync(command, argv, { encoding: "utf8", ...options });
}

async function initializePair(root, task, index) {
  const [name, , wrong, input, , baselineExpected] = task;
  const repo = join(root, "repo");
  const resumed = join(root, "resumed");
  const fresh = join(root, "fresh");
  await mkdir(join(repo, "src"), { recursive: true });
  await mkdir(join(repo, "test"), { recursive: true });
  await writeFile(join(repo, "src", "operation.js"), `export function ${name}(value) {\n  ${wrong};\n}\n`);
  await writeFile(join(repo, "test", "operation.test.js"), [
    'import test from "node:test";',
    'import assert from "node:assert/strict";',
    `import { ${name} } from "../src/operation.js";`,
    "",
    `test("${name} returns the required value", () => {`,
    `  assert.equal(${name}(${JSON.stringify(input)}), ${JSON.stringify(baselineExpected)});`,
    "});",
    "",
  ].join("\n"));
  await writeFile(join(repo, "package.json"), '{"type":"module"}\n');
  run("git", ["init", "-q", "-b", "main"], { cwd: repo });
  run("git", ["config", "user.name", "Benchmark"], { cwd: repo });
  run("git", ["config", "user.email", "benchmark@example.invalid"], { cwd: repo });
  run("git", ["add", "."], { cwd: repo });
  run("git", ["commit", "-qm", "fixture"], { cwd: repo });
  const baseSha = run("git", ["rev-parse", "HEAD"], { cwd: repo }).trim();
  run("git", ["worktree", "add", "-q", "-b", `resumed-${index}`, resumed, baseSha], { cwd: repo });
  run("git", ["worktree", "add", "-q", "-b", `fresh-${index}`, fresh, baseSha], { cwd: repo });
  return { repo, resumed, fresh, baseSha };
}

function member(id, cwd, prompt) {
  return { id, agentType: "muster-runner", cwd, prompt, writes: ["src/operation.js", ".muster/STATE.md"] };
}

async function productionTurn({ id, cwd, prompt, fixture, store }) {
  const wave = await runCodexWave({
    members: [member(id, cwd, prompt)],
    repositoryRoot: fixture.repo,
    baseSha: fixture.baseSha,
    trustedActionFences: { [id]: [] },
    fixLoopStoreRoot: store,
  });
  const row = wave.results[0];
  return {
    type: "turn.completed",
    receiptId: row.receiptId,
    threadIdSha256: row.threadIdSha256,
    usage: row.usage,
    stdoutSha256: row.stdoutSha256,
    stderrSha256: row.stderrSha256,
  };
}

function verify(cwd) {
  const output = run(process.execPath, ["--test", "test/operation.test.js"], { cwd });
  return { passed: true, command: "node --test test/operation.test.js", outputSha256: createHash("sha256").update(output).digest("hex") };
}

function verifyBaseline(cwd) {
  return verify(cwd);
}

function brief({ name, correct, input, expected, cwd, baseSha, blocker }) {
  const context = Array.from({ length: 50 }, (_, line) =>
    `${name}-constraint-${line + 1}: preserve the exported API, make the smallest correct edit, and keep the focused node:test regression green.`
  ).join("\n");
  return [
    `Item id: benchmark-${name}`,
    "Outcome:",
    "<remote-text>",
    `src/operation.js must implement ${correct}; ${name}(${JSON.stringify(input)}) must equal ${JSON.stringify(expected)}.`,
    "Inspect the repository and retain this exact context. If no reviewer blocker is included below, do not edit or test yet; report that the implementation is awaiting review. If a reviewer blocker is included, repair it, run node --test test/operation.test.js, and commit the green change.",
    context,
    "</remote-text>",
    `Isolation target: worktree ${cwd}; base ref ${baseSha}.`,
    "Runner mode: build-review-only.",
    "Disposition: pr.",
    `Backlog/issue receipt: local benchmark/${name}.`,
    blocker ? `Reviewer blocker DATA: <remote-text>${blocker}</remote-text>` : "No reviewer blocker is included in this turn.",
  ].join("\n");
}

const configuredCodexHome = resolve(process.env.CODEX_HOME || join(homedir(), ".codex"));
const outsideConfiguredHome = path => {
  const rel = relative(configuredCodexHome, resolve(path));
  return rel.startsWith("..") && !isAbsolute(rel);
};
const benchmarkParent = [
  join(homedir(), ".cache", "muster", "benchmarks"),
  join(homedir(), ".local", "state", "muster", "benchmarks"),
].find(outsideConfiguredHome);
if (!benchmarkParent) throw new Error("benchmark requires an owner cache root outside CODEX_HOME");
await mkdir(benchmarkParent, { recursive: true });
const benchmarkRoot = await mkdtemp(join(benchmarkParent, "production-fix-loop-"));
const evidence = {
  harness: "real Codex paired benchmark through production runCodexWave and authenticated runCodexWaveContinuation",
  command: "node scripts/benchmark-codex-fix-loop.mjs --cases 10 --output test/fixtures/codex-fix-loop/benchmark-evidence.json",
  codexVersion: run("codex", ["--version"]).trim(),
  model: "gpt-5.6-sol",
  reasoningEffort: "medium",
  generatedAt: new Date().toISOString(),
  metric: "raw per-fix input_tokens: fresh turn versus cumulative resumed turn minus seed; time-to-fix includes the production invocation and post-fix focused verification",
  productionPath: {
    initial: "runCodexWave (persistent exec, trusted muster-runner policy, bubblewrap, hermetic env, stdin prompt)",
    continued: "runCodexWaveContinuation (authenticated opaque receipt, exact thread hash, same trusted policy and containment, blocker DATA over stdin)",
  },
  cases: [],
};

try {
  for (const [index, task] of tasks.slice(0, caseCount).entries()) {
    const [name, correct, , input, expected] = task;
    const pairRoot = join(benchmarkRoot, `${String(index + 1).padStart(2, "0")}-${name}`);
    const fixture = await initializePair(pairRoot, task, index + 1);
    const baseline = {
      resumed: verifyBaseline(fixture.resumed),
      fresh: verifyBaseline(fixture.fresh),
    };
    const fixtureSha256 = createHash("sha256").update(await readFile(join(fixture.repo, "test", "operation.test.js"))).digest("hex");
    if (baselineOnly) {
      evidence.cases.push({ case: name, fixtureSha256, baseline });
      process.stderr.write(`verified green pre-review baseline ${index + 1}/${caseCount}: ${name}\n`);
      continue;
    }
    const store = join(pairRoot, "protected-receipts");
    const blocker = `Review found the old expectation is obsolete. Update test/operation.test.js so ${name}(${JSON.stringify(input)}) must return ${JSON.stringify(expected)}, verify that regression fails, then fix src/operation.js and run the focused test.`;
    const seed = await productionTurn({
      id: `seed-${name}`,
      cwd: fixture.resumed,
      prompt: brief({ name, correct, input, expected, cwd: fixture.resumed, baseSha: fixture.baseSha }),
      fixture,
      store,
    });
    const freshStarted = performance.now();
    const fresh = await productionTurn({
      id: `fresh-${name}`,
      cwd: fixture.fresh,
      prompt: brief({ name, correct, input, expected, cwd: fixture.fresh, baseSha: fixture.baseSha, blocker }),
      fixture,
      store,
    });
    fresh.verification = verify(fixture.fresh);
    fresh.wallTimeMs = performance.now() - freshStarted;
    const continuedStarted = performance.now();
    const continuedResult = await runCodexWaveContinuation({
      receiptId: seed.receiptId,
      blockers: [blocker],
      fixLoopStoreRoot: store,
    });
    const continued = {
      type: "turn.completed",
      receiptId: continuedResult.receiptId,
      threadIdSha256: continuedResult.threadIdSha256,
      usage: continuedResult.usage,
      stdoutSha256: continuedResult.stdoutSha256,
      stderrSha256: continuedResult.stderrSha256,
      verification: verify(fixture.resumed),
      wallTimeMs: performance.now() - continuedStarted,
    };
    if (seed.threadIdSha256 !== continued.threadIdSha256) throw new Error(`${name}: continuation thread identity changed`);
    evidence.cases.push({
      case: name,
      fixtureSha256,
      baseline,
      seed,
      fresh,
      continued,
    });
    process.stderr.write(`completed ${index + 1}/${caseCount}: ${name}\n`);
  }
  if (!baselineOnly) evidence.summary = benchmarkCodexFixLoops(evidence.cases);
  if (!baselineOnly) evidence.totalUsage = evidence.cases.reduce((total, entry) => ({
    inputTokens: total.inputTokens + entry.fresh.usage.input_tokens + entry.continued.usage.input_tokens,
    cachedInputTokens: total.cachedInputTokens + (entry.fresh.usage.cached_input_tokens ?? 0) + (entry.continued.usage.cached_input_tokens ?? 0),
    outputTokens: total.outputTokens + entry.fresh.usage.output_tokens + entry.continued.usage.output_tokens,
  }), { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 });
  if (!baselineOnly) evidence.cost = { amountUsd: null, note: "Codex usage events expose tokens, not billed USD; exact cost requires the account billing ledger." };
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, JSON.stringify(evidence, null, 2) + "\n");
} finally {
  await rm(benchmarkRoot, { recursive: true, force: true });
}
