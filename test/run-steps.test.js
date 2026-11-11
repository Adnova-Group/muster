// Stage-2 deterministic CLI steps: preflight, merge-wave, next --run.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { trackedMkdtemp } from "../test-support/helpers.js";
import { mergeWave, isClaudeWorktree } from "../src/merge-wave.js";
import { argsDigest, planDigest } from "../src/build-args.js";
import { nextForRun, planTaskIds, verificationVerdict } from "../src/run-next.js";

const CLI = fileURLToPath(new URL("../src/cli.js", import.meta.url));
const GIT_ENV = { GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
// mergeWave runs in-process too; node --test gives this file its own process.
Object.assign(process.env, GIT_ENV);
const hasBranch = (cwd, b) => spawnSync("git", ["rev-parse", "--verify", "--quiet", `refs/heads/${b}`], { cwd }).status === 0;

function sh(cwd, cmd, args) {
  const r = spawnSync(cmd, args, { cwd, encoding: "utf8", env: { ...process.env, ...GIT_ENV } });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(" ")} failed: ${r.stderr}`);
  return r.stdout.trim();
}
const git = (cwd, ...args) => sh(cwd, "git", args);
const cli = (cwd, args, env = {}) => spawnSync(process.execPath, [CLI, ...args], { cwd, encoding: "utf8", env: { ...process.env, ...GIT_ENV, ...env } });

// A repo with two task branches in kept worktrees, as build.js leaves them, and the
// approved build args committed at HEAD (the trusted source of order and verify commands).
// `layout` groups task ids into waves (default: one wave of A and B).
async function repoWithTasks({ verify = {}, edits = {}, layout = [["A", "B"]] } = {}) {
  const root = await trackedMkdtemp(join(tmpdir(), "muster-merge-wave-"));
  git(root, "init", "-q", "-b", "main");
  await writeFile(join(root, "README.md"), "base\n");
  await writeFile(join(root, ".gitignore"), ".claude/worktrees/\n");
  const waves = layout.map((ids) => ids.map((id) => ({ taskId: id, title: `task ${id}`, files: [`${id}.txt`], verify: verify[id] || [`grep -q ${id} ${id}.txt`] })));
  const waveOf = (id) => layout.findIndex((ids) => ids.includes(id)) + 1;
  await mkdir(join(root, ".muster/runs/r1"), { recursive: true });
  // Digested exactly as `muster build-args` does.
  const args = { runId: "r1", waves };
  args.digests = { plan: planDigest("# PLAN r1\n"), args: argsDigest(args) };
  await writeFile(join(root, ".muster/runs/r1/build-args.json"), JSON.stringify(args));
  await writeFile(join(root, ".muster/runs/r1/PLAN.md"), "# PLAN r1\n");
  await writeFile(join(root, ".muster/runs/r1/CONTEXT.md"), "# CONTEXT r1\n");
  git(root, "add", ".");
  git(root, "commit", "-q", "-m", "base");
  const base = git(root, "rev-parse", "HEAD");
  const tasks = [];
  for (const id of layout.flat()) {
    const wt = join(root, ".claude", "worktrees", `wf_${id}`);
    git(root, "worktree", "add", "-q", "-b", `worktree-wf_${id}`, wt, base);
    await writeFile(join(wt, `${id}.txt`), `${id}\n`);
    for (const [path, body] of Object.entries(edits[id] || {})) {
      await mkdir(dirname(join(wt, path)), { recursive: true });
      await writeFile(join(wt, path), body);
    }
    git(wt, "add", ".");
    git(wt, "commit", "-q", "-m", `task ${id} [r1/${id}]`);
    const commit = git(wt, "rev-parse", "HEAD");
    tasks.push({
      taskId: id, title: `task ${id}`, wave: waveOf(id), status: "done", branch: `worktree-wf_${id}`, commit, worktree: wt,
      filesChanged: [`${id}.txt`], testsRun: [`grep -q ${id} ${id}.txt`], testsPassed: true, selfCheck: "PASSED", deviations: [],
      verify: [`grep -q ${id} ${id}.txt`],
      review: { taskId: id, verdict: "PASS", commitReviewed: commit, findings: [], testsRun: [], testsPassed: true },
    });
  }
  return { root, base, result: { runId: "r1", base, argsDigest: args.digests.args, tasks, verification: { verdict: "PASS", truths: [], gaps: [] } } };
}

const NOW = () => new Date("2026-11-09T12:00:00Z");

test("merge-wave: merges --no-ff in plan order, re-runs planned verify, removes worktrees and branches", async () => {
  const { root, base, result } = await repoWithTasks();
  Object.assign(result.tasks[0], { agentType: "muster:backend-development-test-automator", skillsApplied: [{ id: "sp-tdd", how: "test first", quote: "q" }], skillsMissing: ["sp-debug"] });
  result.tasks.reverse(); // the build result's order is not trusted; the build args decide
  const report = await mergeWave({ cwd: root, runId: "r1", result, now: NOW });
  assert.equal(report.ok, true, JSON.stringify(report.problems));
  assert.deepEqual(report.merged.map((m) => [m.taskId, m.commands, m.passed]), [["A", 1, 1], ["B", 1, 1]]);
  assert.deepEqual(git(root, "log", "--first-parent", "--format=%s", `${base}..HEAD`).split("\n"), ["merge(r1): B task B", "merge(r1): A task A"]);
  assert.equal(git(root, "rev-list", "--merges", "--count", `${base}..HEAD`), "2");
  assert.ok(existsSync(join(root, "A.txt")) && existsSync(join(root, "B.txt")));
  assert.equal(hasBranch(root, "worktree-wf_A") || hasBranch(root, "worktree-wf_B"), false);
  assert.equal(git(root, "worktree", "list").split("\n").length, 1);
  assert.deepEqual(report.notes, []);
  const state = await readFile(join(root, ".muster/runs/r1/STATE.md"), "utf8");
  assert.match(state, /## Log\n- 2026-11-09T12:00:00.000Z merge-wave: merged A [0-9a-f]{10} as [0-9a-f]{10}; verify 1\/1 passed\n- .* merged B /);
  const summaryA = await readFile(join(root, ".muster/runs/r1/SUMMARY-A.md"), "utf8");
  assert.match(summaryA, /Recorded by `muster merge-wave`[\s\S]*verify `grep -q A A.txt`: exit 0/);
  // Stage 3: the builder and the skill evidence reach the durable run record.
  assert.match(summaryA, /- builder: muster:backend-development-test-automator\n- skill sp-tdd: test first\n- skills without evidence: sp-debug/);
  assert.doesNotMatch(await readFile(join(root, ".muster/runs/r1/SUMMARY-B.md"), "utf8"), /builder:|skill/);
});

test("merge-wave: accepts the Workflow tool's {summary, agentCount, logs, result} envelope", async () => {
  const { root, result } = await repoWithTasks();
  const report = await mergeWave({ cwd: root, runId: "r1", result: { summary: "build", agentCount: 5, logs: [], result }, now: NOW });
  assert.equal(report.ok, true, JSON.stringify(report.problems));
  assert.deepEqual(report.merged.map((m) => m.taskId), ["A", "B"]);
});

test("merge-wave: refuses a PLAN.md or build-args.json the main thread changed after build-args ran", async () => {
  // Run 1 (first live e2e): merge-wave exited 1, the session hand-edited the committed PLAN.md
  // and build-args.json (base included), committed them on the work branch and re-ran merge-wave.
  const editPlan = await repoWithTasks();
  await writeFile(join(editPlan.root, ".muster/runs/r1/PLAN.md"), "# PLAN r1\nfixed by hand\n");
  git(editPlan.root, "commit", "-q", "-am", "fix(muster): repair the plan");
  const plan = await mergeWave({ cwd: editPlan.root, runId: "r1", result: editPlan.result, now: NOW });
  assert.equal(plan.ok, false);
  assert.match(plan.problems.join("\n"), /PLAN\.md changed after `muster build-args` ran/);
  assert.match(plan.problems.join("\n"), /never edit PLAN\.md or build-args\.json to get past a merge-wave failure/);
  assert.equal(git(editPlan.root, "rev-list", "--merges", "--count", "HEAD"), "0", "nothing merged");

  const editArgs = await repoWithTasks();
  const path = join(editArgs.root, ".muster/runs/r1/build-args.json");
  const args = JSON.parse(await readFile(path, "utf8"));
  args.base = "065c6eb700cdfe4d0c4f5db2a50555ae6618d54b";
  await writeFile(path, JSON.stringify(args, null, 2));
  git(editArgs.root, "commit", "-q", "-am", "reset base");
  const edited = await mergeWave({ cwd: editArgs.root, runId: "r1", result: editArgs.result, now: NOW });
  assert.equal(edited.ok, false);
  assert.match(edited.problems.join("\n"), /build-args\.json changed after `muster build-args` wrote it/);

  // Re-running build-args after the build (new digests) still does not match the build that ran.
  const rerun = await repoWithTasks();
  const stale = await mergeWave({ cwd: rerun.root, runId: "r1", result: { ...rerun.result, argsDigest: "0".repeat(64) }, now: NOW });
  assert.match(stale.problems.join("\n"), /the build ran with args digest 0000000000/);

  // Hand-written args without digests are refused too.
  const bare = await repoWithTasks();
  const bareArgs = JSON.parse(await readFile(join(bare.root, ".muster/runs/r1/build-args.json"), "utf8"));
  delete bareArgs.digests;
  await writeFile(join(bare.root, ".muster/runs/r1/build-args.json"), JSON.stringify(bareArgs));
  git(bare.root, "commit", "-q", "-am", "hand-written args");
  const none = await mergeWave({ cwd: bare.root, runId: "r1", result: bare.result, now: NOW });
  assert.match(none.problems.join("\n"), /carries no digests/);
});

test("merge-wave: reads the Workflow tool's output file directly and keeps a copy as build-result.json", async () => {
  const { root, result } = await repoWithTasks();
  const outside = await trackedMkdtemp(join(tmpdir(), "muster-wf-output-"));
  const file = join(outside, "task.output");
  await writeFile(file, JSON.stringify({ summary: "Dynamic workflow", agentCount: 5, logs: [], result, workflowProgress: [], totalTokens: 1, totalToolCalls: 1 }));
  const r = cli(root, ["merge-wave", "r1", "--result", file]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const kept = JSON.parse(await readFile(join(root, ".muster/runs/r1/build-result.json"), "utf8"));
  assert.deepEqual(kept.tasks.map((t) => t.taskId), ["A", "B"]);
  assert.equal(kept.argsDigest, result.argsDigest);
  assert.doesNotMatch(git(root, "status", "--porcelain"), /build-result/, "the kept copy is gitignored");
});

test("merge-wave: agent-reported testsRun and verify are never executed", async () => {
  const { root, result } = await repoWithTasks();
  const marker = join(root, "..", `${root.split("/").pop()}-pwned`);
  result.tasks[0].testsRun.push(`touch ${marker}`);
  result.tasks[0].verify = [`touch ${marker}`];
  const report = await mergeWave({ cwd: root, runId: "r1", result, now: NOW });
  assert.equal(report.ok, true, JSON.stringify(report.problems));
  assert.equal(existsSync(marker), false, "a command from the build result ran");
  assert.deepEqual(report.verify.map((v) => v.cmd), ["grep -q A A.txt", "grep -q B B.txt"]);
  assert.match(report.notes.join("\n"), /A: agent-reported testsRun not in the plan \(not executed\): touch /);
});

test("merge-wave: the build args must be committed, and result tasks must match them", async () => {
  const { root, result } = await repoWithTasks();
  result.tasks.push({ ...result.tasks[0], taskId: "Z" });
  const extra = await mergeWave({ cwd: root, runId: "r1", result, now: NOW });
  assert.match(extra.problems.join("\n"), /Z: not a task in the approved build args/);
  result.tasks.splice(1);
  const missing = await mergeWave({ cwd: root, runId: "r1", result, now: NOW });
  assert.match(missing.problems.join("\n"), /B: planned task is missing from the build result/);

  git(root, "rm", "-q", ".muster/runs/r1/build-args.json");
  git(root, "commit", "-q", "-m", "drop args");
  await mkdir(join(root, ".muster/runs/r1"), { recursive: true });
  await writeFile(join(root, ".muster/runs/r1/build-args.json"), JSON.stringify({ runId: "r1", waves: [] }));
  const uncommitted = await mergeWave({ cwd: root, runId: "r1", result, now: NOW });
  assert.match(uncommitted.problems.join("\n"), /build-args\.json is not committed at HEAD/);
});

test("merge-wave CLI: a missing commit is refused before anything merges", async () => {
  const { root, base, result } = await repoWithTasks();
  result.tasks[1].commit = "f".repeat(40);
  result.tasks[1].review.commitReviewed = "f".repeat(40);
  const file = join(root, "build-result.json"); // untracked files do not block a merge
  await writeFile(file, JSON.stringify(result));
  const r = cli(root, ["merge-wave", "r1", "--result", file]);
  assert.equal(r.status, 1);
  const report = JSON.parse(r.stdout);
  assert.equal(report.ok, false);
  assert.match(report.problems.join("\n"), /B: commit ffffffffff does not exist/);
  assert.equal(git(root, "rev-parse", "HEAD"), base, "HEAD must not move");
  assert.equal(hasBranch(root, "worktree-wf_A"), true);
  // A per-task problem in the only wave: nothing merges, and the record says which wave to rebuild.
  assert.equal(report.partial, true);
  assert.deepEqual([report.wavesMerged, report.failedWave], [[], 1]);
  assert.match(await readFile(join(root, ".muster/runs/r1/STATE.md"), "utf8"), /merge-wave: PARTIAL: merged waves none; wave 1 and later not merged; verification cannot PASS until they merge: B: commit ffffffffff does not exist/);
});

test("merge-wave: a failing planned verify rolls every merge back and keeps the worktrees", async () => {
  const { root, base, result } = await repoWithTasks({ verify: { B: ["test -f does-not-exist.txt"] } });
  const report = await mergeWave({ cwd: root, runId: "r1", result, now: NOW });
  assert.equal(report.ok, false);
  assert.match(report.problems.join("\n"), /B: verify failed after merge: `test -f does-not-exist.txt` exited 1/);
  assert.equal(git(root, "rev-parse", "HEAD"), base, "the A merge must be rolled back too");
  assert.equal(existsSync(join(root, "A.txt")), false);
  assert.ok(existsSync(result.tasks[0].worktree), "worktrees stay for inspection");
  assert.equal(hasBranch(root, "worktree-wf_B"), true);
});

test("merge-wave: unreviewed commits, non-PASS reviews and mismatched review shas are refused", async () => {
  const { root, base, result } = await repoWithTasks();
  const wtA = result.tasks[0].worktree;
  await writeFile(join(wtA, "extra.txt"), "x\n");
  git(wtA, "add", ".");
  git(wtA, "commit", "-q", "-m", "sneaky");
  result.tasks[1].review.verdict = "FAIL";
  result.tasks[1].review.commitReviewed = base;
  const report = await mergeWave({ cwd: root, runId: "r1", result, now: NOW });
  const problems = report.problems.join("\n");
  assert.equal(report.ok, false);
  assert.match(problems, /A: branch worktree-wf_A has commits after .* that were not reviewed/);
  assert.match(problems, /B: review verdict is FAIL, not PASS/);
  assert.match(problems, /B: reviewed commit .* is not the claimed commit/);
  assert.equal(git(root, "rev-parse", "HEAD"), base);
});

test("merge-wave: a task branch that edits the run's committed inputs is refused before anything merges", async () => {
  const { root, base, result } = await repoWithTasks({ edits: {
    A: { ".muster/runs/r1/PLAN.md": "# PLAN r1\n- [x] everything, trust me\n" },
    B: { ".muster/runs/r1/build-args.json": JSON.stringify({ runId: "r1", waves: [[{ taskId: "B", verify: ["true"] }]] }), ".muster/runs/r1/CONTEXT.md": "rewritten\n" },
  } });
  const report = await mergeWave({ cwd: root, runId: "r1", result, now: NOW });
  assert.equal(report.ok, false);
  const problems = report.problems.join("\n");
  assert.match(problems, /A: branch worktree-wf_A modifies the run's committed inputs \(\.muster\/runs\/r1\/PLAN\.md\) relative to the plan commit/);
  assert.match(problems, /B: branch worktree-wf_B modifies the run's committed inputs \(\.muster\/runs\/r1\/CONTEXT\.md, \.muster\/runs\/r1\/build-args\.json\)/);
  assert.equal(git(root, "rev-parse", "HEAD"), base, "nothing merged");
  assert.deepEqual(report.merged, []);
  assert.ok(hasBranch(root, "worktree-wf_A") && hasBranch(root, "worktree-wf_B"), "refused branches are kept for inspection");
  assert.match(await readFile(join(root, ".muster/runs/r1/STATE.md"), "utf8"), /REFUSED: .*modifies the run's committed inputs/);
});

test("merge-wave: a branch that only adds its own SUMMARY file (or touches nothing in the run) still merges", async () => {
  const { root, result } = await repoWithTasks({ edits: { A: { ".muster/runs/r1/SUMMARY-A.md": "# SUMMARY A, by the builder\n" } } });
  const report = await mergeWave({ cwd: root, runId: "r1", result, now: NOW });
  assert.equal(report.ok, true, JSON.stringify(report.problems));
  assert.deepEqual(report.merged.map((m) => m.taskId), ["A", "B"]);
  assert.match(await readFile(join(root, ".muster/runs/r1/SUMMARY-A.md"), "utf8"), /by the builder/, "the branch's own SUMMARY is kept");
});

test("merge-wave: worktrees outside .claude/worktrees/, on another branch, or dirty are left untouched", async () => {
  const { root, result } = await repoWithTasks();
  // A: the result points at a worktree outside .claude/worktrees/ that has A's branch.
  const outside = await trackedMkdtemp(join(tmpdir(), "muster-merge-wave-outside-"));
  const realA = result.tasks[0].worktree;
  git(root, "worktree", "move", realA, join(outside, "wt"));
  result.tasks[0].worktree = join(outside, "wt");
  // B: the result points at an unrelated worktree under .claude/worktrees/ on another branch.
  const other = join(root, ".claude", "worktrees", "other");
  git(root, "worktree", "add", "-q", "-b", "other", other);
  const realB = result.tasks[1].worktree;
  result.tasks[1].worktree = other;

  const report = await mergeWave({ cwd: root, runId: "r1", result, now: NOW });
  assert.equal(report.ok, true, JSON.stringify(report.problems));
  const cleanup = report.cleanup.join("\n");
  assert.match(cleanup, /kept worktree .*wt: not under \.claude\/worktrees\//);
  assert.match(cleanup, /kept worktree .*other: it does not have worktree-wf_B checked out/);
  assert.ok(existsSync(join(outside, "wt", "A.txt")) && existsSync(other) && existsSync(realB));
  assert.equal(hasBranch(root, "other"), true);
  assert.equal(hasBranch(root, "worktree-wf_A"), true, "branch -d refuses a branch still checked out");
  assert.match(cleanup, /kept branch worktree-wf_A/);

  // Dirty: an untracked file in an otherwise valid task worktree keeps it.
  const dirty = await repoWithTasks();
  await writeFile(join(dirty.result.tasks[0].worktree, "scratch.log"), "x\n");
  const dirtyReport = await mergeWave({ cwd: dirty.root, runId: "r1", result: dirty.result, now: NOW });
  assert.equal(dirtyReport.ok, true, JSON.stringify(dirtyReport.problems));
  assert.match(dirtyReport.cleanup.join("\n"), /kept worktree .*wf_A: it has uncommitted or untracked changes/);
  assert.ok(existsSync(join(dirty.result.tasks[0].worktree, "scratch.log")));
  assert.match(dirtyReport.cleanup.join("\n"), /removed worktree .*wf_B/);
});

test("merge-wave: refuses a dirty tracked tree and a run inside .claude/worktrees/", async () => {
  const { root, result } = await repoWithTasks();
  await writeFile(join(root, "README.md"), "dirty\n");
  const dirty = await mergeWave({ cwd: root, runId: "r1", result, now: NOW });
  assert.match(dirty.problems.join("\n"), /uncommitted tracked changes: .*README\.md/);
  git(root, "checkout", "--", "README.md");

  const r = cli(result.tasks[0].worktree, ["merge-wave", "r1", "--result", "/dev/null"]);
  assert.equal(r.status, 1);
  const report = JSON.parse(r.stdout || "{}");
  assert.match(report.problems?.[0] || r.stderr, /refusing to run inside a \.claude\/worktrees\/ checkout/);
  assert.equal(isClaudeWorktree("/repo/.claude/worktrees/wf_1"), true);
  assert.equal(isClaudeWorktree("/repo/.claude/worktreesx"), false);
});

test("merge-wave: accepts a backlog.js result and picks the item by runId", async () => {
  const { root, result } = await repoWithTasks();
  const report = await mergeWave({ cwd: root, runId: "r1", result: { items: [{ itemId: "x", runId: "other", tasks: [] }, { itemId: "I1", ...result }] }, now: NOW });
  assert.equal(report.ok, true, JSON.stringify(report.problems));
  // A result for another run is malformed for this one: a whole-result refusal, recorded.
  const other = await mergeWave({ cwd: root, runId: "nope", result, now: NOW });
  assert.equal(other.ok, false);
  assert.match(other.problems.join("\n"), /the build result is malformed: result is for run r1/);
  assert.equal(JSON.parse(await readFile(join(root, ".muster/runs/nope/merge-refusal.json"), "utf8")).kind, "refused");
});

// The build result saved outside the run dir, as the Workflow tool's output file is.
async function resultFileFor(result) {
  const file = join(await trackedMkdtemp(join(tmpdir(), "muster-wf-output-")), "task.output");
  await writeFile(file, JSON.stringify(result));
  return file;
}
const refusalPath = (root) => join(root, ".muster/runs/r1/merge-refusal.json");

test("merge-wave lands the passing prefix: wave 1 merges, a failing wave 2 does not, and next says rebuild wave 2", async () => {
  // Live run: wave 1 passed review and integration, a wave-2 task failed, and nothing merged.
  const { root, base, result } = await repoWithTasks({ layout: [["A"], ["B", "C"]] });
  result.tasks[1].review.verdict = "FAIL";
  const r = cli(root, ["merge-wave", "r1", "--result", await resultFileFor(result)]);
  assert.equal(r.status, 1, "a partial merge exits non-zero");
  const report = JSON.parse(r.stdout);
  assert.equal(report.ok, false);
  assert.equal(report.partial, true);
  assert.deepEqual([report.wavesMerged, report.failedWave], [[1], 2]);
  assert.deepEqual(report.merged.map((m) => m.taskId), ["A"]);
  assert.match(report.problems.join("\n"), /B: review verdict is FAIL, not PASS/);
  assert.deepEqual(git(root, "log", "--first-parent", "--format=%s", `${base}..HEAD`).split("\n"), ["merge(r1): A task A"]);
  assert.ok(existsSync(join(root, "A.txt")));
  assert.equal(existsSync(join(root, "C.txt")), false, "C passed alone, but its wave failed: a wave is the integration unit");
  // Merged wave cleaned up; the failed wave's worktrees and branches stay for the rebuild.
  assert.equal(hasBranch(root, "worktree-wf_A"), false);
  assert.equal(existsSync(result.tasks[0].worktree), false);
  for (const t of result.tasks.slice(1)) assert.ok(hasBranch(root, t.branch) && existsSync(t.worktree), `${t.taskId} kept`);
  assert.ok(existsSync(join(root, ".muster/runs/r1/SUMMARY-A.md")));
  assert.equal(existsSync(join(root, ".muster/runs/r1/SUMMARY-B.md")), false);

  const record = JSON.parse(await readFile(refusalPath(root), "utf8"));
  assert.deepEqual([record.kind, record.wavesMerged, record.failedWave, record.tasksMerged], ["partial", [1], 2, ["A"]]);
  assert.match(record.problems.join("\n"), /B: review verdict is FAIL/);
  assert.doesNotMatch(git(root, "status", "--porcelain", "-uall"), /merge-refusal/, "the record is machine-local, like build-result.json");
  const state = await readFile(join(root, ".muster/runs/r1/STATE.md"), "utf8");
  assert.match(state, /merge-wave: merged A [\s\S]*merge-wave: PARTIAL: merged waves 1; wave 2 and later not merged; verification cannot PASS until they merge: B: review verdict is FAIL/);

  const next = await nextForRun({ cwd: root, runId: "r1" });
  assert.equal(next.position, "merge-partial");
  assert.match(next.next, /^rebuild: muster build-args r1 --from-wave 2, /);
  assert.doesNotMatch(next.next, /merge-wave r1 --result/, "never re-run merge-wave on the same inputs");
  assert.deepEqual([next.wavesMerged, next.failedWave], [[1], 2]);
  assert.match(await readFile(join(root, ".muster/runs/r1/STATE.md"), "utf8"), /- position: merge-partial\n[\s\S]*- verification: not PASS: partial merge, wave 2 and later not merged\n/);
});

// What `muster build-args r1 --from-wave <n>` commits for a rebuild: only the remaining waves.
async function commitRebuildArgs(root, waves, fromWave) {
  const args = { runId: "r1", base: git(root, "rev-parse", "HEAD"), fromWave, waves };
  args.digests = { plan: planDigest("# PLAN r1\n"), args: argsDigest(args) };
  await writeFile(join(root, ".muster/runs/r1/build-args.json"), JSON.stringify(args));
  git(root, "add", ".muster/runs/r1/build-args.json");
  git(root, "commit", "-q", "-m", "chore(muster): plan r1");
  return args;
}

test("a rebuild of the failed waves merges with --from-wave numbering, and that success clears the record", async () => {
  const { root, result } = await repoWithTasks({ layout: [["A"], ["B"]] });
  result.tasks[1].status = "blocked";
  const first = await mergeWave({ cwd: root, runId: "r1", resultFile: await resultFileFor(result), now: NOW });
  assert.deepEqual([first.partial, first.wavesMerged, first.failedWave], [true, [1], 2]);

  const args = await commitRebuildArgs(root, [[{ taskId: "B", title: "task B", files: ["B.txt"], verify: ["grep -q B2 B.txt"] }]], 2);
  // New build args, old build result: the rebuild has not run, so the rebuild is still next.
  const pending = await nextForRun({ cwd: root, runId: "r1" });
  assert.equal(pending.position, "merge-partial");
  assert.match(pending.next, /^rebuild: muster build-args r1 --from-wave 2, /);
  assert.equal(pending.artifacts.mergeRefusal, "partial");

  const head = git(root, "rev-parse", "HEAD");
  const wt = join(root, ".claude", "worktrees", "wf_B2");
  git(root, "worktree", "add", "-q", "-b", "worktree-wf_B2", wt, head);
  await writeFile(join(wt, "B.txt"), "B2\n");
  git(wt, "add", "B.txt");
  git(wt, "commit", "-q", "-m", "task B [r1/B]");
  const commit = git(wt, "rev-parse", "HEAD");
  const task = { ...result.tasks[1], status: "done", wave: 1, branch: "worktree-wf_B2", commit, worktree: wt, testsRun: ["grep -q B2 B.txt"], review: { ...result.tasks[1].review, commitReviewed: commit } };
  const rebuilt = await mergeWave({ cwd: root, runId: "r1", resultFile: await resultFileFor({ runId: "r1", base: head, argsDigest: args.digests.args, tasks: [task] }), now: NOW });
  assert.equal(rebuilt.ok, true, JSON.stringify(rebuilt.problems));
  assert.deepEqual(rebuilt.merged.map((m) => m.taskId), ["B"]);
  assert.equal(existsSync(refusalPath(root)), false, "a later success clears the record");
  const next = await nextForRun({ cwd: root, runId: "r1" });
  assert.equal(next.artifacts.mergeRefusal, null);
  assert.notEqual(next.position, "merge-partial");

  // A failure in a --from-wave build is numbered as the plan's wave, so the next rebuild is right.
  const again = await commitRebuildArgs(root, [[{ taskId: "Z", title: "z", files: [], verify: ["true"] }]], 3);
  const z = await mergeWave({ cwd: root, runId: "r1", result: { runId: "r1", argsDigest: again.digests.args, tasks: [{ taskId: "Z", status: "error" }] }, now: NOW });
  assert.deepEqual([z.partial, z.wavesMerged, z.failedWave], [true, [], 3]);
});

test("merge-wave: a wave-2 verify failure or integration FAIL rolls back only that wave", async () => {
  const verifyFail = await repoWithTasks({ layout: [["A"], ["B"]], verify: { B: ["test -f does-not-exist.txt"] } });
  const v = await mergeWave({ cwd: verifyFail.root, runId: "r1", result: verifyFail.result, now: NOW });
  assert.deepEqual([v.ok, v.wavesMerged, v.failedWave], [false, [1], 2]);
  assert.match(v.problems.join("\n"), /B: verify failed after merge/);
  assert.equal(git(verifyFail.root, "log", "-1", "--format=%s"), "merge(r1): A task A", "B's merge is rolled back, A's kept");
  assert.equal(hasBranch(verifyFail.root, "worktree-wf_B"), true);

  // muster:team: each task passed review, but the wave did not wire together.
  const integration = await repoWithTasks({ layout: [["A"], ["B", "C"]] });
  integration.result.integration = [{ wave: 2, verdict: "FAIL", reason: "integration blockers survived the fix round" }];
  const i = await mergeWave({ cwd: integration.root, runId: "r1", result: integration.result, now: NOW });
  assert.deepEqual([i.ok, i.wavesMerged, i.failedWave], [false, [1], 2]);
  assert.match(i.problems.join("\n"), /wave 2: the integration check failed \(integration blockers survived the fix round\)/);
  assert.equal(existsSync(join(integration.root, "B.txt")), false);
});

test("a whole-result refusal merges nothing, even from passing waves, and next escalates until the inputs change", async () => {
  const { root, base, result } = await repoWithTasks({ layout: [["A"], ["B"]] });
  const file = await resultFileFor({ ...result, argsDigest: "0".repeat(64) });
  const r = cli(root, ["merge-wave", "r1", "--result", file]);
  assert.equal(r.status, 1);
  const report = JSON.parse(r.stdout);
  assert.equal(report.partial, undefined);
  assert.match(report.problems.join("\n"), /the build ran with args digest 0000000000/);
  assert.equal(git(root, "rev-parse", "HEAD"), base, "wave 1 passed every per-task check but nothing merges");
  const record = JSON.parse(await readFile(refusalPath(root), "utf8"));
  assert.deepEqual([record.kind, record.wavesMerged, record.failedWave], ["refused", [], null]);

  const next = await nextForRun({ cwd: root, runId: "r1" });
  assert.equal(next.position, "merge-refused");
  assert.match(next.next, /^escalate: merge-wave refused the whole build result; show these problems to the user and stop .*the build ran with args digest 0000000000/);
  assert.match(next.problems.join("\n"), /args digest 0000000000/);
  // Same inputs again: still the escalation, never "re-run merge-wave".
  assert.equal(cli(root, ["merge-wave", "r1", "--result", file]).status, 1);
  assert.equal((await nextForRun({ cwd: root, runId: "r1" })).position, "merge-refused");
  // A new build result supersedes the record: merging it is the next step again.
  await writeFile(join(root, ".muster/runs/r1/build-result.json"), JSON.stringify(result));
  const fresh = await nextForRun({ cwd: root, runId: "r1" });
  assert.equal(fresh.position, "built");
  assert.equal(fresh.artifacts.mergeRefusal, "superseded");
  // And merging it clears the record.
  const ok = await mergeWave({ cwd: root, runId: "r1", resultFile: join(root, ".muster/runs/r1/build-result.json"), now: NOW });
  assert.equal(ok.ok, true, JSON.stringify(ok.problems));
  assert.equal(existsSync(refusalPath(root)), false);
});


test("next --run derives the position from the run files", async () => {
  const cwd = await trackedMkdtemp(join(tmpdir(), "muster-next-run-"));
  const dir = join(cwd, ".muster/runs/r9");
  const step = async () => (await nextForRun({ cwd, runId: "r9" })).position;

  assert.equal(await step(), "new");
  assert.equal(existsSync(dir), false, "a missing run is reported, not created");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "CONTEXT.md"), "# ctx\n");
  assert.equal(await step(), "discussed");
  assert.match((await nextForRun({ cwd, runId: "r9" })).next, /Workflow\(\{name:"muster:make-plan"/, "the planning workflow, never the /muster:plan command's name");
  await writeFile(join(dir, "PLAN.md"), '<task id="T1">a</task>\n<task id="T2">b</task>\n');
  assert.equal(await step(), "plan-unchecked", "a plan with no gate record is re-checked, never built");
  await writeFile(join(dir, "plan-check.json"), JSON.stringify({ runId: "r9", verdict: "PASS", revisions: 0, issues: [], escalated: null }));
  assert.equal(await step(), "planned");
  await writeFile(join(dir, "build-result.json"), JSON.stringify({ runId: "r9", tasks: [{ taskId: "T1" }, { taskId: "T2" }] }));
  const built = await nextForRun({ cwd, runId: "r9" });
  assert.equal(built.position, "built");
  assert.match(built.next, /muster merge-wave r9 --result \.muster\/runs\/r9\/build-result\.json/);
  // merge-wave's log lines mark the tasks merged; SUMMARY files arrive with the merge.
  await writeFile(join(dir, "STATE.md"), "# Run r9\n\n## Log\n- t merge-wave: merged T1 abc as def; verify 1/1 passed\n- t merge-wave: merged T2 abc as def; verify 1/1 passed\n");
  await writeFile(join(dir, "SUMMARY-T1.md"), "s\n");
  assert.equal(await step(), "planned");
  await writeFile(join(dir, "SUMMARY-T2.md"), "s\n");
  assert.equal(await step(), "executed");
  await writeFile(join(dir, "VERIFICATION.md"), "---\nstatus: gaps\n---\nverdict: GAPS\n");
  assert.equal(await step(), "gaps");
  await writeFile(join(dir, "VERIFICATION.md"), "**Verdict:** PASS\n");
  assert.equal(await step(), "verified");
  await writeFile(join(dir, "continue-here.md"), "resume at verify\n");
  assert.equal(await step(), "paused");

  const state = await readFile(join(dir, "STATE.md"), "utf8");
  assert.match(state, /^# Run r9\n[\s\S]*- position: paused\n[\s\S]*## Log\n- t merge-wave: merged T1 [\s\S]*merged T2 /, "the derived head is rewritten and the log preserved");
  assert.equal(state.match(/## Log/g).length, 1);
});

test("next --run after a stalled plan reports the escalation instead of the build (live e2e 2026-11-10)", async () => {
  const cwd = await trackedMkdtemp(join(tmpdir(), "muster-next-stall-"));
  const dir = join(cwd, ".muster/runs/r3");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "CONTEXT.md"), "# ctx\n");
  await writeFile(join(dir, "PLAN.md"), '<task id="01">a</task>\n<task id="02">b</task>\n');
  // Run 3's make-plan result, as the Workflow tool's envelope the main thread may save verbatim.
  const stalled = { summary: "Write and check a muster PLAN.md", logs: ["blocking issue count stalled at 1; escalating"], result: {
    runId: "r3", planPath: ".muster/runs/r3/PLAN.md", verdict: "ISSUES", revisions: 2, escalated: "stall",
    issues: [{ dimension: "requirement_coverage", severity: "blocker", summary: "x" }, { dimension: "key_links", severity: "info", summary: "y" }] } };
  await writeFile(join(dir, "plan-check.json"), JSON.stringify(stalled));
  const r = await nextForRun({ cwd, runId: "r3" });
  assert.equal(r.position, "plan-escalated");
  assert.match(r.next, /^escalate: the plan never passed the checker \(escalated: stall\)/);
  assert.match(r.next, /Revise[\s\S]*re-run muster:make-plan[\s\S]*or Abort; never build it/);
  assert.doesNotMatch(r.next, /muster:build/);
  assert.equal(r.why, "plan-check.json escalated: stall, 1 blocker(s)");
  assert.equal(r.artifacts.planCheck, "ISSUES");
  assert.match(await readFile(join(dir, "STATE.md"), "utf8"), /- position: plan-escalated\n- next: escalate:/);
  // An ERROR result or an unreadable record is not a pass either.
  await writeFile(join(dir, "plan-check.json"), JSON.stringify({ verdict: "ERROR", escalated: "checker", issues: [] }));
  assert.equal((await nextForRun({ cwd, runId: "r3" })).position, "plan-escalated");
  await writeFile(join(dir, "plan-check.json"), "{not json");
  assert.equal((await nextForRun({ cwd, runId: "r3" })).position, "plan-escalated");
  // A re-plan that passes (the main thread overwrites the record) unblocks the build.
  await writeFile(join(dir, "plan-check.json"), JSON.stringify({ verdict: "PASS", escalated: null, issues: [{ severity: "warning", dimension: "malicious_implementer", summary: "w" }] }));
  const ok = await nextForRun({ cwd, runId: "r3" });
  assert.equal(ok.position, "planned");
  assert.match(ok.next, /^build: /);
  // A committed build-args.json means the plan was approved: the gate record no longer matters.
  await writeFile(join(dir, "plan-check.json"), JSON.stringify(stalled));
  await writeFile(join(dir, "build-args.json"), JSON.stringify({ runId: "r3", waves: [] }));
  assert.equal((await nextForRun({ cwd, runId: "r3" })).position, "planned");
});

test("the main thread records every make-plan result where next reads it, and go stops on escalate", async () => {
  const read = (p) => readFile(new URL(`../plugin/${p}`, import.meta.url), "utf8");
  assert.match(await read("skills/orchestrator/SKILL.md"), /Write every\s+`muster:make-plan` result to `plan-check\.json` the moment it returns, PASS included/);
  assert.match(await read("commands/plan.md"), /Write its\s+result to `\.muster\/runs\/<runId>\/plan-check\.json`/);
  assert.match(await read("commands/go.md"), /`escalate` -> stop\)/);
});

test("next --run helpers parse the common PLAN.md and VERIFICATION.md shapes", () => {
  assert.deepEqual(planTaskIds('---\ntasks:\n  - id: T1\n  - id: "T2"\n---\ntaskId: T4\n'), ["T4", "T1", "T2"]);
  // <task> elements are authoritative: must_haves prohibitions (- id: P-01) are not tasks.
  assert.deepEqual(planTaskIds('---\nmust_haves:\n  prohibitions:\n    - id: P-01\n      criterion: x\n---\n<task id="01" wave="1">\n<task id="02" wave="2">\n'), ["01", "02"]);
  assert.equal(verificationVerdict("## Result\nverdict: abstain"), "ABSTAIN");
  assert.equal(verificationVerdict("nothing here"), null);
});

test("next --run CLI prints JSON; the manifest form of next still works", async () => {
  const cwd = await trackedMkdtemp(join(tmpdir(), "muster-next-cli-"));
  const r = cli(cwd, ["next", "--run", "r1"]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).position, "new");
  await writeFile(join(cwd, "m.json"), JSON.stringify({ plan: [{ id: "a", deps: [] }] }));
  const m = cli(cwd, ["next", "m.json"]);
  assert.equal(m.status, 0, m.stderr);
  assert.equal(cli(cwd, ["next", "--run", "../x"]).status, 1);
});

test("preflight: compact summary under 2 KB, full detail on disk, gsd detected", async () => {
  const cwd = await trackedMkdtemp(join(tmpdir(), "muster-preflight-"));
  const home = await trackedMkdtemp(join(tmpdir(), "muster-preflight-home-"));
  await mkdir(join(home, ".claude", "agents"), { recursive: true });
  await writeFile(join(home, ".claude", "agents", "gsd-planner.md"), "---\nname: gsd-planner\n---\n");
  git(cwd, "init", "-q", "-b", "main");
  const outcome = "Build a react dashboard component with tests, fix the slow sql query, and document the api ".repeat(4);

  const r = cli(cwd, ["preflight", outcome, "--json", "--run", "pf1"], { HOME: home, USERPROFILE: home });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(Buffer.byteLength(r.stdout) < 2048, `summary is ${Buffer.byteLength(r.stdout)} bytes`);
  const s = JSON.parse(r.stdout);
  assert.equal(s.runId, "pf1");
  assert.equal(s.scope, "item");
  assert.equal(s.fastPath, false);
  assert.equal(s.detected.gsd, true);
  assert.deepEqual(Object.keys(s.models), ["planner", "checker", "executor", "reviewer", "verifier"]);
  for (const m of Object.values(s.models)) assert.ok(m.model && m.effort);
  assert.equal(s.detail, ".muster/runs/pf1/preflight.json");
  // The CLI prefix agents run: absolute, so it resolves from a subagent shell without
  // CLAUDE_PLUGIN_ROOT and without muster on PATH.
  assert.match(s.cli, /^sh "(.+)\/runtime\/muster\.sh"$/);
  assert.ok(existsSync(s.cli.match(/^sh "(.+)"$/)[1]), s.cli);
  if (process.platform !== "win32") {
    const env = { ...process.env, PATH: "/usr/bin:/bin", CLAUDE_PLUGIN_ROOT: "" };
    const lint = spawnSync("sh", ["-c", `${s.cli} plan-lint missing-PLAN.md --json`], { cwd, encoding: "utf8", env: { ...env, PATH: `${dirname(process.execPath)}:${env.PATH}` } });
    assert.ok([1, 2].includes(lint.status), `the prefix reaches the CLI: ${lint.stderr}`);
    assert.doesNotMatch(lint.stderr, /not found/);
  }

  const detail = JSON.parse(await readFile(join(cwd, s.detail), "utf8"));
  assert.equal(detail.outcome, outcome);
  assert.deepEqual(detail.detected.gsd.via, ["agents"]);
  assert.ok(detail.roles.implement && Array.isArray(detail.matches));
  assert.ok(Buffer.byteLength(JSON.stringify(detail)) > Buffer.byteLength(r.stdout));

  const text = cli(cwd, ["preflight", "add a --json flag to hygiene", "--run", "pf2"], { HOME: home, USERPROFILE: home });
  assert.equal(text.status, 0, text.stderr);
  assert.ok(Buffer.byteLength(text.stdout) < 2048);
  assert.match(text.stdout, /^run pf2: scope item, .*fast-path yes\n/);
  assert.match(text.stdout, /\ndetail \.muster\/runs\/pf2\/preflight\.json\n$/);
  assert.equal(cli(cwd, ["preflight"]).status, 1);
});
