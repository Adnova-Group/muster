// Stage-2 deterministic CLI steps: preflight, merge-wave, next --run.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { trackedMkdtemp } from "../test-support/helpers.js";
import { mergeWave, isClaudeWorktree } from "../src/merge-wave.js";
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
async function repoWithTasks({ verify = {} } = {}) {
  const root = await trackedMkdtemp(join(tmpdir(), "muster-merge-wave-"));
  git(root, "init", "-q", "-b", "main");
  await writeFile(join(root, "README.md"), "base\n");
  await writeFile(join(root, ".gitignore"), ".claude/worktrees/\n");
  const waves = [["A", "B"].map((id) => ({ taskId: id, title: `task ${id}`, files: [`${id}.txt`], verify: verify[id] || [`grep -q ${id} ${id}.txt`] }))];
  await mkdir(join(root, ".muster/runs/r1"), { recursive: true });
  await writeFile(join(root, ".muster/runs/r1/build-args.json"), JSON.stringify({ runId: "r1", waves }));
  git(root, "add", ".");
  git(root, "commit", "-q", "-m", "base");
  const base = git(root, "rev-parse", "HEAD");
  const tasks = [];
  for (const id of ["A", "B"]) {
    const wt = join(root, ".claude", "worktrees", `wf_${id}`);
    git(root, "worktree", "add", "-q", "-b", `worktree-wf_${id}`, wt, base);
    await writeFile(join(wt, `${id}.txt`), `${id}\n`);
    git(wt, "add", ".");
    git(wt, "commit", "-q", "-m", `task ${id} [r1/${id}]`);
    const commit = git(wt, "rev-parse", "HEAD");
    tasks.push({
      taskId: id, title: `task ${id}`, wave: 1, status: "done", branch: `worktree-wf_${id}`, commit, worktree: wt,
      filesChanged: [`${id}.txt`], testsRun: [`grep -q ${id} ${id}.txt`], testsPassed: true, selfCheck: "PASSED", deviations: [],
      verify: [`grep -q ${id} ${id}.txt`],
      review: { taskId: id, verdict: "PASS", commitReviewed: commit, findings: [], testsRun: [], testsPassed: true },
    });
  }
  return { root, base, result: { runId: "r1", base, tasks, verification: { verdict: "PASS", truths: [], gaps: [] } } };
}

const NOW = () => new Date("2026-11-09T12:00:00Z");

test("merge-wave: merges --no-ff in plan order, re-runs planned verify, removes worktrees and branches", async () => {
  const { root, base, result } = await repoWithTasks();
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
  assert.match(await readFile(join(root, ".muster/runs/r1/SUMMARY-A.md"), "utf8"), /Recorded by `muster merge-wave`[\s\S]*verify `grep -q A A.txt`: exit 0/);
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
  assert.match(await readFile(join(root, ".muster/runs/r1/STATE.md"), "utf8"), /merge-wave: REFUSED: B: commit ffffffffff does not exist/);
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
  await assert.rejects(mergeWave({ cwd: root, runId: "nope", result, now: NOW }), /result is for run r1/);
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
  await writeFile(join(dir, "PLAN.md"), '<task id="T1">a</task>\n<task id="T2">b</task>\n');
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

test("next --run helpers parse the common PLAN.md and VERIFICATION.md shapes", () => {
  assert.deepEqual(planTaskIds('---\ntasks:\n  - id: T1\n  - id: "T2"\n---\n<task id="T3">\ntaskId: T4\n'), ["T3", "T4", "T1", "T2"]);
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
