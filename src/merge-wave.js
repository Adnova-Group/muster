// `muster merge-wave <runId> --result <build-result.json>` (docs/strategy/stage-2-contracts.md).
// Workflow verdicts are evidence, not truth: before anything is merged, every claimed
// commit must exist, sit at the tip of its branch, and match the reviewed sha. Then the
// branches merge --no-ff in manifest order, each task's verify/testsRun commands re-run,
// and the worktrees and branches are removed. Any mismatch leaves HEAD where it was
// and exits non-zero.
import { spawnSync } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { resolve, sep } from "node:path";
import { appendStateLog, assertRunId } from "./run-dir.js";

const VERIFY_TIMEOUT_MS = 10 * 60 * 1000;

function git(cwd, args) {
  const r = spawnSync("git", args, { cwd, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  return { ok: r.status === 0, out: (r.stdout || "").trim(), err: (r.stderr || "").trim() };
}

const short = (sha) => String(sha || "").slice(0, 10);
const tail = (s, n = 600) => (s.length > n ? `...${s.slice(-n)}` : s);

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

function commandsFor(task) {
  const cmds = [...(task.verify || []), ...(task.testsRun || [])].map((c) => String(c).trim()).filter(Boolean);
  return [...new Set(cmds)];
}

// Pre-merge evidence checks. Returns a list of problems; empty means safe to merge.
function checkTask(root, task, i) {
  const id = task?.taskId || `#${i}`;
  const p = [];
  if (task?.status !== "done") p.push(`${id}: status is ${task?.status}, not done`);
  if (task?.selfCheck !== "PASSED") p.push(`${id}: selfCheck is ${task?.selfCheck}, not PASSED`);
  if (task?.review?.verdict !== "PASS") p.push(`${id}: review verdict is ${task?.review?.verdict ?? "missing"}, not PASS`);
  if (task && !commandsFor(task).length) p.push(`${id}: no verify or testsRun commands to re-run`);
  if (!task?.commit || !task?.branch) return [...p, `${id}: missing commit or branch`];
  const commit = git(root, ["rev-parse", "--verify", "--quiet", `${task.commit}^{commit}`]);
  if (!commit.ok) return [...p, `${id}: commit ${short(task.commit)} does not exist`];
  const tip = git(root, ["rev-parse", "--verify", "--quiet", `refs/heads/${task.branch}`]);
  if (!tip.ok) return [...p, `${id}: branch ${task.branch} does not exist`];
  if (!git(root, ["merge-base", "--is-ancestor", commit.out, tip.out]).ok) {
    p.push(`${id}: commit ${short(commit.out)} is not on branch ${task.branch}`);
  } else if (tip.out !== commit.out) {
    p.push(`${id}: branch ${task.branch} has commits after ${short(commit.out)} that were not reviewed (tip ${short(tip.out)})`);
  }
  const reviewed = task?.review?.commitReviewed
    ? git(root, ["rev-parse", "--verify", "--quiet", `${task.review.commitReviewed}^{commit}`])
    : { ok: false };
  if (!reviewed.ok || reviewed.out !== commit.out) {
    p.push(`${id}: reviewed commit ${short(task?.review?.commitReviewed) || "(none)"} is not the claimed commit ${short(commit.out)}`);
  }
  return p;
}

function runCommand(root, cmd) {
  const r = spawnSync("sh", ["-c", cmd], { cwd: root, encoding: "utf8", timeout: VERIFY_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024 });
  return { cmd, ok: r.status === 0, status: r.status, output: tail(`${r.stdout || ""}${r.stderr || ""}`.trim()) };
}

function cleanup(root, task, worktrees) {
  const done = [];
  if (task.worktree) {
    const wt = resolve(root, task.worktree);
    if (worktrees.has(wt)) {
      git(root, ["worktree", "unlock", wt]);
      const rm = git(root, ["worktree", "remove", "--force", wt]);
      done.push(rm.ok ? `removed worktree ${task.worktree}` : `could not remove worktree ${task.worktree}: ${rm.err}`);
    }
  }
  const current = git(root, ["rev-parse", "--abbrev-ref", "HEAD"]).out;
  if (task.branch !== current && git(root, ["merge-base", "--is-ancestor", `refs/heads/${task.branch}`, "HEAD"]).ok) {
    const del = git(root, ["branch", "-D", task.branch]);
    done.push(del.ok ? `deleted branch ${task.branch}` : `could not delete branch ${task.branch}: ${del.err}`);
  }
  return done;
}

function listWorktrees(root) {
  const set = new Set();
  for (const line of git(root, ["worktree", "list", "--porcelain"]).out.split("\n")) {
    if (line.startsWith("worktree ")) {
      const p = line.slice("worktree ".length);
      set.add(p);
      try { set.add(realpathSync(p)); } catch { /* already gone */ }
    }
  }
  return set;
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
  const report = { ok: false, runId, merged: [], verify: [], cleanup: [], problems: [] };
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
  if (!tasks.length) report.problems.push("result has no tasks");
  if (base && !git(root, ["merge-base", "--is-ancestor", base, "HEAD"]).ok) {
    report.problems.push(`build base ${short(base)} is not an ancestor of HEAD`);
  }
  tasks.forEach((t, i) => report.problems.push(...checkTask(root, t, i)));
  if (report.problems.length) return finish(false);

  const preHead = git(root, ["rev-parse", "HEAD"]).out;
  const rollback = (why) => {
    report.problems.push(why);
    const reset = git(root, ["reset", "--keep", preHead]);
    if (!reset.ok) report.problems.push(`ROLLBACK FAILED, HEAD is not ${short(preHead)}: ${reset.err}`);
    report.merged = [];
  };
  for (const task of tasks) {
    const title = String(task.title || "").replace(/\s+/g, " ").slice(0, 72);
    const merge = git(root, ["merge", "--no-ff", "--no-edit", "-m", `merge(${runId}): ${task.taskId}${title ? ` ${title}` : ""}`, task.commit]);
    if (!merge.ok) {
      git(root, ["merge", "--abort"]);
      rollback(`${task.taskId}: merge of ${short(task.commit)} failed: ${tail(merge.err || merge.out, 300)}`);
      return finish(false);
    }
    const commands = commandsFor(task);
    const runs = commands.map((cmd) => ({ taskId: task.taskId, ...runCommand(root, cmd) }));
    report.verify.push(...runs);
    const failed = runs.filter((r) => !r.ok);
    report.merged.push({ taskId: task.taskId, commit: task.commit, merge: git(root, ["rev-parse", "HEAD"]).out, commands: runs.length, passed: runs.length - failed.length });
    if (failed.length) {
      rollback(`${task.taskId}: verify failed after merge: ${failed.map((f) => `\`${f.cmd}\` exited ${f.status}`).join(", ")}`);
      return finish(false);
    }
  }

  const worktrees = listWorktrees(root);
  for (const task of tasks) report.cleanup.push(...cleanup(root, task, worktrees));
  git(root, ["worktree", "prune"]);
  return finish(true);
}
