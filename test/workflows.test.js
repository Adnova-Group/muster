// Unit tests for plugin/workflows/*.js. Each script is loaded as Claude Code's Workflow
// runtime runs it: a function body with agent/parallel/pipeline/phase/log/args globals.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { CHECK_RESULT, EXEC_RESULT, PLAN_RESULT, REVIEW_RESULT, VERIFY_RESULT } from "../plugin/workflows/schemas.js";

const dir = new URL("../plugin/workflows/", import.meta.url);
const AsyncFunction = (async () => {}).constructor;

async function load(name) {
  const src = await readFile(new URL(name, dir), "utf8");
  assert.match(src, /^export const meta = \{/, `${name} must start with export const meta`);
  return new AsyncFunction("agent", "parallel", "pipeline", "phase", "log", "args", src.replace(/^export const meta =/, "const meta ="));
}

// Mirrors the runtime: parallel() and pipeline() turn a thrown stage into null.
const parallel = (thunks) => Promise.all(thunks.map((t) => t().catch(() => null)));
const pipeline = (items, ...stages) => Promise.all(items.map(async (item, i) => {
  try {
    let v = item;
    for (const s of stages) v = await s(v, item, i);
    return v;
  } catch { return null; }
}));

async function run(name, args, respond) {
  const fn = await load(name);
  const calls = [];
  const logs = [];
  const agent = async (prompt, opts) => {
    calls.push({ prompt, opts });
    return respond(opts.label, prompt, opts, calls);
  };
  const result = await fn(agent, parallel, pipeline, () => {}, (m) => logs.push(m), args);
  return { result, calls, logs };
}

const exec = (taskId, n = 1, over = {}) => ({
  taskId, status: "done", branch: `worktree-wf_${taskId}`, commit: `${taskId.toLowerCase()}${"0".repeat(39)}${n}`,
  worktree: `/repo/.claude/worktrees/wf_${taskId}`, filesChanged: [`${taskId}.js`], testsRun: [`node --test ${taskId}.test.js`],
  testsPassed: true, selfCheck: "PASSED", deviations: [], ...over,
});
const review = (taskId, verdict, commitReviewed, findings = []) => ({
  taskId, verdict, commitReviewed, findings, testsRun: ["npm test"], testsPassed: verdict === "PASS",
});
const verifyPass = { verdict: "PASS", truths: [{ claim: "works", status: "VERIFIED", evidence: "npm test" }], gaps: [] };

const task = (taskId, extra = {}) => ({ taskId, title: `task ${taskId}`, agentHint: "wsh-test-automator", files: [`${taskId}.js`], verify: [`node --test ${taskId}.test.js`], ...extra });
const MODELS = { executor: { model: "haiku", effort: "low" }, reviewer: { model: "haiku", effort: "medium" }, verifier: { model: "sonnet", effort: "high" } };

// Default responder: every build/fix succeeds, every review passes the commit it was shown.
function happy(label, prompt) {
  const [kind, id] = label.split(" ");
  if (kind === "build") return exec(id);
  if (kind === "fix") return exec(id, 2);
  if (kind === "review") return review(id, "PASS", prompt.match(/must be (\S+)\)/)[1]);
  if (kind === "verify") return verifyPass;
  throw new Error(`unexpected label ${label}`);
}

test("build: happy path across two waves, schemas, agent types, isolation and model passthrough", async () => {
  const args = { runId: "r1", base: "base123", models: MODELS, waves: [[task("A"), task("B")], [task("C")]] };
  const { result, calls } = await run("build.js", args, happy);

  assert.equal(result.runId, "r1");
  assert.equal(result.halted, null);
  assert.deepEqual(result.tasks.map((t) => [t.taskId, t.wave, t.status, t.review.verdict]), [["A", 1, "done", "PASS"], ["B", 1, "done", "PASS"], ["C", 2, "done", "PASS"]]);
  assert.deepEqual(result.tasks[0].verify, ["node --test A.test.js"]);
  assert.equal(result.verification.verdict, "PASS");

  const builds = calls.filter((c) => c.opts.label.startsWith("build "));
  for (const b of builds) {
    assert.equal(b.opts.isolation, "worktree");
    assert.equal(b.opts.agentType, "muster:muster-executor");
    assert.deepEqual(b.opts.schema, EXEC_RESULT);
    assert.equal(b.opts.model, "haiku");
    assert.equal(b.opts.effort, "low");
    assert.match(b.prompt, /Check git state first/);
    assert.match(b.prompt, /merge-base --is-ancestor base123 HEAD/);
  }
  // Wave 2 integrates wave 1's reviewed commits before building.
  const buildC = builds.find((b) => b.opts.label === "build C").prompt;
  assert.match(buildC, new RegExp(`${exec("A").commit} ${exec("B").commit}`));
  assert.match(builds.find((b) => b.opts.label === "build A").prompt, /first wave: nothing to integrate/);

  const reviews = calls.filter((c) => c.opts.label.startsWith("review "));
  assert.equal(reviews.length, 3);
  for (const r of reviews) {
    assert.equal(r.opts.agentType, "muster:muster-reviewer");
    assert.deepEqual(r.opts.schema, REVIEW_RESULT);
    assert.equal(r.opts.isolation, undefined);
    assert.equal(r.opts.effort, "medium");
  }
  const verify = calls.find((c) => c.opts.label.startsWith("verify "));
  assert.equal(verify.opts.agentType, "muster:muster-verifier");
  assert.deepEqual(verify.opts.schema, VERIFY_RESULT);
  assert.equal(verify.opts.model, "sonnet");
  assert.equal(calls.filter((c) => c.opts.label.startsWith("verify ")).length, 1, "verifier runs once per run");
});

test("build: unset models are omitted so agents inherit the session model", async () => {
  const { calls } = await run("build.js", { runId: "r1", waves: [[task("A")]] }, happy);
  for (const c of calls) {
    assert.equal("model" in c.opts, false);
    assert.equal("effort" in c.opts, false);
  }
});

test("build: review FAIL -> fixer in the builder's worktree -> PASS", async () => {
  let reviewsOfA = 0;
  const { result, calls } = await run("build.js", { runId: "r2", waves: [[task("A")]] }, (label, prompt, opts) => {
    if (label === "review A r0") {
      reviewsOfA++;
      return review("A", "FAIL", exec("A").commit, [{ severity: "blocker", file: "A.js", line: 3, summary: "missing guard" }]);
    }
    if (label === "review A r1") reviewsOfA++;
    return happy(label, prompt, opts);
  });
  const a = result.tasks[0];
  assert.equal(reviewsOfA, 2);
  assert.equal(a.review.verdict, "PASS");
  assert.equal(a.fixRounds, 1);
  assert.equal(a.commit, exec("A", 2).commit, "the fixer's commit becomes the task commit");
  assert.equal(a.branch, exec("A").branch);
  assert.equal(a.worktree, exec("A").worktree);

  const fix = calls.find((c) => c.opts.label === "fix A r1");
  assert.equal(fix.opts.isolation, undefined, "fixers reuse the builder's worktree, never a fresh one");
  assert.equal(fix.opts.agentType, "muster:muster-executor");
  assert.match(fix.prompt, new RegExp(`cd ${exec("A").worktree} &&`));
  assert.match(fix.prompt, /blocker A\.js:3: missing guard/);
  assert.match(fix.prompt, /Check git state first/);
  // The second review is shown the fixer's commit.
  assert.match(calls.find((c) => c.opts.label === "review A r1").prompt, new RegExp(`must be ${exec("A", 2).commit}`));
});

test("build: review cap exhaustion stops after 2 fixes, halts later waves, skips the verifier", async () => {
  const { result, calls } = await run("build.js", { runId: "r3", waves: [[task("A")], [task("B")]] }, (label, prompt, opts) => {
    if (label.startsWith("review A")) return review("A", "FAIL", "x", [{ severity: "blocker", file: "A.js", summary: "still wrong" }]);
    return happy(label, prompt, opts);
  });
  assert.equal(calls.filter((c) => c.opts.label.startsWith("review A")).length, 3);
  assert.equal(calls.filter((c) => c.opts.label.startsWith("fix A")).length, 2);
  assert.equal(result.tasks[0].review.verdict, "FAIL");
  assert.equal(result.tasks[0].fixRounds, 2);
  assert.match(result.halted, /wave 1 did not pass \(A\)/);
  assert.equal(result.tasks[1].taskId, "B");
  assert.equal(result.tasks[1].status, "blocked");
  assert.equal(calls.some((c) => c.opts.label === "build B"), false, "later waves never start");
  assert.equal(calls.some((c) => c.opts.label.startsWith("verify")), false);
  assert.equal(result.verification.verdict, "ABSTAIN");
});

test("build: a schema failure on one task records status error without killing the run", async () => {
  const { result, logs } = await run("build.js", { runId: "r4", waves: [[task("A"), task("B")]] }, (label, prompt, opts) => {
    if (label === "build B") throw new Error("StructuredOutput retry cap (2) exceeded");
    return happy(label, prompt, opts);
  });
  const [a, b] = result.tasks;
  assert.equal(a.status, "done");
  assert.equal(a.review.verdict, "PASS");
  assert.equal(b.status, "error");
  assert.match(b.deviations[0], /retry cap/);
  assert.equal(b.review, null);
  assert.ok(logs.some((l) => /build B failed/.test(l)));
  assert.equal(result.verification.verdict, "ABSTAIN");
});

test("build: a null agent result (skipped agent) is an error, a reviewer crash is a non-PASS review", async () => {
  const { result } = await run("build.js", { runId: "r5", waves: [[task("A"), task("B")]] }, (label, prompt, opts) => {
    if (label === "build A") return null;
    if (label === "review B r0") throw new Error("boom");
    return happy(label, prompt, opts);
  });
  assert.equal(result.tasks[0].status, "error");
  assert.equal(result.tasks[1].review.status, "error");
  assert.notEqual(result.tasks[1].review.verdict, "PASS");
});

test("build: self-check FAILED skips review; ABSTAIN review does not trigger a fixer", async () => {
  const { result, calls } = await run("build.js", { runId: "r6", waves: [[task("A"), task("B")]] }, (label, prompt, opts) => {
    if (label === "build A") return exec("A", 1, { selfCheck: "FAILED" });
    if (label === "review B r0") return review("B", "ABSTAIN", exec("B").commit);
    return happy(label, prompt, opts);
  });
  assert.equal(calls.some((c) => c.opts.label === "review A r0"), false);
  assert.equal(calls.some((c) => c.opts.label.startsWith("fix B")), false);
  assert.equal(result.tasks[1].review.verdict, "ABSTAIN");
});

test("build: string args are parsed; junk args return an error instead of throwing", async () => {
  const args = JSON.stringify({ runId: "r7", waves: [[task("A")]] });
  const { result } = await run("build.js", args, happy);
  assert.equal(result.tasks[0].review.verdict, "PASS");

  for (const junk of ["build the thing", "", undefined, "[1,2]"]) {
    const { result: r, calls } = await run("build.js", junk, happy);
    assert.equal(r.status, "error");
    assert.equal(calls.length, 0);
  }
});

const checkIssues = (n) => ({ verdict: "ISSUES", issues: Array.from({ length: n }, (_, i) => ({ dimension: "verify", severity: "blocker", required_property: "verify", summary: `issue ${i}` })) });
const planned = { status: "done", planPath: ".muster/runs/p/PLAN.md", taskCount: 2, summary: "ok" };

test("plan: PASS on first check", async () => {
  const args = { runId: "p1", outcome: "add a flag", contextPath: ".muster/runs/p1/CONTEXT.md", candidates: ["wsh-test-automator"], models: { planner: { model: "opus", effort: "high" }, checker: { model: "sonnet" } } };
  const { result, calls } = await run("plan.js", args, (label) => (label.startsWith("plan") ? planned : { verdict: "PASS", issues: [] }));
  assert.deepEqual(result, { runId: "p1", planPath: ".muster/runs/p1/PLAN.md", verdict: "PASS", revisions: 0, issues: [], escalated: null });
  const [p, c] = calls;
  assert.equal(p.opts.agentType, "muster:muster-planner");
  assert.deepEqual(p.opts.schema, PLAN_RESULT);
  assert.equal(p.opts.model, "opus");
  assert.match(p.prompt, /CONTEXT\.md/);
  assert.match(p.prompt, /wsh-test-automator/);
  assert.equal(c.opts.agentType, "muster:muster-plan-checker");
  assert.deepEqual(c.opts.schema, CHECK_RESULT);
  assert.match(c.prompt, /muster plan-lint \.muster\/runs\/p1\/PLAN\.md/);
});

test("plan: revises while the issue count falls, then passes", async () => {
  const counts = [3, 1];
  const { result, calls } = await run("plan.js", { runId: "p2", outcome: "x" }, (label) => {
    if (label.startsWith("plan")) return planned;
    const n = counts.shift();
    return n === undefined ? { verdict: "PASS", issues: [] } : checkIssues(n);
  });
  assert.equal(result.verdict, "PASS");
  assert.equal(result.revisions, 2);
  const revision = calls.find((c) => c.opts.label === "plan r1");
  assert.match(revision.prompt, /Revision 1 of 3/);
  assert.match(revision.prompt, /issue 2/);
});

test("plan: escalates when the issue count stops falling", async () => {
  const counts = [2, 2];
  const { result } = await run("plan.js", { runId: "p3", outcome: "x" }, (label) => (label.startsWith("plan") ? planned : checkIssues(counts.shift())));
  assert.equal(result.verdict, "ISSUES");
  assert.equal(result.escalated, "stall");
  assert.equal(result.revisions, 1);
  assert.equal(result.issues.length, 2);
});

test("plan: escalates at the revision cap of 3", async () => {
  const counts = [9, 7, 5, 3];
  const { result, calls } = await run("plan.js", { runId: "p4", outcome: "x" }, (label) => (label.startsWith("plan") ? planned : checkIssues(counts.shift())));
  assert.equal(result.escalated, "cap");
  assert.equal(result.revisions, 3);
  assert.equal(calls.filter((c) => c.opts.label.startsWith("plan")).length, 4);
  assert.equal(calls.filter((c) => c.opts.label.startsWith("check")).length, 4);
});

test("plan: a checker schema failure becomes verdict ERROR, not a crash", async () => {
  const { result } = await run("plan.js", { runId: "p5", outcome: "x" }, (label) => {
    if (label.startsWith("plan")) return planned;
    throw new Error("StructuredOutput retry cap (2) exceeded");
  });
  assert.equal(result.verdict, "ERROR");
  assert.equal(result.escalated, "checker");
});

test("plan: a plain string arg is the outcome, and the runId is derived from it", async () => {
  const { result, calls } = await run("plan.js", "Add a --json flag to hygiene", (label) => (label.startsWith("plan") ? planned : { verdict: "PASS", issues: [] }));
  assert.equal(result.runId, "add-a-json-flag-to-hygiene");
  assert.match(calls[0].prompt, /Outcome: Add a --json flag to hygiene/);
  const { result: r } = await run("plan.js", "", () => planned);
  assert.equal(r.status, "error");
});

test("backlog: items run sequentially through the build stages with prefixed labels", async () => {
  const order = [];
  const args = { models: MODELS, items: [{ itemId: "I1", runId: "ra", waves: [[task("A")]] }, { itemId: "I2", runId: "rb", waves: [[task("A")]] }, { itemId: "bad" }] };
  const { result } = await run("backlog.js", args, (label, prompt, opts) => {
    order.push(label);
    return happy(label.split(" ").slice(1).join(" "), prompt, opts);
  });
  assert.deepEqual(result.items.map((i) => [i.itemId, i.runId, i.status]), [["I1", "ra", undefined], ["I2", "rb", undefined], ["bad", undefined, "error"]]);
  assert.equal(result.items[0].tasks[0].review.verdict, "PASS");
  assert.equal(result.items[1].verification.verdict, "PASS");
  assert.deepEqual(order, ["I1 build A", "I1 review A r0", "I1 verify ra", "I2 build A", "I2 review A r0", "I2 verify rb"]);
});

test("backlog: string args and an empty item list", async () => {
  const { result } = await run("backlog.js", JSON.stringify({ items: [{ itemId: "I1", runId: "ra", waves: [[task("A")]] }] }), (label, prompt, opts) => happy(label.split(" ").slice(1).join(" "), prompt, opts));
  assert.equal(result.items[0].tasks[0].status, "done");
  const { result: empty } = await run("backlog.js", "{}", happy);
  assert.equal(empty.status, "error");
});

test("backlog.js inlines build.js's shared stages byte for byte", async () => {
  const block = (s) => s.slice(s.indexOf("// <shared>"), s.indexOf("// </shared>"));
  const [build, backlog] = await Promise.all(["build.js", "backlog.js"].map((f) => readFile(new URL(f, dir), "utf8")));
  assert.ok(block(build).length > 1000);
  assert.equal(block(backlog), block(build));
});

test("workflow scripts have a literal meta with name, description and matching phase titles", async () => {
  for (const [file, name] of [["plan.js", "plan"], ["build.js", "build"], ["backlog.js", "backlog"]]) {
    const src = await readFile(new URL(file, dir), "utf8");
    const meta = src.slice(0, src.indexOf("\n}\n") + 2);
    assert.match(meta, new RegExp(`name: '${name}'`));
    assert.match(meta, /description: '/);
    assert.doesNotMatch(meta, /\$\{|\.\.\./, "meta must be a pure literal");
    assert.doesNotMatch(src, /Date\.now\(\)|Math\.random\(\)|new Date\(\)/, "non-deterministic calls break resume");
    for (const [, phase] of src.matchAll(/phase: '([A-Za-z]+)'/g)) assert.match(meta, new RegExp(`title: '${phase}'`), `${file}: phase ${phase} missing from meta`);
  }
  const schemas = await readFile(new URL("schemas.js", dir), "utf8");
  assert.doesNotMatch(schemas, /export const meta/, "schemas.js must not register as a workflow");
});
