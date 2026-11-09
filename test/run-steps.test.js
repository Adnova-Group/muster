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

// A repo with two task branches in kept worktrees, as build.js leaves them.
async function repoWithTasks() {
  const root = await trackedMkdtemp(join(tmpdir(), "muster-merge-wave-"));
  git(root, "init", "-q", "-b", "main");
  await writeFile(join(root, "README.md"), "base\n");
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
      filesChanged: [`${id}.txt`], testsRun: [`test -f ${id}.txt`], testsPassed: true, selfCheck: "PASSED", deviations: [],
      verify: [`grep -q ${id} ${id}.txt`],
      review: { taskId: id, verdict: "PASS", commitReviewed: commit, findings: [], testsRun: [], testsPassed: true },
    });
  }
  return { root, base, result: { runId: "r1", base, tasks, verification: { verdict: "PASS", truths: [], gaps: [] } } };
}

const NOW = () => new Date("2026-11-09T12:00:00Z");

test("merge-wave: merges --no-ff in manifest order, re-runs verify, removes worktrees and branches", async () => {
  const { root, base, result } = await repoWithTasks();
  const report = await mergeWave({ cwd: root, runId: "r1", result, now: NOW });
  assert.equal(report.ok, true, JSON.stringify(report.problems));
  assert.deepEqual(report.merged.map((m) => [m.taskId, m.commands, m.passed]), [["A", 2, 2], ["B", 2, 2]]);
  assert.deepEqual(git(root, "log", "--first-parent", "--format=%s", `${base}..HEAD`).split("\n"), ["merge(r1): B task B", "merge(r1): A task A"]);
  assert.equal(git(root, "rev-list", "--merges", "--count", `${base}..HEAD`), "2");
  assert.ok(existsSync(join(root, "A.txt")) && existsSync(join(root, "B.txt")));
  assert.equal(hasBranch(root, "worktree-wf_A") || hasBranch(root, "worktree-wf_B"), false);
  assert.equal(git(root, "worktree", "list").split("\n").length, 1);
  const state = await readFile(join(root, ".muster/runs/r1/STATE.md"), "utf8");
  assert.match(state, /## Log\n- 2026-11-09T12:00:00.000Z merge-wave: merged A [0-9a-f]{10} as [0-9a-f]{10}; verify 2\/2 passed\n- .* merged B /);
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

test("merge-wave: a failing verify rolls every merge back and keeps the worktrees", async () => {
  const { root, base, result } = await repoWithTasks();
  result.tasks[1].verify = ["test -f does-not-exist.txt"];
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
