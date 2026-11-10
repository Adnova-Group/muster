// Revival stage 3: content outcomes reach the 20 pipelines again. preflight routes them,
// `muster pipeline-args` binds each phase's role to builtin skills, plugin/workflows/pipeline.js
// runs the phases with a floor-scored gate, and `muster next --run` knows a content run.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { trackedMkdtemp } from "../test-support/helpers.js";
import { routeOutcome } from "../src/preflight.js";
import { loadPipelines } from "../src/pipeline.js";
import { ROLE_SKILLS, pipelineArgsFrom, writePipelineArgs } from "../src/pipeline-args.js";
import { nextForRun } from "../src/run-next.js";

const pipelines = await loadPipelines(new URL("../pipelines/", import.meta.url));
const AsyncFunction = (async () => {}).constructor;

test("routeOutcome: content artifacts route to their pipeline, code work stays code, mixed outcomes ask", () => {
  assert.deepEqual(routeOutcome("write a short blog post about tide pools", pipelines), { route: "pipeline", domain: "blog", pipeline: "blog-post" });
  assert.equal(routeOutcome("draft a runbook for the nightly backup", pipelines).pipeline, "runbook");
  assert.equal(routeOutcome("write a PRD for offline mode", pipelines).route, "pipeline");
  assert.equal(routeOutcome("add an api endpoint that returns blog posts", pipelines).route, "ask");
  assert.equal(routeOutcome("fix the release notes generator in scripts/notes.js", pipelines).route, "ask");
  assert.deepEqual(routeOutcome("refactor the parser module", pipelines), { route: "code", domain: "software", pipeline: null });
  assert.equal(routeOutcome("make the login page faster", pipelines).route, "code");
});

test("every pipeline role has a skill binding, and every bound skill is a real builtin", () => {
  for (const p of pipelines) {
    for (const ph of [...p.phases, ...(p.optional_phases || [])]) assert.ok(ph.role in ROLE_SKILLS, `${p.id}.${ph.id}: role ${ph.role}`);
    const { args, problems } = pipelineArgsFrom(p, { runId: "r1", outcome: "x", withPhases: (p.optional_phases || []).map((o) => o.id) });
    assert.deepEqual(problems, [], p.id);
    for (const ph of args.phases) for (const k of ph.skills) assert.ok(existsSync(k.path), `${p.id}.${ph.id}: ${k.path}`);
  }
});

test("pipelineArgsFrom: optional phases only on request, a safe relative --out, the gate carried through", () => {
  const blog = pipelines.find((p) => p.id === "blog-post");
  const { args, problems } = pipelineArgsFrom(blog, { runId: "r1", outcome: "o", models: { executor: { model: "haiku" } } });
  assert.deepEqual(problems, []);
  assert.deepEqual(args.phases.map((p) => p.id), ["intake", "research", "outline", "draft", "edit", "review", "score", "humanize"]);
  assert.deepEqual(args.phases.find((p) => p.id === "draft").skills.map((k) => k.id), ["muster-author"]);
  assert.deepEqual(args.phases.find((p) => p.id === "humanize").skills.map((k) => k.id), ["muster-humanizer"]);
  assert.deepEqual(args.phases.find((p) => p.id === "intake").skills, []);
  assert.equal(args.artifactPath, ".muster/runs/r1/blog-post.md");
  assert.deepEqual(args.pipeline.gate, blog.gate);
  assert.ok(pipelineArgsFrom(blog, { runId: "r1", outcome: "o", withPhases: ["publish"] }).args.phases.some((p) => p.id === "publish"));
  assert.match(pipelineArgsFrom(blog, { runId: "r1", outcome: "o", withPhases: ["nope"] }).problems[0], /no optional phase "nope"/);
  for (const out of ["/etc/x.md", "../x.md", "a/../../x.md"]) assert.ok(pipelineArgsFrom(blog, { runId: "r1", outcome: "o", out }).problems.length, out);
  assert.equal(pipelineArgsFrom(blog, { runId: "r1", outcome: "o", out: "content/tide-pools.md" }).args.artifactPath, "content/tide-pools.md");
});

test("writePipelineArgs reads preflight.json, refuses a code-routed run, and next --run tracks the content run", async () => {
  const root = await trackedMkdtemp(join(tmpdir(), "muster-pipe-"));
  const dir = join(root, ".muster/runs/r1");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "preflight.json"), JSON.stringify({ outcome: "o", pipeline: null, models: { executor: { model: "haiku" } } }));
  const refused = await writePipelineArgs({ cwd: root, runId: "r1" });
  assert.equal(refused.ok, false);
  assert.match(refused.problems[0], /routed this outcome to code/);
  const forced = await writePipelineArgs({ cwd: root, runId: "r1", pipelineId: "social-post" });
  assert.equal(forced.ok, true);
  const written = JSON.parse(await readFile(join(dir, "pipeline-args.json"), "utf8"));
  assert.equal(written.pipeline.id, "social-post");
  assert.deepEqual(written.models, { executor: { model: "haiku" } });

  assert.equal((await nextForRun({ cwd: root, runId: "r1" })).position, "pipeline");
  await writeFile(join(dir, "pipeline-result.json"), JSON.stringify({ verdict: "FAIL" }));
  assert.equal((await nextForRun({ cwd: root, runId: "r1" })).position, "inconclusive");
  await writeFile(join(dir, "pipeline-result.json"), JSON.stringify({ verdict: "PASS" }));
  const done = await nextForRun({ cwd: root, runId: "r1" });
  assert.equal(done.position, "verified");
  assert.equal(done.artifacts.pipeline, "PASS");
  // The Workflow tool's envelope, saved verbatim by the main thread in the live smoke.
  await writeFile(join(dir, "pipeline-result.json"), JSON.stringify({ summary: "s", agentCount: 13, logs: [], result: { verdict: "FAIL" } }));
  assert.equal((await nextForRun({ cwd: root, runId: "r1" })).artifacts.pipeline, "FAIL");
});

// ── plugin/workflows/pipeline.js, run the way the Workflow runtime runs it ──

async function runPipeline(args, respond) {
  const src = await readFile(new URL("../plugin/workflows/pipeline.js", import.meta.url), "utf8");
  const fn = new AsyncFunction("agent", "parallel", "pipeline", "phase", "log", "args", src.replace(/^export const meta =/, "const meta ="));
  const calls = [];
  const agent = async (prompt, opts) => { calls.push({ prompt, opts }); return respond(opts.label, prompt, opts, calls); };
  const result = await fn(agent, null, null, () => {}, () => {}, args);
  return { result, calls };
}

const blogArgs = () => pipelineArgsFrom(pipelines.find((p) => p.id === "blog-post"), {
  runId: "r1", outcome: "a short blog post", models: { executor: { model: "haiku" }, reviewer: { model: "haiku" }, verifier: { model: "sonnet" } },
}).args;
const allScores = (n) => ({ scores: blogArgs().pipeline.gate.criteria.map((criterion) => ({ criterion, score: n, evidence: "e" })) });
const phaseOk = (label) => ({ phase: label.split(" ")[0], status: "done", wrote: ["x"], summary: "ok", skillsApplied: [] });

test("pipeline.js: phases in order with their skills, then review + score, then humanize; PASS", async () => {
  const { result, calls } = await runPipeline(blogArgs(), (label) => {
    if (label.startsWith("review")) return { verdict: "PASS", findings: [] };
    if (label.startsWith("score")) return allScores(3);
    return phaseOk(label);
  });
  assert.equal(result.verdict, "PASS");
  assert.deepEqual(calls.map((c) => c.opts.label), ["intake", "research", "outline", "draft", "edit", "review r0", "score r0", "humanize"]);
  const draft = calls.find((c) => c.opts.label === "draft");
  assert.match(draft.prompt, /REQUIRED SKILLS/);
  assert.match(draft.prompt, /muster-author: .*plugin\/builtins\/muster-author\/SKILL\.md/);
  assert.match(draft.prompt, /Read the earlier phase notes first: .*01-intake\.md.*03-outline\.md/);
  assert.equal(draft.opts.model, "haiku");
  assert.equal(draft.opts.isolation, undefined, "content phases write in the main checkout");
  assert.match(calls.find((c) => c.opts.label === "score r0").prompt, /Do not run muster score/);
  assert.equal(calls.find((c) => c.opts.label === "score r0").opts.model, "sonnet");
  assert.equal(result.score.total, 21);
  assert.equal(result.revisions, 0);
});

test("pipeline.js: a score under the floor revises the last author phase with the weakest criteria, then passes", async () => {
  let round = 0;
  const { result, calls } = await runPipeline(blogArgs(), (label) => {
    if (label.startsWith("review")) return { verdict: "PASS", findings: [{ severity: "warning", summary: "weak hook" }] };
    if (label.startsWith("score")) {
      const s = allScores(3);
      if (round++ === 0) s.scores[0].score = 1;
      return s;
    }
    return phaseOk(label);
  });
  assert.equal(result.verdict, "PASS");
  assert.equal(result.revisions, 1);
  const revise = calls.find((c) => c.opts.label === "edit r1");
  assert.ok(revise, calls.map((c) => c.opts.label).join(","));
  assert.match(revise.prompt, /REVISION/);
  assert.match(revise.prompt, /raise the weakest: hook/);
  assert.match(revise.prompt, /\[warning\] weak hook/);
});

test("pipeline.js: the gate stops after 2 revisions and skips the humanizer; a blocked phase halts", async () => {
  const { result, calls } = await runPipeline(blogArgs(), (label) => {
    if (label.startsWith("review")) return { verdict: "FAIL", findings: [{ severity: "blocker", summary: "wrong facts" }] };
    if (label.startsWith("score")) return allScores(3);
    return phaseOk(label);
  });
  assert.equal(result.verdict, "FAIL");
  assert.match(result.halted, /gate failed after 2 revision/);
  assert.equal(calls.filter((c) => c.opts.label.startsWith("review")).length, 3);
  assert.ok(!calls.some((c) => c.opts.label === "humanize"));

  const blocked = await runPipeline(blogArgs(), (label) => (label === "research" ? { ...phaseOk(label), status: "blocked" } : phaseOk(label)));
  assert.equal(blocked.result.verdict, "FAIL");
  assert.deepEqual(blocked.calls.map((c) => c.opts.label), ["intake", "research"]);

  const bad = await runPipeline("{}", () => null);
  assert.equal(bad.result.status, "error");
});

test("pipeline.js: missing criteria and a crashed scorer never pass", async () => {
  const { result } = await runPipeline(blogArgs(), (label) => {
    if (label.startsWith("review")) return { verdict: "PASS", findings: [] };
    if (label.startsWith("score")) return { scores: [{ criterion: "hook", score: 3, evidence: "e" }] };
    return phaseOk(label);
  });
  assert.equal(result.verdict, "FAIL");
  assert.ok(result.score.missing.includes("cta"));
  const crashed = await runPipeline(blogArgs(), (label) => {
    if (label.startsWith("review")) return { verdict: "PASS", findings: [] };
    if (label.startsWith("score")) throw new Error("schema");
    return phaseOk(label);
  });
  assert.equal(crashed.result.verdict, "FAIL");
});
