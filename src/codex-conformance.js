import { readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";

// Codex subagent model-conformance audit: proves (from Codex's own rollout
// JSONL, the only ground truth -- Codex exposes no per-agent model/token
// telemetry) that each spawned subagent thread ran on the model its muster
// profile TOML pins, rather than inheriting the orchestrator's model through a
// generic spawn. Joins, per rollout file under <sessionsDir>/<day>/:
//   session_meta.source.subagent.thread_spawn.agent_role  (who it claims to be)
//   x turn_context.model per turn                          (what it actually ran)
//   x <agentsDir>/<agent_role>.toml `model =` pin          (what it should run)
// Verdicts: MATCH / MISMATCH / GENERIC (a subagent with no agent_role -- the
// inherited-parent-model failure mode) / NO-PIN (role has no profile TOML).
// MATCH is ambiguous when a pin equals the orchestrator's model (inheritance
// would look identical); MISMATCH and GENERIC are the reliable signals --
// see docs/research/codex-cli.md sec 6 and the 2026-07-18 dogfood.

export const CONFORMANCE_VERDICTS = Object.freeze({
  MATCH: "MATCH",
  MISMATCH: "MISMATCH",
  GENERIC: "GENERIC",
  NO_PIN: "NO-PIN",
  IDLE: "IDLE"
});

export const MAX_CONFORMANCE_DAYS = 3660;

// Also returns the NEWEST profile-TOML mtime in agentsDir (across every
// .toml file present, not just parseable ones) -- the pre-retier annotation
// below compares this against each MISMATCH row's rollout file mtime.
async function pinnedModels(agentsDir) {
  const pins = new Map();
  let names = [];
  try { names = await readdir(agentsDir); } catch { return { pins, newestMtimeMs: null }; }
  let newestMtimeMs = null;
  for (const name of names) {
    if (!name.endsWith(".toml")) continue;
    const path = join(agentsDir, name);
    try {
      const stats = await stat(path);
      if (newestMtimeMs === null || stats.mtimeMs > newestMtimeMs) newestMtimeMs = stats.mtimeMs;
    } catch { continue; }
    let text;
    try { text = await readFile(path, "utf8"); } catch { continue; }
    const model = text.match(/^model\s*=\s*"([^"]+)"/m)?.[1];
    const effort = text.match(/^model_reasoning_effort\s*=\s*"([^"]+)"/m)?.[1] || null;
    if (model) pins.set(name.replace(/\.toml$/, ""), { model, effort });
  }
  return { pins, newestMtimeMs };
}

function classifyThread({ meta, turnModels }, pins) {
  const spawn = meta.source?.subagent?.thread_spawn;
  const kind = meta.thread_source === "subagent" ? "subagent" : "user";
  const observed = [...turnModels.keys()];
  if (kind !== "subagent") return { kind, role: null, verdict: null, observed };
  if (!spawn?.agent_role) return { kind, role: null, verdict: CONFORMANCE_VERDICTS.GENERIC, observed };
  const expected = pins.get(spawn.agent_role);
  if (!expected) return { kind, role: spawn.agent_role, verdict: CONFORMANCE_VERDICTS.NO_PIN, observed };
  if (observed.length === 0) return { kind, role: spawn.agent_role, verdict: CONFORMANCE_VERDICTS.IDLE, observed, expected };
  // Both halves must hold: the pinned MODEL and, when the profile pins one,
  // the pinned reasoning EFFORT -- Codex's spawn-inheritance bug class
  // (openai/codex#32587) silently bills children at the parent's model AND
  // effort, and an effort-only drift (sol/medium pin running sol/high) still
  // multiplies quota burn ~1.9x. A turn whose rollout carries NO effort
  // telemetry (keyEffort null) is deliberately fail-open on the effort half:
  // absent telemetry proves nothing either way, and failing on it would turn
  // every telemetry gap into a false alarm -- but a turn with a PRESENT wrong
  // effort always fails, regardless of other turns lacking telemetry.
  const modelOk = observed.every(key => keyModel(key) === expected.model);
  const effortOk = !expected.effort || observed.every(key => keyEffort(key) === null || keyEffort(key) === expected.effort);
  const verdict = modelOk && effortOk ? CONFORMANCE_VERDICTS.MATCH : CONFORMANCE_VERDICTS.MISMATCH;
  return { kind, role: spawn.agent_role, verdict, observed, expected };
}

// turnModels keys are JSON-encoded [model, effort|null] tuples -- delimiter-safe
// against any model/effort string Codex might emit (payload values are
// unconstrained external input; a naive "model@effort" split would misparse a
// model name containing "@").
const encodeKey = (model, effort) => JSON.stringify([model, effort ?? null]);
const keyModel = key => JSON.parse(key)[0];
const keyEffort = key => JSON.parse(key)[1];

function parseRollout(text) {
  let meta = null;
  const turnModels = new Map();
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let entry;
    try { entry = JSON.parse(trimmed); } catch { continue; }
    const payload = entry.payload || {};
    if (!meta && (payload.thread_source || payload.session_id)) meta = payload;
    const type = payload.type || entry.type;
    if (type === "turn_context" && typeof payload.model === "string") {
      const effort = payload.collaboration_mode?.settings?.reasoning_effort ?? payload.effort ?? null;
      const key = encodeKey(payload.model, effort);
      turnModels.set(key, (turnModels.get(key) || 0) + 1);
    }
  }
  return meta ? { meta, turnModels } : null;
}

// day is "YYYY/MM/DD" (the sessions tree layout); days (mutually exclusive
// with day, a positive integer) instead scans the last N UTC day directories
// ending today, skipping absent days silently, aggregating rows and the tally
// across the range with each row stamped with its source day. cwdFilter, when
// set, keeps only threads whose recorded cwd contains the substring -- scoping
// the audit to one project's sessions on a shared CODEX_HOME.
export async function auditCodexModelConformance({ sessionsDir, agentsDir, day, days, cwdFilter = null } = {}) {
  if (!sessionsDir || !agentsDir || (!day && days === undefined)) {
    throw new Error("auditCodexModelConformance: sessionsDir, agentsDir, and day (YYYY/MM/DD) or days are required");
  }
  if (day && days !== undefined) {
    throw new Error("auditCodexModelConformance: day and days cannot be combined");
  }
  if (days !== undefined && (!Number.isSafeInteger(days) || days < 1 || days > MAX_CONFORMANCE_DAYS)) {
    throw new Error(`auditCodexModelConformance: days must be an integer between 1 and ${MAX_CONFORMANCE_DAYS}`);
  }
  const { pins, newestMtimeMs } = await pinnedModels(agentsDir);
  if (!days) return auditDay({ sessionsDir, day, cwdFilter, pins, newestMtimeMs });

  const rows = [];
  const tally = emptyTally();
  const range = utcDays(days);
  for (const sourceDay of range) {
    const report = await auditDay({ sessionsDir, day: sourceDay, cwdFilter, pins, newestMtimeMs });
    rows.push(...report.rows.map(row => ({ ...row, day: sourceDay })));
    addTally(tally, report.tally);
  }
  return { days, rows, tally, pins: pins.size };
}

async function auditDay({ sessionsDir, day, cwdFilter, pins, newestMtimeMs }) {
  const dir = join(sessionsDir, day);
  let names;
  try { names = (await readdir(dir)).filter(name => name.endsWith(".jsonl")).sort(); }
  catch (error) {
    if (error?.code === "ENOENT") return { day, rows: [], tally: emptyTally(), pins: pins.size };
    throw error;
  }
  const rows = [];
  for (const name of names) {
    const filePath = join(dir, name);
    let parsed, rolloutMtimeMs = null;
    try {
      const [content, stats] = await Promise.all([readFile(filePath, "utf8"), stat(filePath)]);
      parsed = parseRollout(content);
      rolloutMtimeMs = stats.mtimeMs;
    } catch { continue; }
    if (!parsed) continue;
    if (cwdFilter && !(parsed.meta.cwd || "").includes(cwdFilter)) continue;
    const spawn = parsed.meta.source?.subagent?.thread_spawn;
    const classified = classifyThread(parsed, pins);
    const row = {
      file: name,
      kind: classified.kind,
      role: classified.role,
      nickname: spawn?.agent_nickname || null,
      depth: spawn?.depth ?? null,
      observed: [...parsed.turnModels.entries()].map(([key, turns]) => ({ model: keyModel(key), effort: keyEffort(key), turns })),
      expected: classified.expected || null,
      verdict: classified.verdict
    };
    // Pre-retier annotation: a range crossing a profile retier legitimately
    // contains historical MISMATCH rows -- the rollout ran under the OLD
    // pins, but every verdict above compares against the CURRENT ones. When
    // the newest profile TOML postdates this rollout, the mismatch reflects
    // a retier, not a live drift; --current-pins-only (src/cli.js) uses this
    // to decide the exit code without ever hiding the row itself.
    if (classified.verdict === CONFORMANCE_VERDICTS.MISMATCH) {
      row.pinsNewerThanRollout = newestMtimeMs !== null && rolloutMtimeMs !== null && newestMtimeMs > rolloutMtimeMs;
    }
    rows.push(row);
  }
  const tally = emptyTally();
  for (const row of rows) {
    if (row.kind !== "subagent") continue;
    tally.subagents += 1;
    if (row.verdict === CONFORMANCE_VERDICTS.MATCH) tally.match += 1;
    else if (row.verdict === CONFORMANCE_VERDICTS.MISMATCH) {
      tally.mismatch += 1;
      if (row.pinsNewerThanRollout) tally.prePinMismatch += 1;
    }
    else if (row.verdict === CONFORMANCE_VERDICTS.GENERIC) tally.generic += 1;
    else if (row.verdict === CONFORMANCE_VERDICTS.NO_PIN) tally.noPin += 1;
    else tally.idle += 1;
  }
  return { day, rows, tally, pins: pins.size };
}

function utcDays(count, anchor = new Date()) {
  const midnight = Date.UTC(anchor.getUTCFullYear(), anchor.getUTCMonth(), anchor.getUTCDate());
  return Array.from({ length: count }, (_, offset) =>
    new Date(midnight - offset * 86_400_000).toISOString().slice(0, 10).replaceAll("-", "/")
  );
}

function addTally(target, source) {
  for (const key of Object.keys(target)) target[key] += source[key];
}

function emptyTally() {
  return { subagents: 0, match: 0, mismatch: 0, generic: 0, noPin: 0, idle: 0, prePinMismatch: 0 };
}
