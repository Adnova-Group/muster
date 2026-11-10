// PM domain stages C-E (docs/strategy/2026-11-pm-domain-design.md): the /muster:pm command, the
// interview's question rounds, pipeline renames/retirements with aliases, the per-phase builtin
// bindings, the pipeline-reachability doctor check and the optional AGENTS.md pointer.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir, writeFile, symlink, lstat } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import { loadPipelines, validatePipeline, resolvePipeline, routePipeline, PIPELINE_ALIASES } from "../src/pipeline.js";
import { pipelineArgsFrom } from "../src/pipeline-args.js";
import { specialistCatalog } from "../src/specialists.js";
import { checkPipelineReach, pipelineRunners } from "../src/pipeline-reach.js";
import { linkPmDocs, PM_LINK_MARKER } from "../src/agents-link.js";
import { tmpProject } from "../test-support/helpers.js";

const root = fileURLToPath(new URL("../", import.meta.url));
const read = (p) => readFile(join(root, p), "utf8");
const PIPELINES = join(root, "pipelines");
const frontmatter = (text) => parseYaml(text.match(/^---\n([\s\S]*?)\n---/)[1]);

describe("/muster:pm", () => {
  test("is user-only, one-line described, within 2.5k tokens, and calls the CLI through runtime/muster.sh", async () => {
    const text = await read("plugin/commands/pm.md");
    const fm = frontmatter(text);
    assert.equal(fm.name, "pm");
    assert.equal(fm["disable-model-invocation"], true);
    assert.ok(fm.description && !fm.description.includes("\n"));
    assert.ok(Buffer.byteLength(text) / 4 <= 2500, `pm.md is ~${Math.round(Buffer.byteLength(text) / 4)} tokens`);
    assert.match(text, /sh "\$\{CLAUDE_PLUGIN_ROOT\}\/runtime\/muster\.sh"/);
    for (const verb of ["intent", "spec", "check", "tickets", "audit", "run"]) assert.match(text, new RegExp(`^## ${verb}\\b`, "m"), verb);
  });

  test("spec lints and red-teams in a subagent; tickets publish through backlog-publish; run uses pipeline-args + muster:pipeline", async () => {
    const text = await read("plugin/commands/pm.md");
    assert.match(text, /M spec-lint docs\/specs\/<slug>\/SPEC\.md/);
    assert.match(text, /Red-team in a subagent[\s\S]{0,200}references\/red-team\.md/);
    assert.match(text, /M backlog-publish \.muster\/backlog\.md --expect/);
    assert.match(text, /M pipeline-args <runId> --pipeline <id>/);
    assert.match(text, /Workflow\(\{name:"muster:pipeline"/);
    assert.match(text, /M pipeline --list/);
    assert.match(text, /references\/audit\.md[\s\S]{0,400}muster:capture/);
  });

  test("stays out of the frozen Codex lane", async () => {
    assert.match(await read("scripts/build-codex.mjs"), /CLAUDE_ONLY_COMMANDS = \[[^\]]*"pm\.md"/);
  });
});

describe("interview question rounds", () => {
  test("asks up to 4 questions per AskUserQuestion with a recommended answer, and only a SPEC's open questions (at most 5)", async () => {
    const text = await read("plugin/skills/interview/SKILL.md");
    assert.match(text, /up to 4\s+questions/);
    assert.match(text, /\(Recommended\)/);
    assert.match(text, /inspired by mattpocock\/skills' `grilling`/);
    assert.match(text, /Given a SPEC[\s\S]{0,300}at most 5 questions/);
    assert.doesNotMatch(text, /Ask one question at a time/);
    assert.equal(frontmatter(text).upstream.find((u) => u.repo === "mattpocock/skills")?.relation, "inspired-by");
  });
});

describe("pipeline renames, retirements and aliases", () => {
  test("ai-implementation-spec resolves to design; user-story is retired to /muster:pm tickets", async () => {
    const ps = await loadPipelines(PIPELINES);
    const ids = ps.map((p) => p.id);
    assert.ok(ids.includes("design") && !ids.includes("ai-implementation-spec") && !ids.includes("user-story"));
    const design = resolvePipeline(ps, "ai-implementation-spec");
    assert.equal(design.pipeline.id, "design");
    assert.equal(design.alias, "ai-implementation-spec");
    const story = resolvePipeline(ps, "user-story");
    assert.equal(story.pipeline, null);
    assert.match(story.retired, /\/muster:pm tickets/);
    assert.deepEqual(resolvePipeline(ps, "nope"), { pipeline: null, id: "nope", alias: null, retired: null });
    assert.equal(routePipeline(ps, "write an implementation spec", "pm").id, "design");
    assert.equal(routePipeline(ps, "write a design doc for the cache", "pm").id, "design");
  });

  test("a pipeline file may not reuse an alias id, and phase skills must be builtin ids", () => {
    const base = { domain: "pm", phases: [{ id: "a", role: "author" }], gate: { criteria: ["x"], floor: 1, pass_total: 1 } };
    for (const id of Object.keys(PIPELINE_ALIASES)) assert.equal(validatePipeline({ ...base, id }).ok, false);
    assert.equal(validatePipeline({ ...base, id: "t", phases: [{ id: "a", role: "author", skills: ["Not An Id"] }] }).ok, false);
    assert.equal(validatePipeline({ ...base, id: "t", phases: [{ id: "a", role: "author", skills: ["muster-pm"] }] }).ok, true);
  });

  test("the retired skills and the review-gate references are gone; roadmap prioritization is a builtin", async () => {
    const skills = await readdir(join(root, "plugin/skills"));
    assert.ok(!skills.includes("prd-pipeline") && !skills.includes("roadmap-prioritization"));
    for (const f of (await readdir(PIPELINES)).filter((n) => n.endsWith(".yaml"))) {
      assert.doesNotMatch(await read(`pipelines/${f}`), /review-gate/, f);
    }
    const roadmap = await read("plugin/builtins/muster-roadmap/SKILL.md");
    assert.match(roadmap, /muster prioritize <file>\s+--model rice/);
    assert.match(roadmap, /gh issue create/);
  });
});

describe("PM pipeline refinements", () => {
  const load = async (id) => parseYaml(await read(`pipelines/${id}.yaml`));
  const descs = (p) => [...p.phases, ...(p.optional_phases || [])].map((ph) => ph.desc).join("\n");

  test("prd: render mode, an AI behavior section, and a red-team phase that never revises the draft", async () => {
    const prd = await load("prd");
    assert.match(descs(prd), /RENDER MODE/);
    assert.match(descs(prd), /AI BEHAVIOR/);
    const redTeam = prd.phases.find((ph) => ph.id === "red-team");
    assert.equal(redTeam.role, "brainstorm", "an author-role red-team would become the gate's reviser");
    assert.deepEqual(redTeam.skills, ["muster-pm"]);
    const at = (id) => prd.phases.findIndex((ph) => ph.id === id);
    assert.ok(at("draft") < at("red-team") && at("red-team") < at("review"));
  });

  test("okrs, roadmap, epic, release-notes, ai-test-plan and design carry their stage-D rules", async () => {
    assert.match(descs(await load("okrs")), /60-70% confidence/);
    assert.match(descs(await load("okrs")), /THREE alternative OKR sets/);
    const roadmap = await load("roadmap");
    assert.match(descs(roadmap), /INT stub at docs\/intent\/INT-NNNN-<slug>\.md/);
    assert.ok(!roadmap.phases.slice(0, -1).some((ph) => ph.role === "score" && ph.id !== "score"), "only the gate's score phase may take the score role");
    assert.match(descs(await load("epic")), /\/muster:pm tickets/);
    assert.match(descs(await load("release-notes")), /requirement IDs/);
    const qa = await load("ai-test-plan");
    assert.match(qa.title, /Human QA/);
    assert.ok(!qa.match.includes("ai test plan"));
    assert.match(descs(await load("design")), /SPEC/);
  });

  test("capture mines open questions, deferred items and new eval rows", async () => {
    const capture = await read("plugin/commands/capture.md");
    for (const re of [/open questions/, /deferred items/, /new eval rows/]) assert.match(capture, re);
  });

  test("pipeline-args binds phase builtins by path and refuses retired ids", async () => {
    const ps = await loadPipelines(PIPELINES);
    const prd = ps.find((p) => p.id === "prd");
    const { args, problems } = pipelineArgsFrom(prd, { runId: "r1", outcome: "a PRD for refunds" });
    assert.deepEqual(problems, []);
    const redTeam = args.phases.find((ph) => ph.id === "red-team");
    assert.deepEqual(redTeam.skills.map((s) => s.id), ["muster-pm"]);
    assert.ok(redTeam.skills[0].path.endsWith(join("builtins", "muster-pm", "SKILL.md")));
    const broken = { ...prd, phases: [{ id: "x", role: "author", skills: ["no-such-builtin"] }] };
    assert.match(pipelineArgsFrom(broken, { runId: "r1", outcome: "" }).problems.join(), /no-such-builtin" is not a bundled builtin/);
  });
});

describe("pipeline reachability doctor check", () => {
  const manifestFor = (ids) => ({ sources: [{ id: "s", items: ids.map((id) => ({ id, kind: "pipeline", from: null })) }] });
  const p = (id, extra = {}) => ({ id, domain: "pm", match: [id], upstream: [{ kind: "book", title: "t" }], phases: [{ id: "d", role: "author" }], gate: { criteria: ["c"], floor: 1, pass_total: 1 }, ...extra });
  const catalog = specialistCatalog();

  test("the shipped pipelines are all reachable and sourced", async () => {
    const pipelines = await loadPipelines(PIPELINES);
    const commands = {};
    for (const f of (await readdir(join(root, "plugin/commands"))).filter((n) => n.endsWith(".md"))) commands[f.slice(0, -3)] = await read(`plugin/commands/${f}`);
    const manifest = parseYaml(await read("vendor/manifest.yaml"));
    const res = checkPipelineReach({ pipelines, manifest, commands, workflowPresent: true, catalog, pluginRoot: join(root, "plugin") });
    assert.deepEqual(res.problems, []);
    assert.deepEqual(res.runners.byId, ["pm"]);
    assert.ok(res.runners.routed.includes("go") && res.runners.routed.includes("plan"));
  });

  test("flags a pipeline nothing can run, a missing workflow, a stale manifest item and an unsourced pipeline", () => {
    const routedOnly = { go: "M pipeline-args <runId>" };
    const r1 = checkPipelineReach({ pipelines: [p("a", { match: [] })], manifest: manifestFor(["a"]), commands: routedOnly, workflowPresent: false, catalog });
    assert.ok(r1.problems.some((x) => /a: no command can run it/.test(x)));
    assert.ok(r1.problems.some((x) => /muster:pipeline workflow\) is missing/.test(x)));
    const r2 = checkPipelineReach({ pipelines: [p("a")], manifest: manifestFor(["a", "gone"]), commands: routedOnly, workflowPresent: true, catalog });
    assert.deepEqual(r2.problems.filter((x) => !x.startsWith("alias ")), ["vendor/manifest.yaml source s names missing pipeline gone"]);
    const r3 = checkPipelineReach({ pipelines: [p("a"), p("own", { upstream: [] })], manifest: manifestFor([]), commands: routedOnly, workflowPresent: true, catalog });
    assert.deepEqual(r3.problems.filter((x) => !x.startsWith("alias ")), ["a: no vendor/manifest.yaml item and no explicit upstream: []"]);
    assert.deepEqual(pipelineRunners({ pm: "M pipeline-args <runId> --pipeline <id>", go: "M pipeline-args <runId>", x: "nothing" }), { routed: ["go"], byId: ["pm"] });
  });
});

describe("init pm-link (AGENTS.md pointer)", () => {
  test("previews, appends once on approval, then is a no-op", async () => {
    const dir = await tmpProject({ "AGENTS.md": "# Agents\n\nBe kind." });
    const preview = await linkPmDocs(dir);
    assert.equal(preview.status, "preview");
    assert.equal(await readFile(join(dir, "AGENTS.md"), "utf8"), "# Agents\n\nBe kind.");
    const added = await linkPmDocs(dir, { approved: true });
    assert.equal(added.status, "added");
    const text = await readFile(join(dir, "AGENTS.md"), "utf8");
    assert.ok(text.startsWith("# Agents\n\nBe kind.\n\n"));
    assert.equal(text.split(PM_LINK_MARKER).length, 2);
    assert.match(text, /docs\/intent\/[\s\S]*docs\/specs\//);
    assert.equal((await linkPmDocs(dir, { approved: true })).status, "present");
    assert.equal(await readFile(join(dir, "AGENTS.md"), "utf8"), text);
  });

  test("never creates AGENTS.md and refuses a symlinked one", async () => {
    const dir = await tmpProject({ "elsewhere.md": "x\n" });
    assert.equal((await linkPmDocs(dir, { approved: true })).status, "absent");
    await assert.rejects(lstat(join(dir, "AGENTS.md")), { code: "ENOENT" });
    await symlink(join(dir, "elsewhere.md"), join(dir, "AGENTS.md"));
    await assert.rejects(linkPmDocs(dir, { approved: true }));
    assert.equal(await readFile(join(dir, "elsewhere.md"), "utf8"), "x\n");
  });

  test("init.md offers it attended only, behind an explicit approval flag", async () => {
    const init = await read("plugin/commands/init.md");
    assert.match(init, /Optional PM docs pointer \(attended only\)/);
    assert.match(init, /M init pm-link "<target>" --approve pm-link/);
    assert.match(init, /Unattended runs never offer or write it/);
  });
});
