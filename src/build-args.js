// `muster build-args <runId> [--base <sha>]`: derive the exact `muster:build` Workflow args
// from the run's approved PLAN.md (docs/strategy/stage-2-contracts.md, amendment 1). The main
// thread commits the written file before building; merge-wave trusts only that committed copy
// for merge order, titles and the verify commands it re-runs. Deterministic: one Bash call
// instead of the model hand-copying tasks out of PLAN.md.
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { decodeEntityAmps, parsePlan } from "./plan-lint.js";
import { runDir } from "./run-dir.js";
import { writeContainedFile } from "./fs-safe.js";
import { agentTypeFor, specialistCatalog } from "./specialists.js";
import { pinApplies, resolvePins, taskRoles } from "./skill-pins.js";

const AUTOMATED_RE = /<automated[^>]{0,200}>([\s\S]*?)<\/automated>/g;

function verifyCommands(verifyBody) {
  const out = [];
  for (const m of String(verifyBody || "").matchAll(AUTOMATED_RE)) {
    const cmd = decodeEntityAmps(m[1]).trim();
    if (cmd && !/^MISSING(?:\s|$)/.test(cmd)) out.push(cmd);
  }
  return out;
}

// Pure: PLAN.md text -> { args, humanNeeded, problems }. Checkpoint tasks are human stops,
// never executor work, so they are listed in humanNeeded instead of a wave.
// A task's agent_hint becomes `agentType` only when it names a dispatchable plugin agent
// (build.js otherwise runs muster-executor with the hint as a domain lens); its `skills`
// become [{id, path}] with the absolute SKILL.md path the executor reads before working.
// `pins` ([{id, role?, path}], src/skill-pins.js) are the project's pinned skills: each is
// appended to every task it applies to (all tasks, or the tasks carrying its role).
export function buildArgsFromPlan(planText, { runId, base = null, branch = null, models = null, catalog = specialistCatalog(), pins = [] } = {}) {
  const plan = parsePlan(planText);
  const problems = [];
  const humanNeeded = [];
  const byWave = new Map();
  const seen = new Set();
  for (const t of plan.tasks) {
    if (!t.id) { problems.push(`task #${t.index} has no id`); continue; }
    if (seen.has(t.id)) { problems.push(`task ${t.id} appears twice`); continue; }
    seen.add(t.id);
    if (t.kind === "checkpoint") { humanNeeded.push({ taskId: t.id, type: t.type, title: t.name || "" }); continue; }
    if (t.wave === null) { problems.push(`task ${t.id} has no numeric wave`); continue; }
    const task = { taskId: t.id, title: t.name || "", files: t.files, verify: verifyCommands(t.verifyBody) };
    if (t.agentHint) {
      task.agentHint = t.agentHint;
      const agentType = agentTypeFor(t.agentHint, catalog);
      if (agentType) task.agentType = agentType;
    }
    if (t.skills.length) {
      const unknown = t.skills.filter((id) => !catalog.skills.has(id));
      if (unknown.length) problems.push(`task ${t.id} binds unknown skill(s): ${unknown.join(", ")}`);
      task.skills = t.skills.filter((id) => catalog.skills.has(id)).map((id) => ({ id, path: catalog.skills.get(id).path }));
    }
    // tdd="true" or type="tdd" selects muster:team's test-first split (muster-test-writer, then
    // the builder); muster:build ignores the flag.
    if (t.tdd === "true" || t.type === "tdd") task.tdd = true;
    if (pins.length) {
      const roles = taskRoles(t, catalog);
      const add = pins.filter((p) => pinApplies(p, roles) && !(task.skills || []).some((k) => k.id === p.id));
      if (add.length) {
        task.skills = [...(task.skills || []), ...add.map((p) => ({ id: p.id, path: p.path }))];
        task.pinned = add.map((p) => p.id);
      }
    }
    if (!task.verify.length) problems.push(`task ${t.id} has no <automated> verify command`);
    if (!byWave.has(t.wave)) byWave.set(t.wave, []);
    byWave.get(t.wave).push(task);
  }
  const waves = [...byWave.keys()].sort((a, b) => a - b).map((w) => byWave.get(w));
  if (!waves.length) problems.push("PLAN.md has no buildable tasks");
  const args = { runId, ...(base ? { base } : {}), ...(branch ? { branch } : {}), ...(models ? { models } : {}), waves };
  return { args, humanNeeded, problems };
}

async function readJsonOrNull(path) {
  try { return JSON.parse(await readFile(path, "utf8")); } catch { return null; }
}

// Reads PLAN.md (and the seat models preflight computed), writes build-args.json, returns a
// compact report. ok:false leaves no file behind.
export async function writeBuildArgs({ cwd, runId, base = null, branch = null }) {
  const dir = runDir(cwd, runId);
  let planText;
  try { planText = await readFile(join(dir, "PLAN.md"), "utf8"); } catch {
    return { ok: false, runId, problems: [`.muster/runs/${runId}/PLAN.md not found`] };
  }
  const models = (await readJsonOrNull(join(dir, "preflight.json")))?.models || null;
  const catalog = specialistCatalog();
  let pinned = { pins: [], warnings: [] };
  try { pinned = resolvePins(cwd, catalog); } catch (e) { pinned.warnings.push(e.message); }
  const { args, humanNeeded, problems } = buildArgsFromPlan(planText, { runId, base, branch, models, catalog, pins: pinned.pins });
  const rel = `.muster/runs/${runId}/build-args.json`;
  if (problems.length) return { ok: false, runId, problems, humanNeeded };
  await writeContainedFile(cwd, join(dir, "build-args.json"), JSON.stringify(args, null, 2) + "\n");
  return {
    ok: true, runId, path: rel, base: args.base || null,
    waves: args.waves.map((w) => w.map((t) => t.taskId)),
    humanNeeded,
    ...(pinned.pins.length ? { pinned: args.waves.flat().filter((t) => t.pinned).map((t) => `${t.taskId}: ${t.pinned.join(", ")}`) } : {}),
    ...(pinned.warnings.length ? { warnings: pinned.warnings } : {}),
  };
}
