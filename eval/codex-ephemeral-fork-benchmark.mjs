#!/usr/bin/env node
import { spawn, execFileSync } from "node:child_process";
import { createInterface } from "node:readline";
import { readFile, writeFile } from "node:fs/promises";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
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
        for (const waiter of [...this.waiters]) {
          if (waiter.method !== message.method || !waiter.predicate(message.params)) continue;
          this.waiters.splice(this.waiters.indexOf(waiter), 1);
          clearTimeout(waiter.timer);
          waiter.resolve(message.params);
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

export async function probeAppServer({ cases, cwd }) {
  const probeCwd = mkdtempSync(join(tmpdir(), "muster-ephemeral-fork-benchmark-"));
  let client;
  const persistentIds = [];
  const ephemeralIds = [];
  try {
    client = new AppServerClient({ cwd });
    await client.initialize();
    const parent = await client.request("thread/start", {
      cwd: probeCwd,
      ephemeral: false,
      approvalPolicy: "never",
      sandbox: "read-only"
    });
    persistentIds.push(parent.thread.id);
    const completion = client.waitFor(
      "turn/completed",
      params => params?.threadId === parent.thread.id
    );
    await client.request("turn/start", {
      threadId: parent.thread.id,
      input: [{ type: "text", text: "Reply with exactly OK." }],
      effort: "low"
    });
    const seedTurn = await completion;

    const sentinel = await client.request("thread/fork", {
      threadId: parent.thread.id,
      ephemeral: false,
      excludeTurns: true,
      approvalPolicy: "never",
      sandbox: "read-only"
    });
    persistentIds.push(sentinel.thread.id);

    const forkDurations = [];
    const freshDurations = [];
    for (const benchmarkCase of cases) {
      const caseInstructions =
        `Control-plane-only benchmark case ${benchmarkCase.id}: ${JSON.stringify(benchmarkCase.material)}`;
      const fork = await timed(() => client.request("thread/fork", {
        threadId: parent.thread.id,
        ephemeral: true,
        excludeTurns: true,
        developerInstructions: caseInstructions,
        approvalPolicy: "never",
        sandbox: "read-only"
      }));
      forkDurations.push(fork.durationMs);
      ephemeralIds.push(fork.result.thread.id);

      const fresh = await timed(() => client.request("thread/start", {
        cwd: probeCwd,
        ephemeral: true,
        developerInstructions: caseInstructions,
        approvalPolicy: "never",
        sandbox: "read-only"
      }));
      freshDurations.push(fresh.durationMs);
      ephemeralIds.push(fresh.result.thread.id);
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
      seedTurn: {
        status: seedTurn.turn?.status ?? UNKNOWN,
        usage: seedTurn.turn?.usage ?? UNKNOWN
      },
      forkControlPlaneWallTimeMs: {
        samples: forkDurations.map(value => Number(value.toFixed(3))),
        mean: Number(mean(forkDurations).toFixed(3))
      },
      freshControlPlaneWallTimeMs: {
        samples: freshDurations.map(value => Number(value.toFixed(3))),
        mean: Number(mean(freshDurations).toFixed(3))
      },
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
      for (const threadId of [...ephemeralIds, ...persistentIds]) {
        try {
          await client?.request("thread/delete", { threadId }, 2_000);
        } catch {
          // Ephemeral threads have no rollout to delete; cleanup is best effort.
        }
      }
    } finally {
      client?.close();
      rmSync(probeCwd, { recursive: true, force: true });
    }
  }
}

export async function runBenchmark({ fixturePath = DEFAULT_FIXTURE, cwd = join(HERE, "..") } = {}) {
  const cases = JSON.parse(await readFile(fixturePath, "utf8"));
  const fixture = summarizeFixtureCases(cases);
  let controlPlane;
  try {
    controlPlane = await probeAppServer({ cases, cwd });
  } catch (error) {
    controlPlane = {
      status: UNKNOWN,
      reason: error instanceof Error ? error.message : String(error),
      forkControlPlaneWallTimeMs: UNKNOWN,
      freshControlPlaneWallTimeMs: UNKNOWN,
      pagination: UNKNOWN,
      ephemeralPersistenceLeaks: UNKNOWN
    };
  }
  const metrics = {
    caseCount: fixture.caseCount,
    fixtureCorrectnessDelta: UNKNOWN,
    historyPollutionDeltaTurns: UNKNOWN,
    modelWallTimeReductionPct: UNKNOWN,
    modelInputTokenReductionPct: UNKNOWN,
    ephemeralPersistenceLeaks: controlPlane.ephemeralPersistenceLeaks
  };
  const adoption = evaluateAdoption(metrics);
  return {
    schema: "muster-codex-ephemeral-fork-benchmark/v1",
    generatedAt: new Date().toISOString(),
    protocol: {
      caseSource: "deterministic case definitions",
      seedModelTurnsExecuted: 1,
      representativeModelTurnsExecuted: 0,
      fixtureCorrectnessIsNotModelCorrectness: true,
      unmeasuredRepresentativeMetrics: [
        "modelWallTimeReductionPct",
        "modelInputTokenReductionPct",
        "correctnessDelta",
        "historyPollutionDeltaTurns"
      ],
      comparison: "Codex app-server ephemeral thread/fork versus ephemeral thread/start control-plane calls"
    },
    fixture,
    controlPlane,
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
    cwd: valueAfter("--cwd") ?? join(HERE, "..")
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
