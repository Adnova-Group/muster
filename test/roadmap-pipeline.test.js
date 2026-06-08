import { test } from "node:test";
import assert from "node:assert/strict";
import { loadPipelines, pickPipeline, routePipeline, validatePipeline } from "../src/pipeline.js";
import { scoreArtifact } from "../src/score.js";
import { classifyDomain } from "../src/domain.js";

const pipelinesDir = new URL("../pipelines/", import.meta.url);

test("roadmap pipeline loads and validates", async () => {
  const ps = await loadPipelines(pipelinesDir);
  const roadmap = ps.find(p => p.id === "roadmap");
  assert.ok(roadmap, "roadmap.yaml not loaded");
  assert.equal(roadmap.domain, "pm");
  assert.notEqual(roadmap.default, true, "roadmap must not be the pm default (prd is)");
  assert.deepEqual(validatePipeline(roadmap), { ok: true, errors: [] });
});

test("prioritization outcomes route to the roadmap pipeline", async () => {
  const ps = await loadPipelines(pipelinesDir);
  const viaRoute = routePipeline(ps, "prioritize our product roadmap", "pm");
  assert.equal(viaRoute.id, "roadmap");
  const viaPick = pickPipeline(ps, "prioritize our product roadmap");
  assert.equal(viaPick.id, "roadmap");
});

test("roadmap pipeline ends with a humanize phase (human-facing)", async () => {
  const ps = await loadPipelines(pipelinesDir);
  const roadmap = ps.find(p => p.id === "roadmap");
  assert.equal(roadmap.phases.at(-1).role, "humanize");
});

test("roadmap gate is achievable at full marks", async () => {
  const ps = await loadPipelines(pipelinesDir);
  const roadmap = ps.find(p => p.id === "roadmap");
  const fullMarks = Object.fromEntries(roadmap.gate.criteria.map(c => [c, 3]));
  assert.equal(scoreArtifact(fullMarks, roadmap.gate).passing, true, "roadmap gate unachievable at full marks");
});

test("classifyDomain routes prioritization outcomes to pm", () => {
  assert.equal(classifyDomain("prioritize our roadmap").domain, "pm");
});
