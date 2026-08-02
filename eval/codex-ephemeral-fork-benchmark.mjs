#!/usr/bin/env node
import { spawn, execFileSync } from "node:child_process";
import { createInterface } from "node:readline";
import { readFile, writeFile } from "node:fs/promises";
import { mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";

export const UNKNOWN = "UNKNOWN";

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_FIXTURE = join(HERE, "fixtures", "codex-ephemeral-fork-cases.json");
const DEFAULT_OUT = join(HERE, "results", "codex-ephemeral-fork-benchmark.json");

export const ADOPTION_THRESHOLDS = Object.freeze({
  minimumCases: 10,
  minimumModelWallTimeReductionPct: 10,
  minimumModelInputTokenReductionPct: 10,
  minimumCorrectnessDelta: 0,
  maximumHistoryPollutionDeltaTurns: 0,
  maximumEphemeralPersistenceLeaks: 0
});

function mean(values) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : UNKNOWN;
}

export function percentile(values, percentileValue) {
  if (!Array.isArray(values) || values.length === 0) {
    throw new Error("percentile requires a non-empty values array");
  }
  if (!(percentileValue > 0 && percentileValue <= 100)) {
    throw new Error("percentile must be greater than 0 and at most 100");
  }
  const ordered = [...values].sort((a, b) => a - b);
  return ordered[Math.ceil((percentileValue / 100) * ordered.length) - 1];
}

export function scoreModelResult(result, expected) {
  if (!result || typeof result.answer !== "string") {
    throw new Error("model result answer must be a string");
  }
  if (typeof result.historySentinelSeen !== "boolean") {
    throw new Error("model result historySentinelSeen must be a boolean");
  }
  return {
    correct: result.answer === expected,
    historySentinelSeen: result.historySentinelSeen
  };
}

function summarizeLane(pairs, lane) {
  const samples = pairs.map(pair => pair[lane]);
  const wallTimes = samples.map(sample => sample.wallTimeMs);
  const inputTokens = samples.map(sample => sample.inputTokens);
  return {
    wallTimeMs: {
      p50: percentile(wallTimes, 50),
      p95: percentile(wallTimes, 95)
    },
    inputTokens: {
      p50: percentile(inputTokens, 50),
      p95: percentile(inputTokens, 95)
    },
    correctness: mean(samples.map(sample => Number(sample.correct))),
    historySentinelSeenRate: mean(samples.map(sample => Number(sample.historySentinelSeen))),
    historyPollutionTurns: samples.reduce(
      (total, sample) => total + sample.inheritedHistoryTurns,
      0
    )
  };
}

export function summarizeModelPairs(pairs) {
  if (!Array.isArray(pairs) || pairs.length < ADOPTION_THRESHOLDS.minimumCases) {
    throw new Error(`model benchmark requires at least ${ADOPTION_THRESHOLDS.minimumCases} paired cases`);
  }
  return {
    caseCount: pairs.length,
    ephemeralFork: summarizeLane(pairs, "ephemeralFork"),
    freshContext: summarizeLane(pairs, "freshContext")
  };
}

function reductionPct(candidate, baseline) {
  return Number((((baseline - candidate) / baseline) * 100).toFixed(3));
}

export function summarizeFixtureCases(cases) {
  if (!Array.isArray(cases) || cases.length < ADOPTION_THRESHOLDS.minimumCases) {
    throw new Error(`fixture benchmark requires at least ${ADOPTION_THRESHOLDS.minimumCases} cases`);
  }
  const lanes = [...new Set(cases.map(item => item.lane))].sort();
  const requiredLanes = ["read-only-review", "spec-gate", "tournament"];
  if (JSON.stringify(lanes) !== JSON.stringify(requiredLanes)) {
    throw new Error(`fixture benchmark must cover exactly ${requiredLanes.join(", ")}`);
  }
  for (const item of cases) {
    if (!item.id || !item.expected || !item.material || typeof item.material !== "object") {
      throw new Error(`fixture case is missing a required field: ${JSON.stringify(item)}`);
    }
  }
  return {
    caseCount: cases.length,
    lanes,
    ephemeralFork: {
      correctness: UNKNOWN,
      historyPollutionTurns: UNKNOWN,
      inputTokens: UNKNOWN,
      modelWallTimeMs: UNKNOWN
    },
    freshContext: {
      correctness: UNKNOWN,
      historyPollutionTurns: UNKNOWN,
      inputTokens: UNKNOWN,
      modelWallTimeMs: UNKNOWN
    }
  };
}

export async function paginateAll(fetchPage) {
  const rows = [];
  const seen = new Set();
  let cursor = null;
  do {
    const key = cursor ?? "<first-page>";
    if (seen.has(key)) throw new Error(`pagination cursor repeated: ${key}`);
    seen.add(key);
    const page = await fetchPage(cursor);
    if (!page || !Array.isArray(page.data)) throw new Error("paginated response must contain data[]");
    rows.push(...page.data);
    cursor = page.nextCursor ?? null;
  } while (cursor !== null);
  return rows;
}

export function evaluateAdoption(metrics) {
  const checks = [
    {
      name: "representative case count",
      value: metrics.caseCount,
      pass: Number.isInteger(metrics.caseCount) &&
        metrics.caseCount >= ADOPTION_THRESHOLDS.minimumCases
    },
    {
      name: "model wall-time reduction",
      value: metrics.modelWallTimeReductionPct,
      pass: metrics.modelWallTimeReductionPct !== UNKNOWN &&
        metrics.modelWallTimeReductionPct >= ADOPTION_THRESHOLDS.minimumModelWallTimeReductionPct
    },
    {
      name: "model input-token reduction",
      value: metrics.modelInputTokenReductionPct,
      pass: metrics.modelInputTokenReductionPct !== UNKNOWN &&
        metrics.modelInputTokenReductionPct >= ADOPTION_THRESHOLDS.minimumModelInputTokenReductionPct
    },
    {
      name: "fixture correctness delta",
      value: metrics.fixtureCorrectnessDelta,
      pass: metrics.fixtureCorrectnessDelta !== UNKNOWN &&
        metrics.fixtureCorrectnessDelta >= ADOPTION_THRESHOLDS.minimumCorrectnessDelta
    },
    {
      name: "history-pollution delta",
      value: metrics.historyPollutionDeltaTurns,
      pass: metrics.historyPollutionDeltaTurns !== UNKNOWN &&
        metrics.historyPollutionDeltaTurns <= ADOPTION_THRESHOLDS.maximumHistoryPollutionDeltaTurns
    },
    {
      name: "ephemeral persistence leaks",
      value: metrics.ephemeralPersistenceLeaks,
      pass: metrics.ephemeralPersistenceLeaks <= ADOPTION_THRESHOLDS.maximumEphemeralPersistenceLeaks
    }
  ];
  const failed = checks
    .filter(check => !check.pass)
    .map(check => `${check.name}: ${check.value === UNKNOWN ? "UNKNOWN (threshold cannot pass)" : check.value}`);
  return { decision: failed.length ? "REJECT" : "ADOPT", checks, failed };
}

class AppServerClient {
  constructor({ cwd }) {
    this.child = spawn("codex", ["app-server", "--stdio", "--strict-config"], {
      cwd,
      stdio: ["pipe", "pipe", "pipe"]
    });
    this.nextId = 1;
    this.pending = new Map();
    this.waiters = [];
    this.notifications = new Map();
    this.stderr = "";
    this.exited = false;
    this.child.stderr.setEncoding("utf8");
    this.child.stderr.on("data", chunk => { this.stderr += chunk; });
    const lines = createInterface({ input: this.child.stdout });
    lines.on("line", line => {
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        return;
      }
      if (message.id === undefined) {
        let matched = false;
        for (const waiter of [...this.waiters]) {
          if (waiter.method !== message.method || !waiter.predicate(message.params)) continue;
          this.waiters.splice(this.waiters.indexOf(waiter), 1);
          clearTimeout(waiter.timer);
          waiter.resolve(message.params);
          matched = true;
        }
        if (!matched) {
          const queued = this.notifications.get(message.method) ?? [];
          queued.push(message.params);
          this.notifications.set(message.method, queued.slice(-100));
        }
        return;
      }
      const pending = this.pending.get(String(message.id));
      if (!pending) return;
      this.pending.delete(String(message.id));
      if (message.error) pending.reject(new Error(`${pending.method}: ${JSON.stringify(message.error)}`));
      else pending.resolve(message.result);
    });
    const fail = error => {
      if (this.exited) return;
      this.exited = true;
      for (const pending of this.pending.values()) {
        pending.reject(error);
      }
      this.pending.clear();
      for (const waiter of this.waiters) {
        clearTimeout(waiter.timer);
        waiter.reject(error);
      }
      this.waiters = [];
    };
    this.child.on("error", error => {
      fail(new Error(`codex app-server spawn failed: ${error.message}`));
    });
    this.child.on("exit", code => {
      fail(new Error(`codex app-server exited ${code}: ${this.stderr.trim()}`));
    });
  }

  request(method, params = {}, timeoutMs = 30_000) {
    if (this.exited) return Promise.reject(new Error(`codex app-server already exited before ${method}`));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(String(id));
        reject(new Error(`timed out waiting for ${method}`));
      }, timeoutMs);
      this.pending.set(String(id), {
        method,
        resolve: value => { clearTimeout(timer); resolve(value); },
        reject: error => { clearTimeout(timer); reject(error); }
      });
      this.child.stdin.write(`${JSON.stringify({ id, method, params })}\n`, error => {
        if (!error) return;
        this.pending.delete(String(id));
        clearTimeout(timer);
        reject(error);
      });
    });
  }

  notify(method, params = {}) {
    this.child.stdin.write(`${JSON.stringify({ method, params })}\n`);
  }

  waitFor(method, predicate = () => true, timeoutMs = 60_000) {
    if (this.exited) return Promise.reject(new Error(`codex app-server already exited before ${method}`));
    const queued = this.notifications.get(method) ?? [];
    const queuedIndex = queued.findIndex(predicate);
    if (queuedIndex !== -1) {
      const [params] = queued.splice(queuedIndex, 1);
      return Promise.resolve(params);
    }
    return new Promise((resolve, reject) => {
      const waiter = { method, predicate, resolve, reject };
      waiter.timer = setTimeout(() => {
        this.waiters.splice(this.waiters.indexOf(waiter), 1);
        reject(new Error(`timed out waiting for ${method}`));
      }, timeoutMs);
      this.waiters.push(waiter);
    });
  }

  async initialize() {
    await this.request("initialize", {
      clientInfo: { name: "muster-ephemeral-fork-benchmark", version: "1.0.0" },
      capabilities: { experimentalApi: true }
    });
    this.notify("initialized");
  }

  close() {
    if (!this.exited) {
      this.child.stdin.end();
      this.child.kill("SIGTERM");
    }
  }
}

async function timed(request) {
  const started = performance.now();
  const result = await request();
  return { result, durationMs: performance.now() - started };
}

const MODEL_OUTPUT_SCHEMA = Object.freeze({
  type: "object",
  additionalProperties: false,
  required: ["answer", "historySentinelSeen"],
  properties: {
    answer: { type: "string" },
    historySentinelSeen: { type: "boolean" }
  }
});

const BENCHMARK_INSTRUCTIONS = [
  "You are a deterministic evaluator in a bounded benchmark.",
  "Do not call tools, inspect files, browse, or delegate.",
  "For spec-gate: PASS only when successCriteria is non-empty, dependencies are acyclic, and parallel ownership does not overlap; otherwise FAIL.",
  "For tournament: return FUSE when disagreement is at least 0.3; otherwise return the lexicographically first highest-total passing candidate, or ESCALATE when none passes.",
  "For read-only-review: return BLOCKED when any reviewer is exhausted; otherwise FAIL for a blocker finding and PASS for no blocker finding.",
  "Set historySentinelSeen true only when an earlier user turn in this conversation explicitly supplied a history-pollution sentinel; otherwise false.",
  "Return only the required JSON object."
].join(" ");

function modelPrompt(benchmarkCase) {
  return `Evaluate lane ${benchmarkCase.lane}. Material: ${JSON.stringify(benchmarkCase.material)}`;
}

function finalAgentMessage(turn) {
  const messages = turn?.items?.filter(item => item.type === "agentMessage") ?? [];
  const final = [...messages].reverse().find(item => item.phase === "final_answer") ?? messages.at(-1);
  if (!final?.text) throw new Error(`turn ${turn?.id ?? "unknown"} did not return an agent message`);
  try {
    return JSON.parse(final.text);
  } catch (error) {
    throw new Error(`turn ${turn?.id ?? "unknown"} returned invalid JSON: ${final.text}`, { cause: error });
  }
}

async function runModelTurn(client, { threadId, benchmarkCase, effort, timeoutMs }) {
  const completion = client.waitFor(
    "turn/completed",
    params => params?.threadId === threadId,
    timeoutMs
  );
  const started = performance.now();
  const startedTurn = await client.request("turn/start", {
    threadId,
    input: [{ type: "text", text: modelPrompt(benchmarkCase) }],
    effort,
    outputSchema: MODEL_OUTPUT_SCHEMA
  }, timeoutMs);
  const turnId = startedTurn.turn.id;
  const usage = client.waitFor(
    "thread/tokenUsage/updated",
    params => params?.threadId === threadId && params?.turnId === turnId,
    timeoutMs
  );
  const completed = await completion;
  const wallTimeMs = Number((performance.now() - started).toFixed(3));
  if (completed.turn?.status !== "completed") {
    throw new Error(`turn ${turnId} ended with status ${completed.turn?.status ?? UNKNOWN}`);
  }
  const tokenUsage = (await usage).tokenUsage?.last;
  if (!Number.isFinite(tokenUsage?.inputTokens)) {
    throw new Error(`turn ${turnId} did not expose numeric inputTokens`);
  }
  return {
    turnId,
    wallTimeMs,
    inputTokens: tokenUsage.inputTokens,
    cachedInputTokens: tokenUsage.cachedInputTokens,
    outputTokens: tokenUsage.outputTokens,
    modelResult: finalAgentMessage(completed.turn)
  };
}

export async function probeAppServer({ cases, cwd, model, effort = "low", turnTimeoutMs = 120_000 }) {
  const probeCwd = mkdtempSync(join(cwd, ".muster-ephemeral-fork-benchmark-"));
  let client;
  const persistentIds = [];
  const ephemeralIds = [];
  try {
    client = new AppServerClient({ cwd });
    await client.initialize();
    const modelCatalog = await paginateAll(cursor => client.request("model/list", {
      cursor,
      limit: 100,
      includeHidden: false
    }));
    const selectedModel = model
      ? modelCatalog.find(candidate => candidate.id === model || candidate.model === model)
      : modelCatalog.find(candidate => candidate.isDefault);
    if (!selectedModel) {
      throw new Error(model
        ? `requested model ${model} was not present in model/list`
        : "model/list did not expose a default model");
    }
    const resolvedModel = selectedModel.model;
    const parent = await client.request("thread/start", {
      cwd: probeCwd,
      ephemeral: false,
      model: resolvedModel,
      baseInstructions: BENCHMARK_INSTRUCTIONS,
      developerInstructions: BENCHMARK_INSTRUCTIONS,
      approvalPolicy: "never",
      sandbox: "read-only"
    });
    persistentIds.push(parent.thread.id);
    const completion = client.waitFor(
      "turn/completed",
      params => params?.threadId === parent.thread.id
    );
    const [, seedTurn] = await Promise.all([
      client.request("turn/start", {
        threadId: parent.thread.id,
        input: [{
          type: "text",
          text: "History-pollution sentinel supplied by an earlier user turn: MUSTER_FORK_SENTINEL_7F3A. Reply with exactly SEED."
        }],
        effort
      }),
      completion
    ]);

    const sentinel = await client.request("thread/fork", {
      threadId: parent.thread.id,
      ephemeral: false,
      excludeTurns: true,
      approvalPolicy: "never",
      sandbox: "read-only"
    });
    persistentIds.push(sentinel.thread.id);

    const pairs = [];
    for (const [index, benchmarkCase] of cases.entries()) {
      const fork = await timed(() => client.request("thread/fork", {
        threadId: parent.thread.id,
        ephemeral: true,
        excludeTurns: false,
        model: resolvedModel,
        developerInstructions: BENCHMARK_INSTRUCTIONS,
        approvalPolicy: "never",
        sandbox: "read-only"
      }));
      ephemeralIds.push(fork.result.thread.id);

      const fresh = await timed(() => client.request("thread/start", {
        cwd: probeCwd,
        ephemeral: true,
        model: resolvedModel,
        baseInstructions: BENCHMARK_INSTRUCTIONS,
        developerInstructions: BENCHMARK_INSTRUCTIONS,
        approvalPolicy: "never",
        sandbox: "read-only"
      }));
      ephemeralIds.push(fresh.result.thread.id);

      const runFork = () => runModelTurn(client, {
        threadId: fork.result.thread.id,
        benchmarkCase,
        effort,
        timeoutMs: turnTimeoutMs
      });
      const runFresh = () => runModelTurn(client, {
        threadId: fresh.result.thread.id,
        benchmarkCase,
        effort,
        timeoutMs: turnTimeoutMs
      });
      const first = index % 2 === 0 ? await runFork() : await runFresh();
      const second = index % 2 === 0 ? await runFresh() : await runFork();
      const forkTurn = index % 2 === 0 ? first : second;
      const freshTurn = index % 2 === 0 ? second : first;
      pairs.push({
        id: benchmarkCase.id,
        lane: benchmarkCase.lane,
        expected: benchmarkCase.expected,
        order: index % 2 === 0 ? ["ephemeralFork", "freshContext"] : ["freshContext", "ephemeralFork"],
        ephemeralFork: {
          controlPlaneWallTimeMs: Number(fork.durationMs.toFixed(3)),
          inheritedHistoryTurns: fork.result.thread.turns.length,
          ...forkTurn,
          ...scoreModelResult(forkTurn.modelResult, benchmarkCase.expected)
        },
        freshContext: {
          controlPlaneWallTimeMs: Number(fresh.durationMs.toFixed(3)),
          inheritedHistoryTurns: fresh.result.thread.turns.length,
          ...freshTurn,
          ...scoreModelResult(freshTurn.modelResult, benchmarkCase.expected)
        }
      });
    }

    let pageCount = 0;
    const listed = await paginateAll(async cursor => {
      pageCount++;
      return client.request("thread/list", {
        cwd: probeCwd,
        limit: 1,
        cursor,
        sortKey: "created_at",
        sortDirection: "asc"
      });
    });
    const listedIds = new Set(listed.map(thread => thread.id));
    const persistentThreadsFound = persistentIds.filter(id => listedIds.has(id)).length;
    if (persistentThreadsFound !== persistentIds.length) {
      throw new Error(
        `paginated thread/list omitted persistent sentinels: found ${persistentThreadsFound}/${persistentIds.length}`
      );
    }
    const leaks = ephemeralIds.filter(id => listedIds.has(id));
    return {
      status: "MEASURED",
      codexVersion: execFileSync("codex", ["--version"], { encoding: "utf8" }).trim(),
      requestedModel: model ?? null,
      model: resolvedModel,
      modelCatalogId: selectedModel.id,
      modelWasCatalogDefault: selectedModel.isDefault,
      modelProvider: parent.thread.modelProvider,
      effort,
      turnTimeoutMs,
      seedTurn: {
        status: seedTurn.turn?.status ?? UNKNOWN,
        turnId: seedTurn.turn?.id ?? UNKNOWN
      },
      pairs,
      summary: summarizeModelPairs(pairs),
      pagination: {
        pageSize: 1,
        pagesRead: pageCount,
        persistentThreadsFound,
        exhausted: true
      },
      ephemeralPersistenceLeaks: leaks.length
    };
  } finally {
    try {
      const cleanupErrors = [];
      for (const threadId of ephemeralIds) {
        try {
          await client?.request("thread/delete", { threadId }, 2_000);
        } catch (error) {
          if (!/no rollout found|not found|thread is not persisted and cannot be deleted/i.test(
            error instanceof Error ? error.message : String(error)
          )) {
            cleanupErrors.push(error);
          }
        }
      }
      for (const threadId of [...persistentIds].reverse()) {
        try {
          await client?.request("thread/delete", { threadId }, 2_000);
        } catch (error) {
          cleanupErrors.push(error);
        }
      }
      if (cleanupErrors.length) {
        const details = cleanupErrors
          .map(error => error instanceof Error ? error.message : String(error))
          .join("; ");
        throw new AggregateError(cleanupErrors, `app-server benchmark cleanup failed: ${details}`);
      }
    } finally {
      client?.close();
      rmSync(probeCwd, { recursive: true, force: true });
    }
  }
}

export async function runBenchmark({
  fixturePath = DEFAULT_FIXTURE,
  cwd = join(HERE, ".."),
  model,
  effort = "low",
  turnTimeoutMs = 120_000
} = {}) {
  const cases = JSON.parse(await readFile(fixturePath, "utf8"));
  const fixture = summarizeFixtureCases(cases);
  const modelWork = await probeAppServer({ cases, cwd, model, effort, turnTimeoutMs });
  const summary = modelWork.summary;
  const metrics = {
    caseCount: fixture.caseCount,
    fixtureCorrectnessDelta: Number((
      summary.ephemeralFork.correctness - summary.freshContext.correctness
    ).toFixed(3)),
    historyPollutionDeltaTurns:
      summary.ephemeralFork.historyPollutionTurns - summary.freshContext.historyPollutionTurns,
    modelWallTimeReductionPct: reductionPct(
      summary.ephemeralFork.wallTimeMs.p50,
      summary.freshContext.wallTimeMs.p50
    ),
    modelInputTokenReductionPct: reductionPct(
      summary.ephemeralFork.inputTokens.p50,
      summary.freshContext.inputTokens.p50
    ),
    ephemeralPersistenceLeaks: modelWork.ephemeralPersistenceLeaks
  };
  const adoption = evaluateAdoption(metrics);
  return {
    schema: "muster-codex-ephemeral-fork-benchmark/v2",
    generatedAt: new Date().toISOString(),
    protocol: {
      caseSource: "deterministic case definitions",
      seedModelTurnsExecuted: 1,
      representativeModelTurnsExecuted: cases.length * 2,
      scoring: "exact answer equality against fixture expected values",
      historyPollution: "returned inherited turns plus model-reported visibility of an earlier user-turn sentinel",
      comparison: "Codex app-server ephemeral thread/fork versus ephemeral thread/start, each executing the same model case",
      pairOrder: "alternating by case to reduce order bias"
    },
    fixture,
    modelWork,
    metrics,
    thresholds: ADOPTION_THRESHOLDS,
    adoption,
    productionDependencyAdded: false
  };
}

async function main() {
  const args = process.argv.slice(2);
  const valueAfter = flag => {
    const index = args.indexOf(flag);
    return index === -1 ? undefined : args[index + 1];
  };
  const result = await runBenchmark({
    fixturePath: valueAfter("--fixture") ?? DEFAULT_FIXTURE,
    cwd: valueAfter("--cwd") ?? join(HERE, ".."),
    model: valueAfter("--model"),
    effort: valueAfter("--effort") ?? "low",
    turnTimeoutMs: Number(valueAfter("--turn-timeout-ms") ?? 120_000)
  });
  const output = `${JSON.stringify(result, null, 2)}\n`;
  const out = valueAfter("--out");
  if (out) await writeFile(out, output);
  else process.stdout.write(output);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch(error => {
    process.stderr.write(`${error.stack ?? error}\n`);
    process.exitCode = 1;
  });
}
