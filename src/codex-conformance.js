import { readFile, readdir } from "node:fs/promises";
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

async function pinnedModels(agentsDir) {
  const pins = new Map();
  let names = [];
  try { names = await readdir(agentsDir); } catch { return pins; }
  for (const name of names) {
    if (!name.endsWith(".toml")) continue;
    let text;
    try { text = await readFile(join(agentsDir, name), "utf8"); } catch { continue; }
    const model = text.match(/^model\s*=\s*"([^"]+)"/m)?.[1];
    const effort = text.match(/^model_reasoning_effort\s*=\s*"([^"]+)"/m)?.[1] || null;
    if (model) pins.set(name.replace(/\.toml$/, ""), { model, effort });
  }
  return pins;
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
  // multiplies quota burn ~1.9x.
  const modelOk = observed.every(key => keyModel(key) === expected.model);
  const effortOk = !expected.effort || observed.every(key => keyEffort(key) === null || keyEffort(key) === expected.effort);
  const verdict = modelOk && effortOk ? CONFORMANCE_VERDICTS.MATCH : CONFORMANCE_VERDICTS.MISMATCH;
  return { kind, role: spawn.agent_role, verdict, observed, expected };
}

// turnModels keys are "model@effort" ("@?" when the rollout carried no effort).
const keyModel = key => key.split("@")[0];
const keyEffort = key => { const effort = key.split("@")[1]; return effort === "?" ? null : effort; };

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
      const effort = payload.collaboration_mode?.settings?.reasoning_effort ?? payload.effort ?? "?";
      const key = `${payload.model}@${effort}`;
      turnModels.set(key, (turnModels.get(key) || 0) + 1);
    }
  }
  return meta ? { meta, turnModels } : null;
}

// day is "YYYY/MM/DD" (the sessions tree layout). cwdFilter, when set, keeps
// only threads whose recorded cwd contains the substring -- scoping the audit
// to one project's sessions on a shared CODEX_HOME.
export async function auditCodexModelConformance({ sessionsDir, agentsDir, day, cwdFilter = null } = {}) {
  if (!sessionsDir || !agentsDir || !day) {
    throw new Error("auditCodexModelConformance: sessionsDir, agentsDir, and day (YYYY/MM/DD) are required");
  }
  const pins = await pinnedModels(agentsDir);
  const dir = join(sessionsDir, day);
  let names;
  try { names = (await readdir(dir)).filter(name => name.endsWith(".jsonl")).sort(); }
  catch (error) {
    if (error?.code === "ENOENT") return { day, rows: [], tally: emptyTally(), pins: pins.size };
    throw error;
  }
  const rows = [];
  for (const name of names) {
    let parsed;
    try { parsed = parseRollout(await readFile(join(dir, name), "utf8")); } catch { continue; }
    if (!parsed) continue;
    if (cwdFilter && !(parsed.meta.cwd || "").includes(cwdFilter)) continue;
    const spawn = parsed.meta.source?.subagent?.thread_spawn;
    const classified = classifyThread(parsed, pins);
    rows.push({
      file: name,
      kind: classified.kind,
      role: classified.role,
      nickname: spawn?.agent_nickname || null,
      depth: spawn?.depth ?? null,
      observed: [...parsed.turnModels.entries()].map(([key, turns]) => ({ model: keyModel(key), effort: keyEffort(key), turns })),
      expected: classified.expected || null,
      verdict: classified.verdict
    });
  }
  const tally = emptyTally();
  for (const row of rows) {
    if (row.kind !== "subagent") continue;
    tally.subagents += 1;
    if (row.verdict === CONFORMANCE_VERDICTS.MATCH) tally.match += 1;
    else if (row.verdict === CONFORMANCE_VERDICTS.MISMATCH) tally.mismatch += 1;
    else if (row.verdict === CONFORMANCE_VERDICTS.GENERIC) tally.generic += 1;
    else if (row.verdict === CONFORMANCE_VERDICTS.NO_PIN) tally.noPin += 1;
    else tally.idle += 1;
  }
  return { day, rows, tally, pins: pins.size };
}

function emptyTally() {
  return { subagents: 0, match: 0, mismatch: 0, generic: 0, noPin: 0, idle: 0 };
}
