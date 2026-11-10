// `muster merge-wave <runId> --result <build-result.json>` (docs/strategy/stage-2-contracts.md).
//
// Workflow verdicts are evidence, not truth, and the build result is agent output, so it is
// never trusted to say what to run or what to delete:
// - Merge order, titles and the commands re-run after each merge come from the approved build
//   args, committed at HEAD as .muster/runs/<id>/build-args.json (the exact args the main
//   thread passed to muster:build). Agent-reported testsRun is compared, never executed.
// - Before anything merges, every claimed commit must exist, sit at the tip of its branch,
//   and be the sha the reviewer passed.
// - A worktree is removed only when it is under <root>/.claude/worktrees/, has the merged
//   task branch checked out, and is clean; branches are deleted with `branch -d` only.
// Any mismatch rolls HEAD back and the CLI exits non-zero.
import { spawnSync } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { appendStateLog, assertRunId, ensureRunDir } from "./run-dir.js";
import { createContainedFile } from "./fs-safe.js";

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

// A build result is either build.js's `{runId, tasks}` or backlog.js's `{items:[...]}`.
export function tasksFor(result, runId) {
  if (result && Array.isArray(result.tasks)) {
    if (result.runId && result.runId !== runId) throw new Error(`result is for run ${result.runId}, not ${runId}`);
    return { tasks: result.tasks, base: result.base || null };
  }
  const item = result && Array.isArray(result.items) ? result.items.find((i) => i && i.runId === runId) : null;
  if (item && Array.isArray(item.tasks)) return { tasks: item.tasks, base: item.base || null };
  throw new Error(`result has no tasks for run ${runId}`);
}

export const buildArgsPath = (runId) => `.muster/runs/${runId}/build-args.json`;

// The trusted task list, in manifest order, from the build args committed at HEAD.
function plannedTasks(root, runId) {
  const shown = git(root, ["show", `HEAD:${buildArgsPath(runId)}`]);
  if (!shown.ok) return { problem: `${buildArgsPath(runId)} is not committed at HEAD; commit the exact muster:build args before building` };
  let args;
  try { args = JSON.parse(shown.out); } catch (e) { return { problem: `${buildArgsPath(runId)} is not valid JSON: ${e.message}` }; }
  const own = Array.isArray(args?.items) ? args.items.find((i) => i && i.runId === runId) : args;
  if (!own || !Array.isArray(own.waves)) return { problem: `${buildArgsPath(runId)} has no waves for run ${runId}` };
  const tasks = own.waves.flatMap((w) => (Array.isArray(w) ? w : [])).map((t) => ({ taskId: t?.taskId, title: t?.title || "", verify: list(t?.verify) }));
  return { tasks };
}

// Pre-merge evidence checks. Returns a list of problems; empty means safe to merge.
function checkTask(root, plan, task) {
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
    `- review: ${task.review?.verdict} (${list(task.review?.findings?.map((f) => `${f.severity} ${f.file}: ${f.summary}`)).join("; ") || "no findings"})`,
    ...runs.map((r) => `- verify \`${r.cmd}\`: exit ${r.status}`),
    ...list(task.deviations).map((d) => `- deviation: ${d}`),
    "",
  ].join("\n");
  await createContainedFile(root, join(dir, `SUMMARY-${plan.taskId}.md`), body);
}

// `result` is the parsed build result; the CLI passes `resultFile` instead so the
// worktree refusal fires before the file is read.
export async function mergeWave({ cwd, runId, result, resultFile, now = () => new Date() }) {
  assertRunId(runId);
  const top = git(cwd, ["rev-parse", "--show-toplevel"]);
  if (!top.ok) return { ok: false, runId, problems: [`not a git repository: ${cwd}`] };
  const root = top.out;
  if (isClaudeWorktree(root) || isClaudeWorktree(realpathSync(root))) {
    return { ok: false, runId, problems: [`refusing to run inside a .claude/worktrees/ checkout (${root}); run merge-wave from the main checkout`] };
  }
  const { tasks, base } = tasksFor(result ?? JSON.parse(readFileSync(resultFile, "utf8")), runId);
  const report = { ok: false, runId, merged: [], verify: [], cleanup: [], notes: [], problems: [] };
  const finish = async (ok) => {
    report.ok = ok;
    const stamp = now().toISOString();
    const lines = ok
      ? report.merged.map((m) => `${stamp} merge-wave: merged ${m.taskId} ${short(m.commit)} as ${short(m.merge)}; verify ${m.passed}/${m.commands} passed`)
      : [`${stamp} merge-wave: REFUSED: ${report.problems.join("; ")}`];
    await appendStateLog(root, runId, lines);
    return report;
  };

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
  const byId = new Map();
  for (const t of tasks) {
    if (byId.has(t?.taskId)) report.problems.push(`${t?.taskId}: appears twice in the build result`);
    byId.set(t?.taskId, t);
  }
  const plannedIds = new Set(planned.tasks.map((p) => p.taskId));
  for (const id of byId.keys()) if (!plannedIds.has(id)) report.problems.push(`${id}: not a task in the approved build args`);
  if (!planned.tasks.length) report.problems.push("the approved build args have no tasks");
  for (const plan of planned.tasks) {
    report.problems.push(...checkTask(root, plan, byId.get(plan.taskId)));
    if (byId.get(plan.taskId)) report.notes.push(...testsRunNotes(plan, byId.get(plan.taskId)));
  }
  if (report.problems.length) return finish(false);

  const preHead = git(root, ["rev-parse", "HEAD"]).out;
  const rollback = (why) => {
    report.problems.push(why);
    const reset = git(root, ["reset", "--keep", preHead]);
    if (!reset.ok) report.problems.push(`ROLLBACK FAILED, HEAD is not ${short(preHead)}: ${reset.err}`);
    report.merged = [];
  };
  const summaries = [];
  for (const plan of planned.tasks) {
    const task = byId.get(plan.taskId);
    const title = plan.title.replace(/\s+/g, " ").slice(0, 72);
    const merge = git(root, ["merge", "--no-ff", "--no-edit", "-m", `merge(${runId}): ${plan.taskId}${title ? ` ${title}` : ""}`, task.commit]);
    if (!merge.ok) {
      git(root, ["merge", "--abort"]);
      rollback(`${plan.taskId}: merge of ${short(task.commit)} failed: ${tail(merge.err || merge.out, 300)}`);
      return finish(false);
    }
    const runs = plan.verify.map((cmd) => ({ taskId: plan.taskId, ...runCommand(root, cmd) }));
    report.verify.push(...runs);
    const failed = runs.filter((r) => !r.ok);
    const mergeSha = git(root, ["rev-parse", "HEAD"]).out;
    report.merged.push({ taskId: plan.taskId, commit: task.commit, merge: mergeSha, commands: runs.length, passed: runs.length - failed.length });
    if (failed.length) {
      rollback(`${plan.taskId}: verify failed after merge: ${failed.map((f) => `\`${f.cmd}\` exited ${f.status}`).join(", ")}`);
      return finish(false);
    }
    summaries.push([plan, task, mergeSha, runs]);
  }

  for (const s of summaries) await writeSummary(root, runId, ...s);
  const refs = worktreeRefs(root);
  for (const plan of planned.tasks) report.cleanup.push(...cleanup(root, byId.get(plan.taskId), refs));
  git(root, ["worktree", "prune"]);
  return finish(true);
}
