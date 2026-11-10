// Unit tests for the dev-team topologies (plugin/workflows/team.js, debug.js;
// docs/strategy/dev-team-topologies.md). Scripts load as Claude Code's Workflow runtime runs
// them: a function body with agent/parallel/pipeline/phase/log/args globals.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import * as S from "../plugin/workflows/schemas.js";
import { buildArgsFromPlan } from "../src/build-args.js";
import { specialistCatalog, WORKFLOW_SEATS } from "../src/specialists.js";

const dir = new URL("../plugin/workflows/", import.meta.url);
const AsyncFunction = (async () => {}).constructor;
const source = (name) => readFile(new URL(name, dir), "utf8");

async function load(name) {
  const src = await source(name);
  assert.match(src, /^export const meta = \{/, `${name} must start with export const meta`);
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
  return { result, calls, logs };
}

const sha = (id, n) => `${id.toLowerCase()}${"0".repeat(39)}${n}`;
const exec = (taskId, n = 1, over = {}) => ({
  taskId, status: "done", branch: `worktree-wf_${taskId}`, commit: sha(taskId, n), worktree: `/repo/.claude/worktrees/wf_${taskId}`,
  filesChanged: [`src/${taskId}.js`], testsRun: [`node --test ${taskId}.test.js`], testsPassed: true, selfCheck: "PASSED", deviations: [], ...over,
});
const red = (taskId, over = {}) => ({
  taskId, status: "done", branch: `worktree-wf_${taskId}`, commit: sha(taskId, 0), worktree: `/repo/.claude/worktrees/wf_${taskId}`,
  testFiles: [`test/${taskId}.test.js`], testsRun: [`node --test test/${taskId}.test.js`], failingAsExpected: true,
  failures: [{ test: "rejects bad input", reason: "TypeError: x is not a function" }], deviations: [], ...over,
});
const review = (taskId, verdict, commitReviewed, findings = []) => ({ taskId, verdict, commitReviewed, findings, testsRun: ["npm test"], testsPassed: verdict === "PASS" });
const mustBe = (prompt) => (prompt.match(/must be (\S+)\)/) || prompt.match(/commitReviewed to (\S+)\./))[1];
const verifyPass = { verdict: "PASS", truths: [{ claim: "works", status: "VERIFIED", evidence: "npm test" }], gaps: [] };
const integPass = { verdict: "PASS", commitsChecked: [], findings: [], testsRun: ["npm test"], testsPassed: true };
const task = (taskId, extra = {}) => ({ taskId, title: `task ${taskId}`, files: [`src/${taskId}.js`], verify: [`node --test ${taskId}.test.js`], ...extra });

// Default responder: everything succeeds and every review passes the commit it was shown.
function happy(label, prompt) {
  const [kind, a, b] = label.split(" ");
  if (kind === "red") return red(a);
  if (kind === "build") return exec(a);
  if (kind === "fix") return exec(a, 2);
  if (kind === "integrate-fix") return exec(a, 3);
  if (kind === "review") return review(a, "PASS", mustBe(prompt));
  if (kind === "seat") return review(b, "PASS", mustBe(prompt));
  if (kind === "integrate") return integPass;
  if (kind === "verify") return verifyPass;
  throw new Error(`unexpected label ${label}`);
}

// ---- structure ---------------------------------------------------------------------------

test("team.js carries build.js's shared stages byte for byte (from <shared> up to reviewLoop)", async () => {
  const [build, team] = await Promise.all([source("build.js"), source("team.js")]);
  const slice = build.slice(build.indexOf("// <shared>\n") + 12, build.indexOf("async function reviewLoop("));
  const block = team.slice(team.indexOf("// <build-shared>\n") + 18, team.indexOf("// </build-shared>"));
  assert.ok(slice.length > 5000, "build.js slice found");
  assert.equal(block, slice, "re-copy build.js's <shared> slice into team.js's <build-shared> block");
});

test("team.js and debug.js inline schemas that deep-equal schemas.js", async () => {
  const grab = (src, name) => {
    const m = src.match(new RegExp(`const ${name} = (\\{[\\s\\S]*?\\n\\})\\n`));
    assert.ok(m, `${name} inlined`);
    return new Function("str", "strList", `return (${m[1]})`)({ type: "string" }, { type: "array", items: { type: "string" } });
  };
  const team = await source("team.js");
  for (const n of ["EXEC_RESULT", "REVIEW_RESULT", "VERIFY_RESULT", "RED_RESULT", "INTEGRATION_RESULT"]) assert.deepEqual(grab(team, n), S[n], `team.js ${n}`);
  const debug = await source("debug.js");
  for (const n of ["HYPOTHESES_RESULT", "HYPOTHESIS_RESULT"]) assert.deepEqual(grab(debug, n), S[n], `debug.js ${n}`);
});

test("team.js and debug.js have a literal meta whose phases cover every phase() title used", async () => {
  for (const [file, name] of [["team.js", "team"], ["debug.js", "debug"]]) {
    const src = await source(file);
    const meta = src.slice(0, src.indexOf("\n}\n") + 2);
    assert.match(meta, new RegExp(`name: '${name}'`));
    assert.doesNotMatch(meta, /\$\{|\.\.\./, "meta must be a pure literal");
    assert.doesNotMatch(src, /Date\.now\(\)|Math\.random\(\)|new Date\(\)/, "non-deterministic calls break resume");
    for (const [, phase] of src.matchAll(/phase: '([A-Za-z]+)'/g)) assert.match(meta, new RegExp(`title: '${phase}'`), `${file}: phase ${phase} missing from meta`);
  }
});

// ---- team: test-first split --------------------------------------------------------------

test("team: a tdd task runs red (isolated test writer) -> green (builder in the red worktree) -> review with the red guard", async () => {
  const args = { runId: "t1", base: "base123", branch: "muster/t1", waves: [[task("A", { tdd: true })]], models: { testWriter: { model: "haiku" }, executor: { model: "sonnet" } } };
  const { result, calls } = await run("team.js", args, happy);
  assert.deepEqual(calls.map((c) => c.opts.label), ["red A", "build A", "review A r0", "verify t1"]);
  const [r, g, rv] = calls;
  assert.equal(r.opts.agentType, "muster:muster-test-writer");
  assert.equal(r.opts.isolation, "worktree");
  assert.equal(r.opts.model, "haiku");
  assert.deepEqual(r.opts.schema, S.RED_RESULT);
  assert.match(r.prompt, /Mode: red/);
  assert.match(r.prompt, /\[t1\/A red\]/);
  assert.match(r.prompt, /git merge --ff-only muster\/t1/, "the red worktree gets the F1 sync step too");
  assert.equal(g.opts.isolation, undefined, "green reuses the red worktree");
  assert.equal(g.opts.agentType, "muster:muster-executor");
  assert.equal(g.opts.model, "sonnet");
  assert.match(g.prompt, new RegExp(`cd ${red("A").worktree} &&`));
  assert.match(g.prompt, new RegExp(`red commit ${red("A").commit}`));
  assert.match(g.prompt, /\[TestEdit\]/);
  assert.match(rv.prompt, new RegExp(`git diff ${red("A").commit} HEAD -- test/A.test.js`));
  const a = result.tasks[0];
  assert.equal(a.red.commit, red("A").commit);
  assert.equal(a.worktree, red("A").worktree);
  assert.equal(a.branch, red("A").branch);
  assert.equal(a.review.verdict, "PASS");
  assert.equal(result.verification.verdict, "PASS");
});

test("team: tests that do not fail as expected block the task before any implementation runs", async () => {
  const { result, calls } = await run("team.js", { runId: "t2", waves: [[task("A", { tdd: true })]] }, (label, prompt) =>
    label === "red A" ? red("A", { failingAsExpected: false, deviations: ["behavior already exists"] }) : happy(label, prompt));
  assert.deepEqual(calls.map((c) => c.opts.label), ["red A"]);
  assert.equal(result.tasks[0].status, "blocked");
  assert.match(result.tasks[0].deviations[0], /red phase: behavior already exists/);
  assert.equal(result.verification.verdict, "ABSTAIN");
  assert.match(result.halted, /wave 1 did not pass/);
});

test("team: a green specialist builder gets the executor contract and bound skills; a reported [TestEdit] reaches the reviewer", async () => {
  const t = task("A", { tdd: true, agentType: "muster:frontend-mobile-development-frontend-developer", agentHint: "wsh-frontend-developer", skills: [{ id: "x", path: "/p/x/SKILL.md" }] });
  const { calls } = await run("team.js", { runId: "t3", waves: [[t]] }, (label, prompt) =>
    label === "build A" ? exec("A", 1, { deviations: ["[TestEdit] test/A.test.js"], skillsApplied: [{ id: "x", how: "used" }] }) : happy(label, prompt));
  const g = calls.find((c) => c.opts.label === "build A");
  assert.equal(g.opts.agentType, "muster:frontend-mobile-development-frontend-developer");
  assert.match(g.prompt, /executor contract/);
  assert.match(g.prompt, /REQUIRED SKILLS/);
  assert.match(calls.find((c) => c.opts.label === "review A r0").prompt, /reported editing red tests: \[TestEdit\] test\/A\.test\.js/);
});

test("team: testFirst off builds tdd tasks plainly; testFirst all splits every task", async () => {
  const off = await run("team.js", { runId: "t4", topology: { testFirst: "off" }, waves: [[task("A", { tdd: true })]] }, happy);
  assert.deepEqual(off.calls.map((c) => c.opts.label), ["build A", "review A r0", "verify t4"]);
  assert.equal(off.calls[0].opts.isolation, "worktree");
  const all = await run("team.js", { runId: "t5", topology: { testFirst: "all" }, waves: [[task("A")]] }, happy);
  assert.equal(all.calls[0].opts.label, "red A");
});

// ---- team: specialist review seats --------------------------------------------------------

test("team: an auth diff adds the security seat in parallel; its blocker forces a fix and a scoped re-review", async () => {
  const t = task("A", { files: ["src/auth/session.js"] });
  const { result, calls } = await run("team.js", { runId: "s1", waves: [[t]] }, (label, prompt) => {
    if (label === "seat security A") return review("A", "FAIL", mustBe(prompt), [{ severity: "high", file: "src/auth/session.js", line: 9, summary: "token compared with ==" }, { severity: "low", file: "x", summary: "nit" }]);
    return happy(label, prompt);
  });
  const seatCall = calls.find((c) => c.opts.label === "seat security A");
  assert.equal(seatCall.opts.agentType, "muster:backend-development-security-auditor");
  assert.deepEqual(seatCall.opts.schema, S.REVIEW_RESULT);
  assert.match(seatCall.prompt, /Review ONLY for security/);
  const fix = calls.find((c) => c.opts.label === "fix A r1");
  assert.match(fix.prompt, /\[security\] token compared with ==/);
  assert.doesNotMatch(fix.prompt, /nit/, "only blocker-grade seat findings bind a fix");
  const r1 = calls.find((c) => c.opts.label === "review A r1");
  assert.match(r1.prompt, /scoped re-review/);
  assert.match(r1.prompt, new RegExp(`git log -p --no-merges ${sha("A", 1)}\\.\\.${sha("A", 2)}`));
  assert.ok(!calls.some((c) => c.opts.label.startsWith("seat ") && c !== seatCall), "seats run once, in round 0");
  const a = result.tasks[0];
  assert.equal(a.review.verdict, "PASS");
  assert.deepEqual(a.seats.map((s) => [s.seat, s.verdict, s.counted]), [["security", "FAIL", true]]);
});

test("team: a seat that errors or reviews the wrong commit is NOT_COUNTED and never overrides the primary PASS", async () => {
  const t = task("A", { files: ["src/auth/token.ts", "src/api/client.ts"] });
  const { result, calls } = await run("team.js", { runId: "s2", waves: [[t]] }, (label, prompt) => {
    if (label === "seat security A") throw new Error("agent type muster:backend-development-security-auditor not found");
    if (label === "seat silent-failure A") return review("A", "FAIL", "deadbeef", [{ severity: "blocker", file: "x", summary: "y" }]);
    return happy(label, prompt);
  });
  assert.deepEqual(result.tasks[0].seats.map((s) => [s.seat, s.verdict]), [["security", "NOT_COUNTED"], ["silent-failure", "NOT_COUNTED"]]);
  assert.equal(result.tasks[0].review.verdict, "PASS");
  assert.ok(!calls.some((c) => c.opts.label.startsWith("fix ")));
});

test("team: seat selection caps at maxSeats, skips the tests seat on tdd tasks, honours reviewSeats and seats off", async () => {
  const many = task("A", { files: ["src/auth/x.ts", "src/types/t.d.ts", "src/api/client.ts", "test/a.test.ts", "ui/App.tsx"] });
  const capped = await run("team.js", { runId: "s3", waves: [[many]] }, happy);
  assert.deepEqual(capped.calls.filter((c) => c.opts.label.startsWith("seat ")).map((c) => c.opts.label), ["seat security A", "seat silent-failure A"]);
  const tdd = await run("team.js", { runId: "s4", topology: { maxSeats: 4 }, waves: [[{ ...many, tdd: true }]] }, happy);
  assert.ok(!tdd.calls.some((c) => c.opts.label === "seat tests A"), "the independent test writer replaces the tests seat");
  const explicit = await run("team.js", { runId: "s5", waves: [[task("A", { reviewSeats: ["ux", "muster:prt-pr-test-analyzer"] })]] }, happy);
  assert.deepEqual(explicit.calls.filter((c) => c.opts.label.startsWith("seat ")).map((c) => c.opts.agentType), ["muster:intent-vigil", "muster:prt-pr-test-analyzer"]);
  const off = await run("team.js", { runId: "s6", topology: { seats: "off" }, waves: [[many]] }, happy);
  assert.ok(!off.calls.some((c) => c.opts.label.startsWith("seat ")));
});

test("team: the fix loop stops when open findings stop falling, and the last round runs on models.escalate", async () => {
  const f = (n) => Array.from({ length: n }, (_, i) => ({ severity: "blocker", file: "A.js", summary: `bug ${i}` }));
  const models = { executor: { model: "haiku" }, escalate: { model: "opus", effort: "high" } };
  const stall = await run("team.js", { runId: "f1", models, waves: [[task("A")]] }, (label, prompt) => {
    if (label === "review A r0") return review("A", "FAIL", mustBe(prompt), f(2));
    if (label === "review A r1") return review("A", "FAIL", mustBe(prompt), f(2));
    return happy(label, prompt);
  });
  assert.deepEqual(stall.calls.map((c) => c.opts.label), ["build A", "review A r0", "fix A r1", "review A r1"]);
  assert.match(stall.logs.join("\n"), /stalled at 2/);
  const esc = await run("team.js", { runId: "f2", models, waves: [[task("A")]] }, (label, prompt) => {
    if (label === "review A r0") return review("A", "FAIL", mustBe(prompt), f(2));
    if (label === "review A r1") return review("A", "FAIL", mustBe(prompt), f(1));
    return happy(label, prompt);
  });
  assert.equal(esc.calls.find((c) => c.opts.label === "fix A r1").opts.model, "haiku");
  const r2 = esc.calls.find((c) => c.opts.label === "fix A r2");
  assert.equal(r2.opts.model, "opus");
  assert.equal(r2.opts.agentType, "muster:muster-executor", "fixers stay muster-executor (amendment 4)");
});

// ---- team: wave integration check --------------------------------------------------------

test("team: a wave of two tasks gets one integration check; a single-task wave and integrate off skip it", async () => {
  const two = await run("team.js", { runId: "i1", base: "b0", waves: [[task("A"), task("B")], [task("C")]] }, happy);
  const checks = two.calls.filter((c) => c.opts.label.startsWith("integrate "));
  assert.deepEqual(checks.map((c) => c.opts.label), ["integrate w1 r0"]);
  assert.equal(checks[0].opts.agentType, "muster:muster-integration-checker");
  assert.deepEqual(checks[0].opts.schema, S.INTEGRATION_RESULT);
  assert.match(checks[0].prompt, new RegExp(`git worktree add --detach .claude/worktrees/integrate-i1-w1 b0`));
  assert.match(checks[0].prompt, new RegExp(`${sha("A", 1)} ${sha("B", 1)}`));
  assert.deepEqual(two.result.integration.map((r) => [r.wave, r.verdict]), [[1, "PASS"]]);
  const off = await run("team.js", { runId: "i2", topology: { integrate: "off" }, waves: [[task("A"), task("B")]] }, happy);
  assert.ok(!off.calls.some((c) => c.opts.label.startsWith("integrate")));
});

test("team: an integration blocker routes to the named task's fixer, gets a scoped re-review and a re-check; wave 2 builds on the fixed commit", async () => {
  let checks = 0;
  const { result, calls } = await run("team.js", { runId: "i3", waves: [[task("A"), task("B")], [task("C")]] }, (label, prompt) => {
    if (label.startsWith("integrate w1")) {
      checks++;
      return checks === 1
        ? { verdict: "FAIL", commitsChecked: [], findings: [{ severity: "blocker", taskIds: ["A"], file: "src/A.js", line: 4, summary: "calls B's parse() under its old name" }], testsRun: ["npm test"], testsPassed: false }
        : integPass;
    }
    return happy(label, prompt);
  });
  const fix = calls.find((c) => c.opts.label === "integrate-fix A");
  assert.ok(fix, "A's fixer runs");
  assert.ok(!calls.some((c) => c.opts.label === "integrate-fix B"), "B is not named, so it is not touched");
  assert.equal(fix.opts.isolation, undefined);
  assert.match(fix.prompt, /\[i3\/A integrate 1\]/);
  assert.match(fix.prompt, /old name/);
  assert.match(calls.find((c) => c.opts.label === "review A integrate").prompt, /scoped re-review/);
  assert.equal(checks, 2);
  const a = result.tasks.find((t) => t.taskId === "A");
  assert.equal(a.commit, sha("A", 3));
  assert.equal(a.integrationFix, true);
  assert.match(calls.find((c) => c.opts.label === "build C").prompt, new RegExp(sha("A", 3)), "wave 2 merges the fixed commit");
  assert.equal(result.halted, null);
  assert.equal(result.verification.verdict, "PASS");
});

test("team: integration blockers that survive the fix round halt the run; ABSTAIN is advisory", async () => {
  const fail = { verdict: "FAIL", commitsChecked: [], findings: [{ severity: "blocker", taskIds: ["B"], file: "x", summary: "dup migration 0007" }], testsRun: [], testsPassed: false };
  const halted = await run("team.js", { runId: "i4", waves: [[task("A"), task("B")], [task("C")]] }, (label, prompt) => (label.startsWith("integrate w1") ? fail : happy(label, prompt)));
  assert.match(halted.result.halted, /failed the integration check \(integration blockers survived the fix round\)/);
  assert.equal(halted.result.verification.verdict, "ABSTAIN");
  assert.equal(halted.result.tasks.find((t) => t.taskId === "C").status, "blocked");
  const abstain = await run("team.js", { runId: "i5", waves: [[task("A"), task("B")]] }, (label, prompt) => (label.startsWith("integrate") ? { verdict: "ABSTAIN", commitsChecked: [], findings: [], testsRun: [], testsPassed: false } : happy(label, prompt)));
  assert.equal(abstain.result.halted, null);
  assert.equal(abstain.result.verification.verdict, "PASS");
});

test("team: argument errors and string args", async () => {
  const { result } = await run("team.js", "{}", happy);
  assert.equal(result.status, "error");
  const { result: ok } = await run("team.js", JSON.stringify({ runId: "x", waves: [[task("A")]] }), happy);
  assert.equal(ok.tasks[0].review.verdict, "PASS");
  assert.deepEqual(ok.topology, { testFirst: "auto", seats: "auto", maxSeats: 2, integrate: "auto", escalate: true });
});

// ---- debug: competing hypotheses ---------------------------------------------------------

const hyp = (id, status, confidence, plus = 1, minus = 0) => ({
  hypothesisId: id, status, confidence, causalChain: `${id} chain`, reproduction: "npm test", suggestedFix: `fix ${id}`,
  evidence: [...Array.from({ length: plus }, (_, i) => ({ file: "src/a.js", line: i + 1, claim: "for", supports: true })), ...Array.from({ length: minus }, () => ({ file: "src/b.js", claim: "against", supports: false }))],
});

test("debug: generate -> parallel investigation -> cross-examination of survivors -> deterministic root cause", async () => {
  const { result, calls } = await run("debug.js", { symptom: "exits after one message", repro: "npm run e2e", models: { investigator: { model: "haiku" } } }, (label) => {
    if (label === "hypothesize") return { hypotheses: ["H1", "H2", "H3"].map((id) => ({ id, statement: `${id} theory`, category: "state", predicts: "x" })) };
    if (label === "investigate H1") return hyp("H1", "CONFIRMED", "medium", 2);
    if (label === "investigate H2") return hyp("H2", "PLAUSIBLE", "medium", 1);
    if (label === "investigate H3") return hyp("H3", "FALSIFIED", "high", 0, 2);
    if (label === "challenge H1") return hyp("H1", "CONFIRMED", "high", 3);
    if (label === "challenge H2") return hyp("H2", "FALSIFIED", "high", 0, 2);
    throw new Error(label);
  });
  assert.deepEqual(calls.map((c) => c.opts.label), ["hypothesize", "investigate H1", "investigate H2", "investigate H3", "challenge H1", "challenge H2"]);
  for (const c of calls) {
    assert.equal(c.opts.agentType, "muster:wsh-team-debugger");
    assert.equal(c.opts.isolation, undefined, "investigators are read-only, no worktrees");
    assert.equal(c.opts.model, "haiku");
  }
  assert.deepEqual(calls[1].opts.schema, S.HYPOTHESIS_RESULT);
  assert.match(calls[1].prompt, /Mode: investigate/);
  assert.match(calls[4].prompt, /Mode: challenge/);
  assert.match(calls[4].prompt, /H2 PLAUSIBLE/, "a challenger sees every first-round report");
  assert.equal(result.verdict, "ROOT_CAUSE");
  assert.equal(result.rootCause.hypothesisId, "H1");
  assert.equal(result.rootCause.statement, "H1 theory");
  assert.equal(result.ranking[0].hypothesisId, "H1");
  assert.deepEqual(result.ranking.slice(1).map((r) => r.status), ["FALSIFIED", "FALSIFIED"], "the challenged H2 fell with H3");
  assert.match(result.next, /tdd="true"/);
});

test("debug: given hypotheses skip generation; one survivor skips the challenge round", async () => {
  const { result, calls } = await run("debug.js", { symptom: "s", hypotheses: ["cache is stale", "env var missing"] }, (label) =>
    label === "investigate H1" ? hyp("H1", "CONFIRMED", "high", 2) : hyp("H2", "FALSIFIED", "high", 0, 1));
  assert.deepEqual(calls.map((c) => c.opts.label), ["investigate H1", "investigate H2"]);
  assert.equal(result.verdict, "ROOT_CAUSE");
  assert.equal(result.rootCause.statement, "cache is stale");
});

test("debug: a challenge that falsifies the leader hands the verdict to the rival; none confirmed is INCONCLUSIVE", async () => {
  const flip = await run("debug.js", { symptom: "s", hypotheses: ["a", "b"] }, (label) => {
    if (label === "investigate H1") return hyp("H1", "CONFIRMED", "high", 3);
    if (label === "investigate H2") return hyp("H2", "PLAUSIBLE", "low", 1);
    if (label === "challenge H1") return hyp("H1", "FALSIFIED", "high", 0, 3);
    return hyp("H2", "CONFIRMED", "medium", 2);
  });
  assert.equal(flip.result.verdict, "ROOT_CAUSE");
  assert.equal(flip.result.rootCause.hypothesisId, "H2");
  const none = await run("debug.js", { symptom: "s", hypotheses: ["a", "b"] }, (label) => (label === "investigate H1" ? hyp("H1", "INCONCLUSIVE", "low", 0) : { status: "error", error: "x" }));
  assert.equal(none.result.verdict, "INCONCLUSIVE");
  assert.equal(none.result.rootCause, null);
  assert.equal(none.result.investigations[1].status, "error");
});

test("debug: two closely ranked confirmed causes are COMPOUND; caps and argument errors", async () => {
  const compound = await run("debug.js", { symptom: "s", hypotheses: ["a", "b"] }, (label) => {
    const id = label.split(" ")[1];
    return hyp(id, "CONFIRMED", "high", 2);
  });
  assert.equal(compound.result.verdict, "COMPOUND");
  assert.deepEqual(compound.result.contributing, ["H2"]);
  const capped = await run("debug.js", { symptom: "s", maxHypotheses: 9, hypotheses: ["1", "2", "3", "4", "5", "6", "7"] }, (label) => hyp(label.split(" ")[1], "FALSIFIED", "high", 0, 1));
  assert.equal(capped.calls.length, 5, "at most 5 investigators");
  const { result } = await run("debug.js", "", () => null);
  assert.equal(result.status, "error");
});

// ---- wiring --------------------------------------------------------------------------------

test("build-args carries tdd for tdd=\"true\" and type=\"tdd\" tasks", () => {
  const plan = [
    "<tasks>",
    '<task id="01" wave="1" tdd="true"><name>a</name><files>src/a.js</files><action>x</action><verify><automated>npm test</automated></verify><done>d</done></task>',
    '<task id="02" type="tdd" wave="1"><name>b</name><files>src/b.js</files><action>x</action><verify><automated>npm test</automated></verify><done>d</done></task>',
    '<task id="03" wave="1"><name>c</name><files>src/c.js</files><action>x</action><verify><automated>npm test</automated></verify><done>d</done></task>',
    "</tasks>",
  ].join("\n");
  const { args, problems } = buildArgsFromPlan(plan, { runId: "r" });
  assert.deepEqual(problems, []);
  assert.deepEqual(args.waves[0].map((t) => [t.taskId, t.tdd === true]), [["01", true], ["02", true], ["03", false]]);
});

test("the dev-team seats are never a task's builder", () => {
  const { agents } = specialistCatalog();
  for (const id of ["muster-test-writer", "muster-integration-checker", "wsh-team-debugger"]) {
    assert.ok(agents.has(id), `${id} in the catalog`);
    assert.equal(agents.get(id).dispatchable, false, `${id} must not be dispatchable by agent_hint`);
  }
  assert.ok(WORKFLOW_SEATS.includes("muster-test-writer"));
  assert.equal(agents.get("wsh-team-debugger").agentType, "muster:wsh-team-debugger", "id and frontmatter name agree, so debug.js can name it");
});
