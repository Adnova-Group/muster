// F15 (docs/research/2026-11-claude-code-findings.md): a subagent stopped at its maxTurns must
// never read as done or PASS. A Workflow agent() result carries no stop reason (2.1.319): a
// schema-bound agent that ends without calling StructuredOutput throws, and a schema-valid
// partial result is caught by the evidence checks. Every workflow records such a result as
// {status:"error", reason:"max_turns"}, retries a seat that works in place once, and never
// retries an isolated builder. Scripts load as the Workflow runtime runs them.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const dir = new URL("../plugin/workflows/", import.meta.url);
const AsyncFunction = (async () => {}).constructor;

async function load(name) {
  const src = await readFile(new URL(name, dir), "utf8");
  return new AsyncFunction("agent", "parallel", "pipeline", "phase", "log", "args", src.replace(/^export const meta =/, "const meta ="));
}
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
  return { result, calls, logs, labels: calls.map((c) => c.opts.label) };
}

// What the runtime throws when a schema-bound subagent stops (at its maxTurns) before calling StructuredOutput.
const TURN_LIMIT = "agent({schema}): subagent completed without calling StructuredOutput (after in-conversation nudge)";
const turnLimited = () => { throw new Error(TURN_LIMIT); };

const sha = (id, n) => `${id.toLowerCase()}${"0".repeat(39)}${n}`;
const exec = (taskId, n = 1, over = {}) => ({
  taskId, status: "done", branch: `worktree-wf_${taskId}`, commit: sha(taskId, n), worktree: `/repo/.claude/worktrees/wf_${taskId}`,
  filesChanged: [`${taskId}.js`], testsRun: [`node --test ${taskId}.test.js`], testsPassed: true, selfCheck: "PASSED", deviations: [], ...over,
});
const review = (taskId, verdict, commitReviewed, over = {}) => ({ taskId, verdict, commitReviewed, findings: [], testsRun: ["npm test"], testsPassed: verdict === "PASS", ...over });
const mustBe = (prompt) => (prompt.match(/must be (\S+)\)/) || prompt.match(/commitReviewed to (\S+)\./))[1];
const verifyPass = { verdict: "PASS", truths: [{ claim: "works", status: "VERIFIED", evidence: "npm test" }], gaps: [] };
const red = (taskId, over = {}) => ({
  taskId, status: "done", branch: `worktree-wf_${taskId}`, commit: sha(taskId, 0), worktree: `/repo/.claude/worktrees/wf_${taskId}`,
  testFiles: [`test/${taskId}.test.js`], testsRun: [`node --test test/${taskId}.test.js`], failingAsExpected: true, failures: [{ test: "t", reason: "r" }], deviations: [], ...over,
});
const task = (taskId, extra = {}) => ({ taskId, title: `task ${taskId}`, files: [`${taskId}.js`], verify: [`node --test ${taskId}.test.js`], ...extra });

function happy(label, prompt) {
  const [kind, a, b] = label.split(" ");
  if (kind === "red") return red(a);
  if (kind === "build") return exec(a);
  if (kind === "fix") return exec(a, 2);
  if (kind === "review") return review(a, "PASS", mustBe(prompt));
  if (kind === "seat") return review(b, "PASS", mustBe(prompt));
  if (kind === "integrate") return { verdict: "PASS", commitsChecked: ["x"], findings: [], testsRun: ["npm test"], testsPassed: true };
  if (kind === "verify") return verifyPass;
  throw new Error(`unexpected label ${label}`);
}

// ---- build / backlog / team ----------------------------------------------------------------

for (const name of ["build.js", "team.js"]) {
  test(`${name}: a turn-limited builder is status error with reason max_turns, never retried in a fresh worktree, and halts the run`, async () => {
    const { result, labels } = await run(name, { runId: "r1", waves: [[task("A")], [task("B")]] }, (label, prompt, opts) => {
      if (label === "build A") return turnLimited();
      return happy(label, prompt, opts);
    });
    const a = result.tasks[0];
    assert.equal(a.status, "error");
    assert.equal(a.reason, "max_turns");
    assert.match(a.deviations[0], /without calling StructuredOutput/);
    assert.equal(labels.filter((l) => l.startsWith("build A")).length, 1, "an isolated builder is not retried");
    assert.match(result.halted, /wave 1 did not pass \(A\)/);
    assert.equal(result.verification.verdict, "ABSTAIN");
  });

  test(`${name}: a verification-only task (done, real commit, no files changed) is reviewed, not read as max_turns`, async () => {
    // Live e2e 2026-11-10: a task covering only an invariant committed --allow-empty with
    // filesChanged [] and was wiped as a turn-limited partial result, halting the wave.
    const { result, labels } = await run(name, { runId: "r1", waves: [[task("A")]] }, (label, prompt, opts) => (label === "build A" ? exec("A", 1, { filesChanged: [] }) : happy(label, prompt, opts)));
    const a = result.tasks[0];
    assert.equal(a.status, "done");
    assert.notEqual(a.reason, "max_turns");
    assert.ok(labels.some((l) => l.startsWith("review")), "the task is reviewed");
  });

  test(`${name}: a schema-valid "done" with empty evidence (a partial result) is never reviewed or passed`, async () => {
    for (const over of [{ commit: "" }, { commit: "HEAD" }, { testsRun: [] }, { branch: "" }, { worktree: " " }]) {
      const { result, labels } = await run(name, { runId: "r1", waves: [[task("A")]] }, (label, prompt, opts) => (label === "build A" ? exec("A", 1, over) : happy(label, prompt, opts)));
      const a = result.tasks[0];
      assert.equal(a.status, "error", JSON.stringify(over));
      assert.equal(a.reason, "max_turns");
      assert.equal(labels.some((l) => l.startsWith("review")), false, "a partial build is not reviewed");
      assert.equal(result.verification.verdict, "ABSTAIN");
    }
  });

  test(`${name}: a turn-limited reviewer is retried once in place; a second turn limit is an error, never PASS`, async () => {
    // Retry succeeds.
    const ok = await run(name, { runId: "r1", waves: [[task("A")]] }, (label, prompt, opts) => (label === "review A r0" ? turnLimited() : happy(label, prompt, opts)));
    assert.deepEqual(ok.labels.filter((l) => l.startsWith("review A")), ["review A r0", "review A r0 retry"]);
    assert.equal(ok.result.tasks[0].review.verdict, "PASS");
    assert.equal(ok.result.halted, null);
    // Retry hits the limit too (here: a PASS with no tests run and no reviewed commit).
    const bad = await run(name, { runId: "r1", waves: [[task("A")]] }, (label, prompt, opts) => {
      if (label === "review A r0") return turnLimited();
      if (label === "review A r0 retry") return review("A", "PASS", "", { testsRun: [] });
      return happy(label, prompt, opts);
    });
    const a = bad.result.tasks[0];
    assert.equal(a.review.status, "error");
    assert.equal(a.review.reason, "max_turns");
    assert.notEqual(a.review.verdict, "PASS");
    assert.equal(bad.labels.filter((l) => l.startsWith("review A")).length, 2, "retried exactly once");
    assert.match(bad.result.halted, /did not pass/);
  });

  test(`${name}: a fixer that hits its turn limit is retried once in the builder's worktree`, async () => {
    let reviews = 0;
    const { result, calls } = await run(name, { runId: "r1", waves: [[task("A")]] }, (label, prompt, opts) => {
      if (label.startsWith("review A")) return ++reviews === 1 ? review("A", "FAIL", mustBe(prompt), { findings: [{ severity: "blocker", file: "A.js", summary: "bug" }] }) : happy(label, prompt, opts);
      if (label === "fix A r1") return turnLimited();
      return happy(label, prompt, opts);
    });
    const retry = calls.find((c) => c.opts.label === "fix A r1 retry");
    assert.ok(retry, "the fixer is retried");
    assert.equal(retry.opts.isolation, undefined);
    assert.equal(retry.prompt, calls.find((c) => c.opts.label === "fix A r1").prompt, "the same idempotent brief");
    assert.equal(result.tasks[0].review.verdict, "PASS");
  });

  test(`${name}: a verifier PASS without evidence is retried, then recorded as ABSTAIN with reason max_turns`, async () => {
    const { result, labels } = await run(name, { runId: "r1", waves: [[task("A")]] }, (label, prompt, opts) => {
      if (label.startsWith("verify")) return { verdict: "PASS", truths: [{ claim: "works", status: "VERIFIED", evidence: "" }], gaps: [] };
      return happy(label, prompt, opts);
    });
    assert.deepEqual(labels.filter((l) => l.startsWith("verify")), ["verify r1", "verify r1 retry"]);
    assert.equal(result.verification.verdict, "ABSTAIN");
    assert.equal(result.verification.reason, "max_turns");
  });

  test(`${name}: other agent errors are not retried and keep their own reason`, async () => {
    const { result, labels } = await run(name, { runId: "r1", waves: [[task("A")]] }, (label, prompt, opts) => {
      if (label === "review A r0") throw new Error("StructuredOutput retry cap (2) exceeded");
      return happy(label, prompt, opts);
    });
    assert.equal(labels.filter((l) => l.startsWith("review A")).length, 1);
    assert.equal(result.tasks[0].review.reason, "agent_error");
    const skipped = await run(name, { runId: "r1", waves: [[task("A")]] }, (label, prompt, opts) => (label === "build A" ? null : happy(label, prompt, opts)));
    assert.equal(skipped.result.tasks[0].reason, "no_result");
  });
}

test("backlog.js: a turn-limited builder inside an item is an error with reason max_turns", async () => {
  const { result } = await run("backlog.js", { items: [{ itemId: "I1", runId: "ra", waves: [[task("A")]] }] }, (label, prompt, opts) => {
    if (label === "I1 build A") return turnLimited();
    return happy(label.split(" ").slice(1).join(" "), prompt, opts);
  });
  assert.equal(result.items[0].tasks[0].reason, "max_turns");
  assert.equal(result.items[0].verification.verdict, "ABSTAIN");
});

test("team.js: a red phase with no test files is a partial result; a seat PASS needs only its reviewed commit", async () => {
  const { result } = await run("team.js", { runId: "r1", waves: [[task("A", { tdd: true })]] }, (label, prompt, opts) => (label === "red A" ? red("A", { testFiles: [] }) : happy(label, prompt, opts)));
  assert.equal(result.tasks[0].status, "error");
  assert.equal(result.tasks[0].reason, "max_turns");
  // Seats do not run the verify commands, so an empty testsRun on a seat PASS is fine.
  const seated = await run("team.js", { runId: "r1", waves: [[task("A", { reviewSeats: ["security"] })]] }, (label, prompt, opts) => (label.startsWith("seat") ? review("A", "PASS", mustBe(prompt), { testsRun: [] }) : happy(label, prompt, opts)));
  assert.equal(seated.result.tasks[0].seats[0].verdict, "PASS");
  assert.equal(seated.labels.some((l) => l.endsWith("retry")), false);
});

test("team.js: an integration PASS that ran no tests is retried, never counted as PASS", async () => {
  const { result, labels } = await run("team.js", { runId: "r1", waves: [[task("A"), task("B")]] }, (label, prompt, opts) => {
    if (label.startsWith("integrate w1")) return { verdict: "PASS", commitsChecked: [], findings: [], testsRun: [], testsPassed: true };
    return happy(label, prompt, opts);
  });
  assert.deepEqual(labels.filter((l) => l.startsWith("integrate w1")), ["integrate w1 r0", "integrate w1 r0 retry"]);
  assert.notEqual(result.integration[0].verdict, "PASS");
});

// ---- make-plan -------------------------------------------------------------------------------

const planned = { status: "done", planPath: ".muster/runs/p/PLAN.md", taskCount: 2, summary: "ok" };

test("make-plan.js: a turn-limited checker is retried once; twice is verdict ERROR with reason max_turns", async () => {
  const once = await run("make-plan.js", { runId: "p1", outcome: "x" }, (label) => (label.startsWith("plan") ? planned : label === "check r0" ? turnLimited() : { verdict: "PASS", issues: [] }));
  assert.deepEqual(once.labels, ["plan r0", "check r0", "check r0 retry"]);
  assert.equal(once.result.verdict, "PASS");
  const twice = await run("make-plan.js", { runId: "p1", outcome: "x" }, (label) => (label.startsWith("plan") ? planned : turnLimited()));
  assert.equal(twice.result.verdict, "ERROR");
  assert.equal(twice.result.escalated, "checker");
  assert.equal(twice.result.reason, "max_turns");
});

test("make-plan.js: a planner 'done' with no tasks is a partial plan, never checked", async () => {
  const { result, labels } = await run("make-plan.js", { runId: "p1", outcome: "x" }, (label) => (label.startsWith("plan") ? { ...planned, taskCount: 0 } : { verdict: "PASS", issues: [] }));
  assert.deepEqual(labels, ["plan r0", "plan r0 retry"]);
  assert.equal(result.verdict, "ERROR");
  assert.equal(result.escalated, "planner");
  assert.equal(result.reason, "max_turns");
});

// ---- debug -----------------------------------------------------------------------------------

test("debug.js: a CONFIRMED verdict without evidence is retried and never arbitrated as the root cause", async () => {
  const hyp = (id, over = {}) => ({ hypothesisId: id, status: "CONFIRMED", confidence: "high", evidence: [{ file: "a.js", line: 1, claim: "c", supports: true }], causalChain: "x -> y", reproduction: "npm test", suggestedFix: "f", ...over });
  const { result, labels } = await run("debug.js", { symptom: "crash", hypotheses: ["H one", "H two"] }, (label) => {
    if (label.startsWith("investigate H1")) return hyp("H1", { evidence: [] });
    if (label === "investigate H2") return hyp("H2", { status: "FALSIFIED", confidence: "medium" });
    throw new Error(`unexpected ${label}`);
  });
  assert.deepEqual(labels.filter((l) => l.startsWith("investigate H1")), ["investigate H1", "investigate H1 retry"]);
  const h1 = result.investigations.find((r) => r.hypothesisId === "H1");
  assert.equal(h1.status, "error");
  assert.equal(h1.reason, "max_turns");
  assert.equal(result.verdict, "INCONCLUSIVE");
});

// ---- pipeline --------------------------------------------------------------------------------

test("pipeline.js: a phase 'done' that wrote nothing is retried, then halts the run as ERROR", async () => {
  const args = { runId: "c1", outcome: "o", pipeline: { id: "blog-post", gate: { criteria: [], floor: 0, pass_total: 0 } }, phases: [{ id: "draft", role: "author", desc: "d", skills: [] }], artifactPath: ".muster/runs/c1/a.md" };
  const { result, labels } = await run("pipeline.js", args, () => ({ phase: "draft", status: "done", wrote: [], summary: "s" }));
  assert.deepEqual(labels, ["draft", "draft retry"]);
  assert.equal(result.verdict, "ERROR");
  assert.equal(result.phases[0].status, "error");
});

// ---- book ------------------------------------------------------------------------------------

test("book.js: an outline 'done' with no chapters is a partial result, retried once, then no outline", async () => {
  const outline = (chapters) => ({ status: "done", title: "T", kind: "fiction", premise: "p", voice: { pov: "first", tense: "past" }, chapters, canon: [], summary: "s" });
  const { result, labels } = await run("book.js", { runId: "b1", mode: "outline", brief: "a book" }, (label) => (label.startsWith("outline v1") ? outline([]) : { verdict: "PASS", score: 9, issues: [] }));
  assert.deepEqual(labels, ["outline v1", "outline v1 retry"]);
  assert.equal(result.status, "error");
  assert.match(result.error, /max_turns/);
});
