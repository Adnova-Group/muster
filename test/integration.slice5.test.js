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

  // score against the pipeline's actual criteria (research can evolve them)
  const crit = prd.gate.criteria;
  const good = scoreArtifact(Object.fromEntries(crit.map(c => [c, 3])), prd.gate);
  assert.equal(good.passing, true);

  // one dimension below the floor fails the gate and is reported as weakest
  const weakScores = Object.fromEntries(crit.map(c => [c, 3]));
  weakScores[crit[0]] = 1;
  const weak = scoreArtifact(weakScores, prd.gate);
  assert.equal(weak.passing, false);
  assert.equal(weak.weakest.criterion, crit[0]);
});
