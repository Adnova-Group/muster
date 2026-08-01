#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

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
    if (!item.id || !item.task || !item.expected || ids.has(item.id)) {
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
      correctnessRegressions: UNKNOWN
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
    correctnessRegressions: pairs.filter(pair => pair.currentPath.correct && !pair.codeMode.correct).length
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
    .map(model => ({ slug: model.slug ?? model.model ?? UNKNOWN, toolMode: model.tool_mode }));
}

export async function runBenchmark({ fixturePath = DEFAULT_FIXTURE, pairsPath, outPath = DEFAULT_OUT } = {}) {
  const cases = JSON.parse(await readFile(fixturePath, "utf8"));
  validateCases(cases);
  const version = execFileSync("codex", ["--version"], { encoding: "utf8" }).trim();
  const featureText = execFileSync("codex", ["features", "list"], { encoding: "utf8" });
  const features = parseFeatureList(featureText);
  let models = [];
  try {
    const home = process.env.CODEX_HOME || join(process.env.HOME, ".codex");
    models = eligibleCodeModeModels(JSON.parse(await readFile(join(home, "models_cache.json"), "utf8")));
  } catch {
    models = [];
  }
  const stableAvailable = features.code_mode?.stage === "stable" &&
    features.code_mode.enabled === true && models.length > 0;
  let pairs = [];
  if (stableAvailable && pairsPath) pairs = JSON.parse(await readFile(pairsPath, "utf8"));
  const summary = summarizePairs(cases, pairs);
  const adoption = stableAvailable ? evaluateAdoption(summary) : {
    ...evaluateAdoption(summary),
    decision: "REJECT",
    failed: ["stable enabled Code Mode capability: unavailable", ...evaluateAdoption(summary).failed]
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
      stableCodeModeAvailable: stableAvailable
    },
    protocol: {
      comparison: "Code Mode mechanical inner loop versus the current crew-member tool-call path",
      lanes: ["investigator", "evidence"],
      orchestrationExcluded: true,
      fixtureCases: cases.length,
      pairedCasesExecuted: pairs.length,
      status: stableAvailable ? (pairsPath ? "MEASURED" : "READY_NOT_RUN") : "UNSUPPORTED_HOST",
      unsupportedHostFallback: "retain the current crew-member tool-call path"
    },
    summary,
    adoption
  };
  await writeFile(outPath, `${JSON.stringify(result, null, 2)}\n`);
  return result;
}

function option(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const result = await runBenchmark({ pairsPath: option("--pairs"), outPath: option("--out") ?? DEFAULT_OUT });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}
