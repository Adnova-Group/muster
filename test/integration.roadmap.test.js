import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { prioritize } from "../src/prioritize.js";
import { loadPipelines, routePipeline, validatePipeline } from "../src/pipeline.js";
import { classifyDomain } from "../src/domain.js";

const PIPELINES = new URL("../pipelines/", import.meta.url);

test("RICE prioritization ranks a known initiative set and fails loud on bad input", () => {
  const items = [
    { name: "Onboarding redesign", reach: 1200, impact: 2, confidence: 0.8, effort: 4 }, // 480
    { name: "Billing fix", reach: 300, impact: 3, confidence: 1, effort: 2 },             // 450
    { name: "Dark mode", reach: 800, impact: 1, confidence: 0.5, effort: 5 }              // 80
  ];
  const ranked = prioritize(items, "rice");
  assert.equal(ranked[0].name, "Onboarding redesign");
  assert.equal(ranked[0].rank, 1);
  assert.equal(ranked[2].name, "Dark mode");
  // fail loud: zero effort would divide by zero
  assert.throws(() => prioritize([{ name: "x", reach: 1, impact: 1, confidence: 1, effort: 0 }], "rice"), /effort/);
});

test("the roadmap pipeline loads, validates, and routes for prioritization outcomes", async () => {
  const ps = await loadPipelines(PIPELINES);
  const roadmap = ps.find(p => p.id === "roadmap");
  assert.ok(roadmap, "roadmap pipeline must exist");
  assert.deepEqual(validatePipeline(roadmap), { ok: true, errors: [] });
  assert.equal(roadmap.domain, "pm");
  assert.equal(roadmap.phases.at(-1).id, "humanize", "human-facing -> ends with humanize");
  assert.equal(routePipeline(ps, "prioritize our product roadmap", "pm").id, "roadmap");
  assert.equal(classifyDomain("prioritize our roadmap").domain, "pm");
});

// PM domain stage D moved the roadmap-prioritization skill into the muster-roadmap builtin, which
// the roadmap pipeline's generate and prioritize phases bind by path.
test("the roadmap builtin wires the deterministic scorer + graceful gh issues", async () => {
  const skill = await readFile(new URL("../plugin/builtins/muster-roadmap/SKILL.md", import.meta.url), "utf8");
  assert.match(skill, /`<cli> prioritize <file>/, "builtin must call the deterministic scorer through the CLI prefix");
  assert.match(skill, /gh issue create|gh\b/, "builtin must offer GitHub issues");
  assert.match(skill, /AskUserQuestion/, "the main thread uses the selection UI for choices");
  const ps = await loadPipelines(PIPELINES);
  const prioritize = ps.find(p => p.id === "roadmap").phases.find(ph => ph.id === "prioritize");
  assert.deepEqual(prioritize.skills, ["muster-roadmap"]);
});

test("README documents roadmap prioritization", async () => {
  const readme = await readFile(new URL("../README.md", import.meta.url), "utf8");
  assert.match(readme, /Roadmap prioritization/);
  assert.match(readme, /RICE/);
});
