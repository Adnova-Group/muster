// Revival stage 2b CLI additions: `build-args`, `preflight --model`, bare `next`, the
// checkpoint-aware `next --run`, and doctor's run-state check.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { trackedMkdtemp } from "../test-support/helpers.js";
import { buildArgsFromPlan, writeBuildArgs } from "../src/build-args.js";
import { nextForRun } from "../src/run-next.js";
import { runStateCheck } from "../src/doctor.js";

const CLI = fileURLToPath(new URL("../src/cli.js", import.meta.url));
const cli = (cwd, args) => spawnSync(process.execPath, [CLI, ...args], { cwd, encoding: "utf8" });

const PLAN = `---
run: r1
type: execute
autonomous: true
must_haves: [greet works]
---
<tasks>
<task id="01" type="tracer" wave="1" agent_hint="wsh-test-automator">
  <name>greet</name>
  <files>greet.js, greet.test.js</files>
  <action>implement</action>
  <verify><automated>node --test greet.test.js &amp;&amp; echo ok</automated><fails_when>non-zero exit</fails_when></verify>
  <done>x</done>
</task>
<task id="02" wave="2" depends_on="01">
  <name>farewell</name>
  <files>farewell.js</files>
  <action>implement</action>
  <verify><automated>node --test farewell.test.js</automated></verify>
  <done>x</done>
</task>
<task id="03" type="checkpoint:human-verify" wave="3"><name>look at it</name><what-built>x</what-built><how-to-verify>y</how-to-verify><resume-signal>ok</resume-signal></task>
</tasks>
`;

test("buildArgsFromPlan: waves in order, decoded verify commands, agentHint kept, checkpoints become humanNeeded", () => {
  const { args, humanNeeded, problems } = buildArgsFromPlan(PLAN, { runId: "r1", base: "abc", branch: "muster/r1", models: { executor: { model: "haiku" } } });
  assert.deepEqual(problems, []);
  assert.equal(args.runId, "r1");
  assert.equal(args.base, "abc");
  assert.equal(args.branch, "muster/r1", "executors fast-forward to the work branch tip, which carries the plan commit");
  assert.deepEqual(args.models, { executor: { model: "haiku" } });
  assert.deepEqual(args.waves.map((w) => w.map((t) => t.taskId)), [["01"], ["02"]]);
  assert.deepEqual(args.waves[0][0], {
    taskId: "01", title: "greet", files: ["greet.js", "greet.test.js"], verify: ["node --test greet.test.js && echo ok"], agentHint: "wsh-test-automator",
    // The Workflow agentType comes from the agent file's frontmatter name, not the catalog id.
    agentType: "muster:backend-development-test-automator",
  });
  assert.deepEqual(humanNeeded, [{ taskId: "03", type: "checkpoint:human-verify", title: "look at it" }]);
});

test("buildArgsFromPlan: skills become absolute SKILL.md paths; unknown skills and non-dispatchable hints never reach build", () => {
  const plan = PLAN
    .replace('agent_hint="wsh-test-automator"', 'agent_hint="wsh-test-automator" skills="sp-tdd, wsh-javascript-testing-patterns"')
    .replace('<task id="02" wave="2" depends_on="01">', '<task id="02" wave="2" depends_on="01" agent_hint="muster-reviewer">');
  const { args, problems } = buildArgsFromPlan(plan, { runId: "r1" });
  assert.deepEqual(problems, []);
  const [t1] = args.waves[0];
  assert.deepEqual(t1.skills.map((s) => s.id), ["sp-tdd", "wsh-javascript-testing-patterns"]);
  for (const s of t1.skills) {
    assert.ok(s.path.endsWith(`plugin/builtins/${s.id}/SKILL.md`.replace(/\//g, sep)), s.path);
    assert.ok(existsSync(s.path), `${s.path} exists`);
  }
  // A read-only seat keeps its hint as a lens but is not dispatched.
  assert.equal(args.waves[1][0].agentHint, "muster-reviewer");
  assert.equal(args.waves[1][0].agentType, undefined);
  const bad = buildArgsFromPlan(PLAN.replace('agent_hint="wsh-test-automator"', 'skills="no-such-skill"'), { runId: "r1" });
  assert.ok(bad.problems.some((p) => /unknown skill\(s\): no-such-skill/.test(p)), bad.problems.join("; "));
});

test("buildArgsFromPlan: missing verify, missing wave and duplicate ids are problems, never silent", () => {
  const bad = `<tasks><task id="01" wave="1"><name>a</name><files>a.js</files><verify></verify></task>
<task id="01" wave="1"><name>b</name></task><task id="02"><name>c</name></task></tasks>`;
  const { problems } = buildArgsFromPlan(bad, { runId: "r1" });
  assert.ok(problems.some((p) => /01 has no <automated> verify/.test(p)));
  assert.ok(problems.some((p) => /01 appears twice/.test(p)));
  assert.ok(problems.some((p) => /02 has no numeric wave/.test(p)));
  assert.deepEqual(buildArgsFromPlan("", { runId: "r1" }).problems, ["PLAN.md has no buildable tasks"]);
});

test("writeBuildArgs: writes build-args.json with preflight's seat models; refuses without a PLAN.md", async () => {
  const root = await trackedMkdtemp(join(tmpdir(), "muster-build-args-"));
  const missing = await writeBuildArgs({ cwd: root, runId: "r1", base: "abc" });
  assert.equal(missing.ok, false);
  await mkdir(join(root, ".muster/runs/r1"), { recursive: true });
  await writeFile(join(root, ".muster/runs/r1/PLAN.md"), PLAN);
  await writeFile(join(root, ".muster/runs/r1/preflight.json"), JSON.stringify({ models: { planner: { model: "haiku", effort: "high" } } }));
  const report = await writeBuildArgs({ cwd: root, runId: "r1", base: "abc" });
  assert.equal(report.ok, true);
  assert.deepEqual(report.waves, [["01"], ["02"]]);
  const written = JSON.parse(await readFile(join(root, ".muster/runs/r1/build-args.json"), "utf8"));
  assert.deepEqual(written.models, { planner: { model: "haiku", effort: "high" } });
  assert.equal(written.base, "abc");
});

test("build-args CLI exits 1 with problems and 0 with the report", async () => {
  const root = await trackedMkdtemp(join(tmpdir(), "muster-build-args-cli-"));
  await mkdir(join(root, ".muster/runs/r1"), { recursive: true });
  assert.equal(cli(root, ["build-args", "r1", "--base", "abc"]).status, 1);
  await writeFile(join(root, ".muster/runs/r1/PLAN.md"), PLAN);
  const ok = cli(root, ["build-args", "r1", "--base", "abc"]);
  assert.equal(ok.status, 0, ok.stderr);
  assert.equal(JSON.parse(ok.stdout).path, ".muster/runs/r1/build-args.json");
});

test("preflight --model pins every Workflow seat to one model and keeps the outcome intact", async () => {
  const root = await trackedMkdtemp(join(tmpdir(), "muster-preflight-model-"));
  const r = cli(root, ["preflight", "add", "a", "greet", "function", "--model", "haiku", "--json", "--run", "r9"]);
  assert.equal(r.status, 0, r.stderr);
  const summary = JSON.parse(r.stdout);
  assert.equal(summary.runId, "r9");
  for (const seat of ["planner", "checker", "executor", "reviewer", "verifier"]) assert.equal(summary.models[seat].model, "haiku");
  const detail = JSON.parse(await readFile(join(root, ".muster/runs/r9/preflight.json"), "utf8"));
  assert.equal(detail.outcome, "add a greet function");
});

test("next --run ignores checkpoint tasks when deciding whether every task is summarized", async () => {
  const root = await trackedMkdtemp(join(tmpdir(), "muster-next-checkpoint-"));
  await mkdir(join(root, ".muster/runs/r1"), { recursive: true });
  await writeFile(join(root, ".muster/runs/r1/PLAN.md"), PLAN);
  await writeFile(join(root, ".muster/runs/r1/SUMMARY-01.md"), "x\n");
  await writeFile(join(root, ".muster/runs/r1/SUMMARY-02.md"), "x\n");
  const report = await nextForRun({ cwd: root, runId: "r1" });
  assert.equal(report.position, "executed");
  assert.deepEqual(report.tasks.planned, ["01", "02"]);
});

test("next --run reads muster-verifier's gsd status frontmatter (passed, gaps_found, human_needed)", async () => {
  const { verificationVerdict } = await import("../src/run-next.js");
  assert.equal(verificationVerdict("---\nstatus: passed\n---"), "PASS");
  assert.equal(verificationVerdict("---\nstatus: gaps_found\n---"), "GAPS");
  assert.equal(verificationVerdict("---\nstatus: human_needed\nscore: 3/3\n---"), "HUMAN_NEEDED");
  const root = await trackedMkdtemp(join(tmpdir(), "muster-next-human-"));
  await mkdir(join(root, ".muster/runs/r1"), { recursive: true });
  await writeFile(join(root, ".muster/runs/r1/PLAN.md"), PLAN);
  for (const id of ["01", "02"]) await writeFile(join(root, `.muster/runs/r1/SUMMARY-${id}.md`), "x\n");
  await writeFile(join(root, ".muster/runs/r1/VERIFICATION.md"), "---\nstatus: human_needed\n---\n");
  assert.equal((await nextForRun({ cwd: root, runId: "r1" })).position, "human_needed");
});

test("bare next routes to the newest run directory; with no runs it fails loud", async () => {
  const root = await trackedMkdtemp(join(tmpdir(), "muster-next-bare-"));
  assert.notEqual(cli(root, ["next"]).status, 0);
  for (const id of ["20261101-old", "20261109-new"]) await mkdir(join(root, ".muster/runs", id), { recursive: true });
  const r = cli(root, ["next"]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).runId, "20261109-new");
});

test("doctor run-state: reports a leftover fence marker and legacy pre-revival files, always ok", async () => {
  const root = await trackedMkdtemp(join(tmpdir(), "muster-doctor-run-state-"));
  assert.match((await runStateCheck(root)).detail, /0 run directories, no stale markers/);
  await mkdir(join(root, ".muster/runs/r1"), { recursive: true });
  await writeFile(join(root, ".muster/run-active"), "r1\n");
  await writeFile(join(root, ".muster/manifest.json"), "{}");
  await writeFile(join(root, ".muster/STATE-archive-1.md"), "x");
  const check = await runStateCheck(root);
  assert.equal(check.ok, true);
  assert.match(check.detail, /run-active is present \(run r1\)/);
  assert.match(check.detail, /\.muster\/manifest\.json/);
  assert.match(check.detail, /STATE-archive-1\.md/);
});
