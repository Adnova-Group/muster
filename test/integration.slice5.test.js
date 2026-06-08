import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyDomain } from "../src/domain.js";
import { loadPipelines, pipelineForDomain } from "../src/pipeline.js";
import { scoreArtifact } from "../src/score.js";

test("a PRD outcome routes to the PRD pipeline and scores by floor", async () => {
  const d = classifyDomain("Write a PRD for the new onboarding flow", {});
  assert.equal(d.domain, "pm");
  const prd = pipelineForDomain(await loadPipelines(new URL("../pipelines/", import.meta.url)), d.domain);
  assert.equal(prd.id, "prd");

  const good = scoreArtifact(
    { "problem-clarity": 3, "outcome-alignment": 3, evidence: 2, "scope-discipline": 2, feasibility: 2, measurability: 2 },
    prd.gate);
  assert.equal(good.passing, true);

  const weak = scoreArtifact(
    { "problem-clarity": 3, "outcome-alignment": 3, evidence: 3, "scope-discipline": 3, feasibility: 3, measurability: 1 },
    prd.gate);
  assert.equal(weak.passing, false);            // measurability below floor
  assert.equal(weak.weakest.criterion, "measurability");
});
