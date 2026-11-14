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
//   task branch checked out, and is clean; branches are deleted with `branch -d` only. The one
//   exception is an earlier attempt's branch that merge-refusal.json recorded, as git saw it,
//   when that attempt's task did not merge: once the same task merges from a rebuild, its
//   unchanged branch and clean worktree are superseded and removed (removeSuperseded).
// - A task's files are its own commits' files, from git: an executor that merged its
//   dependencies' commits into its worktree reported their files as its own (live run 7).
// Any mismatch rolls HEAD back to the last fully merged wave, records merge-refusal.json for
// `next --run`, and the CLI exits non-zero.
import { spawnSync } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { MERGE_REFUSAL, appendStateLog, assertRunId, ensureRunDir, mergeInputs } from "./run-dir.js";
import { createContainedFile, inspectContainedPath, readContainedFile, writeContainedFile } from "./fs-safe.js";
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
    tasks: (Array.isArray(w) ? w : []).map((t) => ({ taskId: t?.taskId, title: t?.title || "", verify: list(t?.verify), files: list(t?.files), wave: first + i })),
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

// The files a task's own commits change: its non-merge commits that neither HEAD (the base and
// every wave merged before), the earlier waves' commits nor its same-wave siblings' commits
// carry. The reviewer brief scopes its diff the same way. null when git cannot answer.
function ownFiles(root, commit, exclude) {
  const r = git(root, ["log", "--no-merges", "--no-renames", "--format=", "--name-only", commit, "--not", "HEAD", ...exclude]);
  return r.ok ? [...new Set(r.out.split("\n").filter(Boolean))].sort() : null;
}

const inPlan = (file, planned) => planned.some((p) => file === p || file.startsWith(p.endsWith("/") ? p : `${p}/`));

// Agent-reported filesChanged is evidence only: report where it differs from the task's own
// commits, and the own files outside the task's planned list (the run dir excepted: merge-wave
// writes SUMMARY files there).
function filesNotes(plan, task, own, runPrefix) {
  const notes = [];
  const borrowed = list(task.filesChanged).filter((f) => !own.includes(f));
  if (borrowed.length) notes.push(`${plan.taskId}: agent-reported filesChanged not in the task's own commits (merged from a dependency, or never committed): ${borrowed.join(", ")}; its own files: ${own.join(", ") || "none"}`);
  const outside = plan.files.length ? own.filter((f) => !f.startsWith(runPrefix) && !inPlan(f, plan.files)) : [];
  if (outside.length) notes.push(`${plan.taskId}: its own commits change files outside its planned list: ${outside.join(", ")}`);
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

// The executor branch namespaces (muster-executor.md's branch guard). Only a branch in them, and
// checked out nowhere but under .claude/worktrees/, is ever recorded as an unmerged attempt.
const AGENT_BRANCH_RE = /^((worktree-)?agent-|worktree-wf_)[A-Za-z0-9._/-]{1,200}$/;
const SHA_RE = /^[0-9a-f]{40}([0-9a-f]{24})?$/;
const worktreesDir = (root) => join(realOrNull(root) || root, ".claude", "worktrees") + sep;
const checkedOutAt = (refs, branch) => [...refs].filter(([, ref]) => ref === `refs/heads/${branch}`).map(([path]) => path);

// The worktrees and branches of the result's tasks this call did not merge, as git sees them now
// (never as the result claims them): kept for the rebuild and recorded in merge-refusal.json, so
// the merge-wave that later merges the same task from a rebuild can remove them.
function unmergedAttempts(root, tasks, mergedIds, refs) {
  const out = [];
  for (const t of tasks) {
    if (!t || typeof t.taskId !== "string" || mergedIds.has(t.taskId) || !AGENT_BRANCH_RE.test(String(t.branch || ""))) continue;
    const tip = git(root, ["rev-parse", "--verify", "--quiet", `refs/heads/${t.branch}`]);
    if (!tip.ok) continue;
    const at = checkedOutAt(refs, t.branch);
    if (at.length > 1 || at.some((p) => !p.startsWith(worktreesDir(root)))) continue;
    out.push({ taskId: t.taskId, branch: t.branch, tip: tip.out, worktree: at[0] || null });
  }
  return out;
}

// The unmerged attempts an earlier merge-wave of this run recorded; malformed entries are dropped.
async function recordedAttempts(root, runId) {
  let j = null;
  try { j = JSON.parse((await readContainedFile(root, join(root, ".muster", "runs", runId, MERGE_REFUSAL), { allowMissing: true }))?.toString("utf8") || "null"); } catch { j = null; }
  return (Array.isArray(j?.unmerged) ? j.unmerged : []).filter((s) => s && typeof s.taskId === "string" &&
    AGENT_BRANCH_RE.test(String(s.branch || "")) && SHA_RE.test(String(s.tip || "")) && (s.worktree === null || typeof s.worktree === "string"));
}

// Removes a superseded attempt: the task merged from another branch, so the recorded branch is
// deleted (`-D`: it is merged into nothing) only while it still points at the recorded tip, and
// its worktree only while it is the recorded one, under .claude/worktrees/, and clean. Returns
// the cleanup lines and whether anything was kept (a kept attempt stays recorded).
function removeSuperseded(root, s, refs) {
  const what = `superseded attempt of ${s.taskId}`;
  const tip = git(root, ["rev-parse", "--verify", "--quiet", `refs/heads/${s.branch}`]);
  if (!tip.ok) return { lines: [`${what}: branch ${s.branch} is already gone`], kept: false };
  if (tip.out !== s.tip) return { lines: [`kept ${what}: branch ${s.branch} moved from the recorded ${short(s.tip)} to ${short(tip.out)}`], kept: true };
  const lines = [];
  for (const path of checkedOutAt(refs, s.branch)) {
    if (path !== s.worktree || !path.startsWith(worktreesDir(root))) return { lines: [...lines, `kept ${what}: ${s.branch} is checked out at ${path}, not the recorded worktree`], kept: true };
    const status = git(path, ["status", "--porcelain"]);
    if (!status.ok || status.out) return { lines: [...lines, `kept ${what}: worktree ${path} has uncommitted or untracked changes`], kept: true };
    const rm = git(root, ["worktree", "remove", path]);
    if (!rm.ok) return { lines: [...lines, `kept ${what}: ${rm.err}`], kept: true };
    lines.push(`removed ${what}: worktree ${path}`);
  }
  const del = git(root, ["branch", "-D", s.branch]);
  if (!del.ok) return { lines: [...lines, `kept ${what}: branch ${s.branch}: ${del.err}`], kept: true };
  return { lines: [...lines, `removed ${what}: branch ${s.branch} at ${short(s.tip)}`], kept: false };
}

// Settles the recorded attempts against this call: one of a task merged now is superseded and
// removed; the others (and any removal that kept something) stay recorded, along with this call's
// own unmerged tasks. Returns the entries the next record carries.
function settleAttempts(root, earlier, tasks, mergedIds, report) {
  const refs = worktreeRefs(root);
  const current = new Set(tasks.map((t) => t?.branch).filter(Boolean));
  const carried = [];
  for (const s of earlier) {
    if (current.has(s.branch)) continue; // this result's own task: recorded afresh below, or merged and cleaned up
    if (!mergedIds.has(s.taskId)) { carried.push(s); continue; }
    const { lines, kept } = removeSuperseded(root, s, refs);
    report.cleanup.push(...lines);
    if (kept) carried.push(s);
  }
  git(root, ["worktree", "prune"]);
  return [...unmergedAttempts(root, tasks, mergedIds, worktreeRefs(root)), ...carried];
}

// Executors cannot always write SUMMARY files (Claude Code steers subagents away from report
// files), so merge-wave records one per merged task unless the branch brought its own.
async function writeSummary(root, runId, plan, task, merged, runs, own) {
  const dir = await ensureRunDir(root, runId);
  const body = [
    `# SUMMARY ${plan.taskId}: ${plan.title}`,
    "",
    "Recorded by `muster merge-wave` from the executor's result and the re-run verify commands.",
    "",
    `- commit: ${task.commit}`,
    `- merged as: ${merged}`,
    `- files: ${(own || list(task.filesChanged)).join(", ") || "-"}`,
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
async function recordOutcome(root, runId, report, stamp, unmerged) {
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
    // The unmerged tasks' branches and worktrees (this attempt's and still-kept earlier ones):
    // the merge-wave that merges the same task from a rebuild removes them (settleAttempts).
    unmerged,
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
//   rebuild (recorded in merge-refusal.json `unmerged`), and exits non-zero with `partial: true`,
//   `wavesMerged` and `failedWave`. A later merge-wave that merges those tasks from the rebuild
//   removes the recorded worktrees and branches they superseded.
export async function mergeWave({ cwd, runId, result, resultFile, now = () => new Date() }) {
  assertRunId(runId);
  const top = git(cwd, ["rev-parse", "--show-toplevel"]);
  if (!top.ok) return { ok: false, runId, problems: [`not a git repository: ${cwd}`] };
  const root = top.out;
  if (isClaudeWorktree(root) || isClaudeWorktree(realpathSync(root))) {
    return { ok: false, runId, problems: [`refusing to run inside a .claude/worktrees/ checkout (${root}); run merge-wave from the main checkout`] };
  }
  const report = { ok: false, runId, merged: [], verify: [], cleanup: [], notes: [], problems: [] };
  const earlier = await recordedAttempts(root, runId);
  let resultTasks = [];
  const finish = async (ok) => {
    report.ok = ok;
    const unmerged = settleAttempts(root, earlier, resultTasks, new Set(report.merged.map((m) => m.taskId)), report);
    // A full merge removes the record, so name what it still held for the user to remove by hand.
    if (ok) for (const s of unmerged) report.cleanup.push(`left ${s.branch}${s.worktree ? ` (worktree ${s.worktree})` : ""}: an earlier attempt of ${s.taskId}, not removed above; review it, then remove it by hand`);
    const stamp = now().toISOString();
    const merges = report.merged.map((m) => `${stamp} merge-wave: merged ${m.taskId} ${short(m.commit)} as ${short(m.merge)}; verify ${m.passed}/${m.commands} passed`);
    const lines = ok ? merges
      : report.partial
        ? [...merges, `${stamp} merge-wave: PARTIAL: merged waves ${report.wavesMerged.join(", ") || "none"}; wave ${report.failedWave} and later not merged; verification cannot PASS until they merge: ${report.problems.join("; ")}`]
        : [`${stamp} merge-wave: REFUSED: ${report.problems.join("; ")}`];
    await appendStateLog(root, runId, lines);
    await recordOutcome(root, runId, report, stamp, unmerged);
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
  resultTasks = tasks.filter((t) => t && typeof t === "object");
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

  // Each task's own files, against HEAD, the earlier waves' commits and its same-wave siblings'
  // commits, any of which it may have merged in (live run 8: an integration fixer merged sibling
  // 01 into 02's branch, and 01's files were reported, and summarized, as 02's). A sibling whose
  // commit already contains this task's commit merged this task, not the other way round, so it
  // is not excluded: that would erase the task's own files.
  report.files = {};
  const own = new Map();
  const sha = (c) => (c ? git(root, ["rev-parse", "--verify", "--quiet", `${c}^{commit}`]) : { ok: false });
  const priorCommits = [];
  for (const w of planned.waves) {
    const here = w.tasks.map((plan) => ({ plan, task: byId.get(plan.taskId), c: sha(byId.get(plan.taskId)?.commit) })).filter((x) => x.c.ok);
    for (const { plan, task, c } of here) {
      const siblings = here.filter((x) => x.c.out !== c.out && !git(root, ["merge-base", "--is-ancestor", c.out, x.c.out]).ok).map((x) => x.c.out);
      const files = ownFiles(root, c.out, [...priorCommits, ...siblings]);
      if (!files) continue;
      own.set(plan.taskId, files);
      report.files[plan.taskId] = files;
      report.notes.push(...filesNotes(plan, task, files, runPrefix));
    }
    priorCommits.push(...here.map((x) => x.c.out));
  }

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
      waveSummaries.push([plan, task, mergeSha, runs, own.get(plan.taskId)]);
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
