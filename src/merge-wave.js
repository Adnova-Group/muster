// `muster merge-wave <runId> --result <build-result.json>` (docs/strategy/stage-2-contracts.md).
//
// Workflow verdicts are evidence, not truth, and the build result is agent output, so it is
// never trusted to say what to run or what to delete:
// - Merge order, titles and the commands re-run after each merge come from the approved build
//   args, committed at HEAD as .muster/runs/<id>/build-args.json (the exact args the main
//   thread passed to muster:build). Agent-reported testsRun is compared, never executed.
// - Before a wave merges, every claimed commit in it must exist, sit at the tip of its branch,
//   and be the sha the reviewer passed. The workflow scripts cannot run git, so this is the
//   only place a claimed commit is proven to exist. A wave that fails stops the merge there:
//   the earlier waves stay merged (see mergeWave for which checks refuse everything instead).
// - No task branch may change the run's committed inputs (CONTEXT.md, PLAN.md,
//   build-args.json). Plan rules keep .muster/ out of the builders' diff and change-set gates,
//   so without this a builder could rewrite its own plan unnoticed. SUMMARY files are not
//   inputs: merge-wave writes them, and a branch may bring its own.
// - Neither may the main thread change them after `muster build-args` ran: build-args records
//   digests of PLAN.md and of its own args, and both must still match at HEAD (the first live
//   run hand-edited the committed PLAN.md and build-args.json, base included, and re-ran
//   merge-wave). The build result echoes the args digest it ran with, so args regenerated after
//   the build are refused too. The legitimate path after a re-plan is build-args, then the build.
// - A worktree is removed only when it is under <root>/.claude/worktrees/, has the merged
//   task branch checked out, and is clean; branches are deleted with `branch -d` only.
// Any mismatch rolls HEAD back to the last fully merged wave, records merge-refusal.json for
// `next --run`, and the CLI exits non-zero.
import { spawnSync } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { MERGE_REFUSAL, appendStateLog, assertRunId, ensureRunDir, mergeInputs } from "./run-dir.js";
import { createContainedFile, inspectContainedPath, writeContainedFile } from "./fs-safe.js";
import { argsDigest, planDigest } from "./build-args.js";

const VERIFY_TIMEOUT_MS = 10 * 60 * 1000;

function git(cwd, args) {
  const r = spawnSync("git", args, { cwd, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  return { ok: r.status === 0, out: (r.stdout || "").trim(), err: (r.stderr || "").trim() };
}

const short = (sha) => String(sha || "").slice(0, 10);
const tail = (s, n = 600) => (s.length > n ? `...${s.slice(-n)}` : s);
const list = (xs) => (Array.isArray(xs) ? xs : xs ? [xs] : []).map((c) => String(c).trim()).filter(Boolean);
const realOrNull = (p) => { try { return realpathSync(p); } catch { return null; } };

export function isClaudeWorktree(path) {
  return `${path}${sep}`.includes(`${sep}.claude${sep}worktrees${sep}`);
}

// A build result is either build.js's `{runId, tasks}` or backlog.js's `{items:[...]}`, or the
// Workflow tool's envelope around one (`{summary, agentCount, logs, result}`), which is what the
// main thread saw in the stage-3 smokes and may save verbatim.
export function tasksFor(result, runId) {
  if (result && result.result && typeof result.result === "object" && !Array.isArray(result.tasks) && !Array.isArray(result.items)) result = result.result;
  if (result && Array.isArray(result.tasks)) {
    if (result.runId && result.runId !== runId) throw new Error(`result is for run ${result.runId}, not ${runId}`);
    return { tasks: result.tasks, base: result.base || null, argsDigest: result.argsDigest ?? null, result };
  }
  const item = result && Array.isArray(result.items) ? result.items.find((i) => i && i.runId === runId) : null;
  if (item && Array.isArray(item.tasks)) return { tasks: item.tasks, base: item.base || null, argsDigest: item.argsDigest ?? null, result: item };
  throw new Error(`result has no tasks for run ${runId}`);
}

export const buildArgsPath = (runId) => `.muster/runs/${runId}/build-args.json`;

// The trusted task list, in manifest order and grouped by wave, from the build args committed at
// HEAD. Wave numbers are the plan's: build args written with `--from-wave N` (a rebuild after a
// partial merge) carry `fromWave: N`, and their first wave is wave N.
function plannedTasks(root, runId) {
  const shown = git(root, ["show", `HEAD:${buildArgsPath(runId)}`]);
  if (!shown.ok) return { problem: `${buildArgsPath(runId)} is not committed at HEAD; commit the exact muster:build args before building` };
  let args;
  try { args = JSON.parse(shown.out); } catch (e) { return { problem: `${buildArgsPath(runId)} is not valid JSON: ${e.message}` }; }
  const own = Array.isArray(args?.items) ? args.items.find((i) => i && i.runId === runId) : args;
  if (!own || !Array.isArray(own.waves)) return { problem: `${buildArgsPath(runId)} has no waves for run ${runId}` };
  const first = Number.isInteger(own.fromWave) && own.fromWave > 1 ? own.fromWave : 1;
  const waves = own.waves.map((w, i) => ({
    wave: first + i,
    tasks: (Array.isArray(w) ? w : []).map((t) => ({ taskId: t?.taskId, title: t?.title || "", verify: list(t?.verify), wave: first + i })),
  }));
  return { waves, tasks: waves.flatMap((w) => w.tasks), args: own };
}

const ESCALATE = "never edit PLAN.md or build-args.json to get past a merge-wave failure: escalate to the user, or after a re-plan re-run `muster build-args` and the build";

// The committed inputs must be exactly what `muster build-args` wrote, and the build must have
// run with those args. Returns a list of problems; empty means unchanged.
export function inputDrift(root, runId, args, resultDigest) {
  const d = args?.digests;
  if (!d || typeof d.plan !== "string" || typeof d.args !== "string") {
    return [`${buildArgsPath(runId)} carries no digests, so \`muster build-args\` did not write it (or it predates them); re-run \`muster build-args ${runId}\` and the build`];
  }
  const p = [];
  const now = argsDigest(args);
  if (now !== d.args) p.push(`${buildArgsPath(runId)} changed after \`muster build-args\` wrote it (args digest ${short(now)}, recorded ${short(d.args)}); ${ESCALATE}`);
  const plan = spawnSync("git", ["show", `HEAD:.muster/runs/${runId}/PLAN.md`], { cwd: root, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  if (plan.status !== 0) p.push(`.muster/runs/${runId}/PLAN.md is not committed at HEAD; commit the plan inputs before building`);
  else if (planDigest(plan.stdout) !== d.plan) p.push(`.muster/runs/${runId}/PLAN.md changed after \`muster build-args\` ran (recorded digest ${short(d.plan)}); ${ESCALATE}`);
  if (resultDigest && resultDigest !== d.args) p.push(`the build ran with args digest ${short(resultDigest)}, but the committed ${buildArgsPath(runId)} records ${short(d.args)}; ${ESCALATE}`);
  return p;
}

export const RUN_INPUTS = ["CONTEXT.md", "PLAN.md", "build-args.json"];

// What merging `commit` would change in the run inputs: the diff from its merge base with
// HEAD (which carries the plan commit) to the commit. Fails closed when git cannot answer.
function runInputEdits(root, runId, commit) {
  const paths = RUN_INPUTS.map((f) => `.muster/runs/${runId}/${f}`);
  const d = git(root, ["diff", "--name-only", "--no-renames", `HEAD...${commit}`, "--", ...paths]);
  if (!d.ok) return [`(git diff failed: ${tail(d.err, 200)})`];
  return d.out.split("\n").filter(Boolean).sort();
}

// Whole-result guard: no task branch, in any wave, may change the run's committed inputs. A
// branch that rewrites its own plan taints the whole result, so it refuses everything.
function inputEditProblems(root, runId, plan, task) {
  if (!task?.commit || !task.branch) return [];
  const commit = git(root, ["rev-parse", "--verify", "--quiet", `${task.commit}^{commit}`]);
  if (!commit.ok) return [];
  const edited = runInputEdits(root, runId, commit.out);
  return edited.length
    ? [`${plan.taskId}: branch ${task.branch} modifies the run's committed inputs (${edited.join(", ")}) relative to the plan commit; builders must not edit a run's CONTEXT.md, PLAN.md or build-args.json, so re-plan instead of merging`]
    : [];
}

// Per-task pre-merge evidence checks. Returns a list of problems; empty means safe to merge. A
// problem here fails only the task's wave (and so every later wave), never the earlier ones.
function checkTask(root, runId, plan, task) {
  const id = plan.taskId;
  const p = [];
  if (!task) return [`${id}: planned task is missing from the build result`];
  if (task.status !== "done") p.push(`${id}: status is ${task.status}, not done`);
  if (task.selfCheck !== "PASSED") p.push(`${id}: selfCheck is ${task.selfCheck}, not PASSED`);
  if (task.review?.verdict !== "PASS") p.push(`${id}: review verdict is ${task.review?.verdict ?? "missing"}, not PASS`);
  if (!plan.verify.length) p.push(`${id}: the plan has no verify commands to re-run`);
  if (!task.commit || !task.branch) return [...p, `${id}: missing commit or branch`];
  const commit = git(root, ["rev-parse", "--verify", "--quiet", `${task.commit}^{commit}`]);
  if (!commit.ok) return [...p, `${id}: commit ${short(task.commit)} does not exist`];
  const tip = git(root, ["rev-parse", "--verify", "--quiet", `refs/heads/${task.branch}`]);
  if (!tip.ok) return [...p, `${id}: branch ${task.branch} does not exist`];
  if (!git(root, ["merge-base", "--is-ancestor", commit.out, tip.out]).ok) {
    p.push(`${id}: commit ${short(commit.out)} is not on branch ${task.branch}`);
  } else if (tip.out !== commit.out) {
    p.push(`${id}: branch ${task.branch} has commits after ${short(commit.out)} that were not reviewed (tip ${short(tip.out)})`);
  }
  const reviewed = task.review?.commitReviewed
    ? git(root, ["rev-parse", "--verify", "--quiet", `${task.review.commitReviewed}^{commit}`])
    : { ok: false };
  if (!reviewed.ok || reviewed.out !== commit.out) {
    p.push(`${id}: reviewed commit ${short(task.review?.commitReviewed) || "(none)"} is not the claimed commit ${short(commit.out)}`);
  }
  return p;
}

// Per-wave check: muster:team records an integration check per wave of 2+ tasks (its `wave` counts
// the waves of the args it ran, from 1). Its tasks can each pass review while the wave fails to
// wire together, and team halts on that FAIL, so the wave must not merge either.
function integrationProblems(result, index, wave) {
  const recs = Array.isArray(result?.integration) ? result.integration : [];
  return recs.filter((r) => r && r.wave === index + 1 && r.verdict === "FAIL")
    .map((r) => `wave ${wave}: the integration check failed (${r.reason || "blockers"})`);
}

// Agent-reported testsRun is evidence only: report where it differs from the plan.
function testsRunNotes(plan, task) {
  const ran = list(task.testsRun);
  const notes = [];
  const extra = ran.filter((c) => !plan.verify.includes(c));
  const missing = plan.verify.filter((c) => !ran.includes(c));
  if (extra.length) notes.push(`${plan.taskId}: agent-reported testsRun not in the plan (not executed): ${extra.join(" ; ")}`);
  if (missing.length) notes.push(`${plan.taskId}: planned verify the agent did not report running: ${missing.join(" ; ")}`);
  return notes;
}

function runCommand(root, cmd) {
  const r = spawnSync("sh", ["-c", cmd], { cwd: root, encoding: "utf8", timeout: VERIFY_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024 });
  return { cmd, ok: r.status === 0, status: r.status, output: tail(`${r.stdout || ""}${r.stderr || ""}`.trim()) };
}

// Map of real worktree path -> checked-out ref, from `git worktree list --porcelain`.
function worktreeRefs(root) {
  const refs = new Map();
  for (const block of git(root, ["worktree", "list", "--porcelain"]).out.split(/\n\s*\n/)) {
    const path = block.match(/^worktree (.+)$/m)?.[1];
    const ref = block.match(/^branch (.+)$/m)?.[1] || null;
    const real = path && realOrNull(path);
    if (real) refs.set(real, ref);
  }
  return refs;
}

function cleanup(root, task, refs) {
  const done = [];
  const keep = (why) => done.push(`kept worktree ${task.worktree}: ${why}`);
  const merged = git(root, ["merge-base", "--is-ancestor", `refs/heads/${task.branch}`, "HEAD"]).ok;
  if (task.worktree) {
    const real = realOrNull(resolve(root, task.worktree));
    const allowed = join(realOrNull(root) || root, ".claude", "worktrees") + sep;
    if (!real) keep("path does not exist");
    else if (!real.startsWith(allowed)) keep("not under .claude/worktrees/");
    else if (refs.get(real) !== `refs/heads/${task.branch}`) keep(`it does not have ${task.branch} checked out`);
    else if (!merged) keep(`${task.branch} is not merged`);
    else {
      const status = git(real, ["status", "--porcelain"]);
      if (!status.ok || status.out) keep("it has uncommitted or untracked changes");
      else {
        const rm = git(root, ["worktree", "remove", real]);
        if (rm.ok) done.push(`removed worktree ${task.worktree}`);
        else keep(rm.err);
      }
    }
  }
  const del = git(root, ["branch", "-d", task.branch]);
  done.push(del.ok ? `deleted branch ${task.branch}` : `kept branch ${task.branch}: ${del.err}`);
  return done;
}

// Executors cannot always write SUMMARY files (Claude Code steers subagents away from report
// files), so merge-wave records one per merged task unless the branch brought its own.
async function writeSummary(root, runId, plan, task, merged, runs) {
  const dir = await ensureRunDir(root, runId);
  const body = [
    `# SUMMARY ${plan.taskId}: ${plan.title}`,
    "",
    "Recorded by `muster merge-wave` from the executor's result and the re-run verify commands.",
    "",
    `- commit: ${task.commit}`,
    `- merged as: ${merged}`,
    `- files: ${list(task.filesChanged).join(", ") || "-"}`,
    ...(task.agentType ? [`- builder: ${task.agentType}`] : []),
    ...(Array.isArray(task.skillsApplied) ? task.skillsApplied : []).filter((k) => k && k.id).map((k) => `- skill ${String(k.id).trim()}: ${String(k.how || "").trim()}`),
    ...(list(task.skillsMissing).length ? [`- skills without evidence: ${list(task.skillsMissing).join(", ")}`] : []),
    `- review: ${task.review?.verdict} (${list(task.review?.findings?.map((f) => `${f.severity} ${f.file}: ${f.summary}`)).join("; ") || "no findings"})`,
    ...runs.map((r) => `- verify \`${r.cmd}\`: exit ${r.status}`),
    ...list(task.deviations).map((d) => `- deviation: ${d}`),
    "",
  ].join("\n");
  await createContainedFile(root, join(dir, `SUMMARY-${plan.taskId}.md`), body);
}

// What merge-wave leaves in the run dir for `next --run` (src/run-dir.js MERGE_REFUSAL): written on
// a refusal or a partial merge, removed by a merge-wave that merges everything.
async function recordOutcome(root, runId, report, stamp) {
  const path = join(root, ".muster", "runs", runId, MERGE_REFUSAL);
  if (report.ok) {
    if (await inspectContainedPath(root, path)) await rm(path);
    return;
  }
  const record = {
    runId, at: stamp, kind: report.partial ? "partial" : "refused",
    problems: report.problems,
    wavesMerged: report.wavesMerged ?? [],
    failedWave: report.failedWave ?? null,
    tasksMerged: report.merged.map((m) => m.taskId),
    // The inputs this judgment is about; `next` ignores the record once either changes.
    ...(await mergeInputs(root, runId)),
  };
  await ensureRunDir(root, runId);
  await writeContainedFile(root, path, JSON.stringify(record, null, 2) + "\n");
}

// `result` is the parsed build result; the CLI passes `resultFile` instead so the
// worktree refusal fires before the file is read.
//
// Two kinds of check, kept apart:
// - Whole-result checks refuse everything before anything merges: a malformed result, a dirty
//   tree, a base that is not an ancestor of HEAD, build args that are missing or changed (the
//   digest guard on PLAN.md and build-args.json, and the result's argsDigest), result tasks that
//   do not match the args, and any task branch that edits the run's committed inputs.
// - Per-task checks (and a wave's integration verdict) fail only that task's wave. Waves merge in
//   order; each wave whose tasks all pass merges and is verified as a unit. At the first failing
//   wave (a pre-merge problem, a merge conflict or a failed verify) merge-wave rolls that wave
//   back, merges nothing from it or any later wave, keeps their worktrees and branches for the
//   rebuild, and exits non-zero with `partial: true`, `wavesMerged` and `failedWave`.
export async function mergeWave({ cwd, runId, result, resultFile, now = () => new Date() }) {
  assertRunId(runId);
  const top = git(cwd, ["rev-parse", "--show-toplevel"]);
  if (!top.ok) return { ok: false, runId, problems: [`not a git repository: ${cwd}`] };
  const root = top.out;
  if (isClaudeWorktree(root) || isClaudeWorktree(realpathSync(root))) {
    return { ok: false, runId, problems: [`refusing to run inside a .claude/worktrees/ checkout (${root}); run merge-wave from the main checkout`] };
  }
  const report = { ok: false, runId, merged: [], verify: [], cleanup: [], notes: [], problems: [] };
  const finish = async (ok) => {
    report.ok = ok;
    const stamp = now().toISOString();
    const merges = report.merged.map((m) => `${stamp} merge-wave: merged ${m.taskId} ${short(m.commit)} as ${short(m.merge)}; verify ${m.passed}/${m.commands} passed`);
    const lines = ok ? merges
      : report.partial
        ? [...merges, `${stamp} merge-wave: PARTIAL: merged waves ${report.wavesMerged.join(", ") || "none"}; wave ${report.failedWave} and later not merged; verification cannot PASS until they merge: ${report.problems.join("; ")}`]
        : [`${stamp} merge-wave: REFUSED: ${report.problems.join("; ")}`];
    await appendStateLog(root, runId, lines);
    await recordOutcome(root, runId, report, stamp);
    return report;
  };

  // ---- Whole-result checks: any problem refuses everything. ----
  let found;
  try {
    found = tasksFor(result ?? JSON.parse(readFileSync(resultFile, "utf8")), runId);
  } catch (e) {
    report.problems.push(`the build result is malformed: ${e.message}`);
    return finish(false);
  }
  const { tasks, base } = found;
  const runPrefix = `.muster/runs/${runId}/`;
  const dirty = git(root, ["status", "--porcelain", "--untracked-files=no"]).out
    .split("\n").filter(Boolean).filter((l) => !l.slice(3).startsWith(runPrefix));
  if (dirty.length) report.problems.push(`working tree has uncommitted tracked changes: ${dirty.join(", ")}`);
  if (base && !git(root, ["merge-base", "--is-ancestor", base, "HEAD"]).ok) {
    report.problems.push(`build base ${short(base)} is not an ancestor of HEAD`);
  }
  const planned = plannedTasks(root, runId);
  if (planned.problem) {
    report.problems.push(planned.problem);
    return finish(false);
  }
  report.problems.push(...inputDrift(root, runId, planned.args, found.argsDigest));
  if (!found.argsDigest) report.notes.push("the build result carries no argsDigest, so the args the build ran with were not checked");
  // A result read from elsewhere (the Workflow tool's output file) is kept in the run dir, so
  // the session never reads or re-writes it.
  if (resultFile && resolve(resultFile) !== resolve(root, runPrefix, "build-result.json")) {
    await ensureRunDir(root, runId);
    await writeContainedFile(root, join(root, runPrefix, "build-result.json"), JSON.stringify(found.result, null, 2) + "\n");
  }
  const byId = new Map();
  for (const t of tasks) {
    if (byId.has(t?.taskId)) report.problems.push(`${t?.taskId}: appears twice in the build result`);
    byId.set(t?.taskId, t);
  }
  const plannedIds = new Set(planned.tasks.map((p) => p.taskId));
  for (const id of byId.keys()) if (!plannedIds.has(id)) report.problems.push(`${id}: not a task in the approved build args`);
  if (!planned.tasks.length) report.problems.push("the approved build args have no tasks");
  for (const plan of planned.tasks) report.problems.push(...inputEditProblems(root, runId, plan, byId.get(plan.taskId)));
  if (report.problems.length) return finish(false);

  // ---- Per-task checks: a problem fails its wave and stops the merge there. ----
  const waveProblems = planned.waves.map((w, i) => [
    ...w.tasks.flatMap((plan) => checkTask(root, runId, plan, byId.get(plan.taskId))),
    ...integrationProblems(found.result, i, w.wave),
  ]);
  for (const plan of planned.tasks) if (byId.get(plan.taskId)) report.notes.push(...testsRunNotes(plan, byId.get(plan.taskId)));
  report.problems.push(...waveProblems.flat());
  let failedAt = waveProblems.findIndex((p) => p.length);
  const mergeable = failedAt === -1 ? planned.waves : planned.waves.slice(0, failedAt);

  const summaries = [];
  const mergedWaves = [];
  for (const [i, w] of mergeable.entries()) {
    const waveHead = git(root, ["rev-parse", "HEAD"]).out;
    const before = report.merged.length;
    const waveSummaries = [];
    let why = null;
    for (const plan of w.tasks) {
      const task = byId.get(plan.taskId);
      const title = plan.title.replace(/\s+/g, " ").slice(0, 72);
      const merge = git(root, ["merge", "--no-ff", "--no-edit", "-m", `merge(${runId}): ${plan.taskId}${title ? ` ${title}` : ""}`, task.commit]);
      if (!merge.ok) {
        git(root, ["merge", "--abort"]);
        why = `${plan.taskId}: merge of ${short(task.commit)} failed: ${tail(merge.err || merge.out, 300)}`;
        break;
      }
      const runs = plan.verify.map((cmd) => ({ taskId: plan.taskId, ...runCommand(root, cmd) }));
      report.verify.push(...runs);
      const failed = runs.filter((r) => !r.ok);
      const mergeSha = git(root, ["rev-parse", "HEAD"]).out;
      report.merged.push({ taskId: plan.taskId, commit: task.commit, merge: mergeSha, commands: runs.length, passed: runs.length - failed.length });
      if (failed.length) {
        why = `${plan.taskId}: verify failed after merge: ${failed.map((f) => `\`${f.cmd}\` exited ${f.status}`).join(", ")}`;
        break;
      }
      waveSummaries.push([plan, task, mergeSha, runs]);
    }
    if (why) {
      // The wave is the integration unit: roll back every merge of this wave, keep the earlier ones.
      report.problems.push(why);
      const reset = git(root, ["reset", "--keep", waveHead]);
      if (!reset.ok) report.problems.push(`ROLLBACK FAILED, HEAD is not ${short(waveHead)}: ${reset.err}`);
      report.merged.splice(before);
      failedAt = i;
      break;
    }
    summaries.push(...waveSummaries);
    mergedWaves.push(w);
  }

  for (const s of summaries) await writeSummary(root, runId, ...s);
  const refs = worktreeRefs(root);
  for (const w of mergedWaves) for (const plan of w.tasks) report.cleanup.push(...cleanup(root, byId.get(plan.taskId), refs));
  git(root, ["worktree", "prune"]);
  if (failedAt === -1) return finish(true);
  Object.assign(report, { partial: true, wavesMerged: mergedWaves.map((w) => w.wave), failedWave: planned.waves[failedAt].wave });
  return finish(false);
}
