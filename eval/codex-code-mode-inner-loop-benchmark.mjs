#!/usr/bin/env node
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";

export const UNKNOWN = "UNKNOWN";

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_FIXTURE = join(HERE, "fixtures", "codex-code-mode-inner-loop-cases.json");
const DEFAULT_OUT = join(HERE, "results", "codex-code-mode-inner-loop-benchmark.json");

export const ADOPTION_THRESHOLDS = Object.freeze({
  minimumCompletedPairs: 10,
  minimumMedianReductionPct: 20,
  maximumCorrectnessRegressions: 0
});

export function parseFeatureList(text) {
  const features = {};
  for (const line of String(text).split(/\r?\n/)) {
    const match = line.match(/^(\S+)\s{2,}(removed|deprecated|experimental|under development|stable)\s{2,}(true|false)$/);
    if (!match) continue;
    features[match[1]] = { stage: match[2], enabled: match[3] === "true" };
  }
  return features;
}

function percentile(values, fraction) {
  if (!values.length) return UNKNOWN;
  const sorted = [...values].sort((a, b) => a - b);
  const index = (sorted.length - 1) * fraction;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  const value = lower === upper
    ? sorted[lower]
    : sorted[lower] + (sorted[upper] - sorted[lower]) * (index - lower);
  return Number(value.toFixed(3));
}

function distribution(values) {
  return {
    samples: values.length ? values : UNKNOWN,
    p50: percentile(values, 0.5),
    p95: percentile(values, 0.95)
  };
}

function validateCases(cases) {
  if (!Array.isArray(cases) || cases.length < ADOPTION_THRESHOLDS.minimumCompletedPairs) {
    throw new Error(`benchmark requires at least ${ADOPTION_THRESHOLDS.minimumCompletedPairs} cases`);
  }
  const lanes = [...new Set(cases.map(item => item.lane))].sort();
  if (JSON.stringify(lanes) !== JSON.stringify(["evidence", "investigator"])) {
    throw new Error("benchmark cases must cover investigator and evidence lanes");
  }
  const ids = new Set();
  for (const item of cases) {
    if (!item.id || !item.task || !item.expected || !item.sourceCommit || ids.has(item.id)) {
      throw new Error(`invalid or duplicate benchmark case: ${JSON.stringify(item)}`);
    }
    ids.add(item.id);
  }
  return ids;
}

function validateMeasurement(measurement, side, id) {
  if (!measurement || !Number.isFinite(measurement.latencyMs) || measurement.latencyMs < 0 ||
      !Number.isFinite(measurement.inputTokens) || measurement.inputTokens < 0 ||
      typeof measurement.correct !== "boolean") {
    throw new Error(`invalid ${side} measurement for ${id}`);
  }
}

export function summarizePairs(cases, pairs) {
  const caseIds = validateCases(cases);
  if (!Array.isArray(pairs)) throw new Error("pairs must be an array");
  const seen = new Set();
  for (const pair of pairs) {
    if (!caseIds.has(pair.id) || seen.has(pair.id)) throw new Error(`unknown or duplicate pair: ${pair.id}`);
    seen.add(pair.id);
    validateMeasurement(pair.codeMode, "codeMode", pair.id);
    validateMeasurement(pair.currentPath, "currentPath", pair.id);
  }
  if (!pairs.length) {
    return {
      caseCount: cases.length,
      completedPairs: 0,
      codeMode: { latencyMs: distribution([]), inputTokens: distribution([]) },
      currentPath: { latencyMs: distribution([]), inputTokens: distribution([]) },
      correctnessRegressions: UNKNOWN,
      codeModeIncorrect: UNKNOWN,
      currentPathIncorrect: UNKNOWN
    };
  }
  return {
    caseCount: cases.length,
    completedPairs: pairs.length,
    codeMode: {
      latencyMs: distribution(pairs.map(pair => pair.codeMode.latencyMs)),
      inputTokens: distribution(pairs.map(pair => pair.codeMode.inputTokens))
    },
    currentPath: {
      latencyMs: distribution(pairs.map(pair => pair.currentPath.latencyMs)),
      inputTokens: distribution(pairs.map(pair => pair.currentPath.inputTokens))
    },
    correctnessRegressions: pairs.filter(pair => pair.currentPath.correct && !pair.codeMode.correct).length,
    codeModeIncorrect: pairs.filter(pair => !pair.codeMode.correct).length,
    currentPathIncorrect: pairs.filter(pair => !pair.currentPath.correct).length
  };
}

function reductionPct(candidate, baseline) {
  if (candidate === UNKNOWN || baseline === UNKNOWN || baseline === 0) return UNKNOWN;
  return Number((((baseline - candidate) / baseline) * 100).toFixed(3));
}

export function evaluateAdoption(summary) {
  const medianLatencyReductionPct = reductionPct(
    summary.codeMode.latencyMs.p50,
    summary.currentPath.latencyMs.p50
  );
  const medianInputTokenReductionPct = reductionPct(
    summary.codeMode.inputTokens.p50,
    summary.currentPath.inputTokens.p50
  );
  const improvementPass = [medianLatencyReductionPct, medianInputTokenReductionPct]
    .some(value => value !== UNKNOWN && value >= ADOPTION_THRESHOLDS.minimumMedianReductionPct);
  const checks = [
    {
      name: "10 completed pairs",
      value: summary.completedPairs,
      pass: summary.completedPairs >= ADOPTION_THRESHOLDS.minimumCompletedPairs
    },
    {
      name: "median latency or input-token reduction",
      value: { medianLatencyReductionPct, medianInputTokenReductionPct },
      pass: improvementPass
    },
    {
      name: "correctness regressions",
      value: summary.correctnessRegressions,
      pass: summary.correctnessRegressions !== UNKNOWN &&
        summary.correctnessRegressions <= ADOPTION_THRESHOLDS.maximumCorrectnessRegressions
    },
    {
      name: "gold-case correctness",
      value: { codeModeIncorrect: summary.codeModeIncorrect, currentPathIncorrect: summary.currentPathIncorrect },
      pass: summary.codeModeIncorrect === 0 && summary.currentPathIncorrect === 0
    }
  ];
  const failed = checks.filter(check => !check.pass).map(check => {
    const value = typeof check.value === "object" ? JSON.stringify(check.value) : check.value;
    return `${check.name}: ${value === UNKNOWN ? "UNKNOWN (threshold cannot pass)" : value}`;
  });
  return {
    decision: failed.length ? "REJECT" : "ADOPT",
    metrics: { medianLatencyReductionPct, medianInputTokenReductionPct },
    checks,
    failed
  };
}

function eligibleCodeModeModels(catalog) {
  const models = Array.isArray(catalog?.models) ? catalog.models : Array.isArray(catalog) ? catalog : [];
  return models
    .filter(model => ["code_mode", "code_mode_only"].includes(model.tool_mode))
    .map(model => ({ slug: model.slug ?? model.model ?? UNKNOWN, toolMode: model.tool_mode }))
    .sort((left, right) => left.slug.localeCompare(right.slug));
}

function collectToolNames(value, found = new Set()) {
  if (!value || typeof value !== "object") return found;
  for (const [key, child] of Object.entries(value)) {
    if (["name", "tool", "tool_name", "toolName"].includes(key) && typeof child === "string") {
      found.add(child);
    }
    collectToolNames(child, found);
  }
  return found;
}

export function effectiveToolModeFromEvents(events) {
  const toolNames = [...collectToolNames(events)];
  const codeMode = toolNames.some(name => ["exec", "functions.exec"].includes(name));
  const directTools = toolNames.some(name => [
    "apply_patch", "exec_command", "read_file", "view_image", "write_stdin"
  ].includes(name));
  if (codeMode === directTools) return { mode: UNKNOWN, toolNames };
  return { mode: codeMode ? "code_mode" : "direct_tools", toolNames };
}

function deepEqualJson(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function findInputTokens(value, found = []) {
  if (!value || typeof value !== "object") return found;
  for (const [key, child] of Object.entries(value)) {
    if (["input_tokens", "inputTokens"].includes(key) && Number.isFinite(child)) found.push(child);
    else findInputTokens(child, found);
  }
  return found;
}

function runCodex(args, { cwd }) {
  return new Promise((resolve, reject) => {
    const started = performance.now();
    const child = spawn("codex", args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", chunk => { stdout += chunk; });
    child.stderr.on("data", chunk => { stderr += chunk; });
    const timer = setTimeout(() => child.kill("SIGTERM"), 180_000);
    child.on("error", reject);
    child.on("close", exitCode => {
      clearTimeout(timer);
      resolve({
        exitCode,
        stdout,
        stderr,
        latencyMs: Number((performance.now() - started).toFixed(3))
      });
    });
  });
}

export async function executeCodexCase({ benchmarkCase, mode, cwd, model }) {
  const scratch = mkdtempSync(join(tmpdir(), "muster-code-mode-benchmark-"));
  const schemaPath = join(scratch, "answer.schema.json");
  const answerPath = join(scratch, "answer.json");
  try {
    await writeFile(schemaPath, JSON.stringify({
      type: "object",
      additionalProperties: false,
      required: ["value"],
      properties: { value: { type: "string" } }
    }));
    const prompt = [
      "Mechanical benchmark case. Do not spawn agents or orchestrate work.",
      mode === "codeMode"
        ? "Use the Code Mode JavaScript exec tool for repository inspection; do not use direct shell/file tools."
        : "Use direct shell/file tools for repository inspection; do not use the Code Mode functions.exec tool.",
      `Inspect repository commit ${benchmarkCase.sourceCommit} using read-only tools.`,
      benchmarkCase.task,
      "Return only the schema-conforming JSON answer."
    ].join("\n");
    const args = [
      "exec", "--ephemeral", "--json", "--sandbox", "read-only", "--cd", cwd,
      "--model", model, "--output-schema", schemaPath, "--output-last-message", answerPath,
      "--config", "model_reasoning_effort=\"low\"", "--disable", "multi_agent",
      mode === "codeMode" ? "--enable" : "--disable", "code_mode", prompt
    ];
    const execution = await runCodex(args, { cwd });
    if (execution.exitCode !== 0) {
      throw new Error(`${mode} execution failed for ${benchmarkCase.id}: ${execution.stderr.trim()}`);
    }
    const events = execution.stdout.split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
    const effectiveToolMode = effectiveToolModeFromEvents(events);
    const tokenCandidates = events.flatMap(event => findInputTokens(event));
    if (!tokenCandidates.length) throw new Error(`${mode} execution reported no input-token usage`);
    const answerText = await readFile(answerPath, "utf8");
    const answer = JSON.parse(answerText);
    return {
      latencyMs: execution.latencyMs,
      inputTokens: Math.max(...tokenCandidates),
      correct: deepEqualJson(answer, benchmarkCase.expected),
      provenance: {
        sourceCommit: benchmarkCase.sourceCommit,
        model,
        featureOverride: mode === "codeMode" ? "code_mode=true" : "code_mode=false",
        exitCode: execution.exitCode,
        eventCount: events.length,
        eventStreamSha256: createHash("sha256").update(execution.stdout).digest("hex"),
        effectiveToolMode: effectiveToolMode.mode,
        observedToolNames: effectiveToolMode.toolNames,
        answer
      }
    };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

async function defaultProbe() {
  const version = execFileSync("codex", ["--version"], { encoding: "utf8" }).trim();
  const features = parseFeatureList(execFileSync("codex", ["features", "list"], { encoding: "utf8" }));
  let models = [];
  try {
    const home = process.env.CODEX_HOME || join(process.env.HOME, ".codex");
    models = eligibleCodeModeModels(JSON.parse(await readFile(join(home, "models_cache.json"), "utf8")));
  } catch {
    models = [];
  }
  return { version, features, models };
}

export async function runBenchmark({
  fixturePath = DEFAULT_FIXTURE,
  outPath = DEFAULT_OUT,
  cwd = join(HERE, ".."),
  probe = defaultProbe,
  executeCase = executeCodexCase
} = {}) {
  const cases = JSON.parse(await readFile(fixturePath, "utf8"));
  validateCases(cases);
  const { version, features, models } = await probe();
  const stableFeatureAvailable = features.code_mode?.stage === "stable" &&
    features.code_mode.enabled === true;
  const switchableModels = models.filter(model => model.toolMode === "code_mode");
  const stableAvailable = stableFeatureAvailable && switchableModels.length > 0;
  let modeIdentity = stableAvailable
    ? { status: "PENDING", reason: "effective tool modes must be observed in both executions" }
    : {
        status: "UNAVAILABLE",
        reason: stableFeatureAvailable
          ? "no same-model switchable code_mode candidate; code_mode_only cannot provide a direct-tool control"
          : "stable enabled Code Mode feature unavailable; effective modes cannot be compared"
      };
  const pairs = [];
  if (stableAvailable) {
    for (const [index, benchmarkCase] of cases.entries()) {
      execFileSync("git", ["cat-file", "-e", `${benchmarkCase.sourceCommit}^{commit}`], { cwd });
      const modes = index % 2 === 0 ? ["codeMode", "currentPath"] : ["currentPath", "codeMode"];
      const measurements = {};
      for (const mode of modes) {
        measurements[mode] = await executeCase({ benchmarkCase, mode, cwd, model: switchableModels[0].slug });
      }
      const observed = {
        codeMode: measurements.codeMode?.provenance?.effectiveToolMode ?? UNKNOWN,
        currentPath: measurements.currentPath?.provenance?.effectiveToolMode ?? UNKNOWN
      };
      if (observed.codeMode !== "code_mode" || observed.currentPath !== "direct_tools") {
        pairs.length = 0;
        modeIdentity = {
          status: "UNVERIFIED",
          reason: `distinct effective tool modes not observed: ${JSON.stringify(observed)}`,
          observed
        };
        break;
      }
      pairs.push({
        id: benchmarkCase.id,
        executionOrder: modes,
        codeMode: measurements.codeMode,
        currentPath: measurements.currentPath
      });
    }
    if (pairs.length === cases.length) {
      modeIdentity = {
        status: "VERIFIED_DISTINCT",
        reason: "every pair observed code_mode for the candidate and direct_tools for the control"
      };
    }
  }
  const summary = summarizePairs(cases, pairs);
  const evaluated = evaluateAdoption(summary);
  const modesVerified = modeIdentity.status === "VERIFIED_DISTINCT";
  const adoption = modesVerified ? evaluated : {
    ...evaluated,
    decision: "REJECT",
    failed: [`effective standard versus Code Mode identity: ${modeIdentity.reason}`, ...evaluated.failed]
  };
  const result = {
    schema: "muster-codex-code-mode-inner-loop-benchmark/v1",
    generatedAt: new Date().toISOString(),
    environment: {
      codexVersion: version,
      configuration: "default active Codex configuration; no benchmark feature override",
      features: {
        codeMode: features.code_mode ?? UNKNOWN,
        codeModeHost: features.code_mode_host ?? UNKNOWN
      },
      eligibleModels: models,
      switchableModels,
      stableCodeModeAvailable: stableAvailable
    },
    protocol: {
      comparison: "Code Mode mechanical inner loop versus the current crew-member tool-call path",
      lanes: ["investigator", "evidence"],
      orchestrationExcluded: true,
      fixtureCases: cases.length,
      pairedCasesExecuted: pairs.length,
      status: modesVerified ? "MEASURED" : stableAvailable ? "MODE_IDENTITY_UNVERIFIED" : "UNSUPPORTED_HOST",
      modeIdentity,
      unsupportedHostFallback: "retain the current crew-member tool-call path"
    },
    pairs,
    summary,
    adoption
  };
  if (outPath) await writeFile(outPath, `${JSON.stringify(result, null, 2)}\n`);
  return result;
}

function option(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const result = await runBenchmark({ outPath: option("--out") ?? DEFAULT_OUT });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}
