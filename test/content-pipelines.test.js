import { test } from "node:test";
import assert from "node:assert/strict";
import { loadPipelines, pipelineForDomain, validatePipeline } from "../src/pipeline.js";
import { scoreArtifact } from "../src/score.js";
import { classifyDomain } from "../src/domain.js";

const want = {
  blog: "blog-post",
  social: "social-post",
  marketing: "lead-magnet",
  newsletter: "newsletter",
  sales: "case-study",
  ops: "runbook"
};

test("each content/ops pipeline loads, resolves by domain, validates, and its gate is achievable", async () => {
  const ps = await loadPipelines(new URL("../pipelines/", import.meta.url));
  for (const [domain, id] of Object.entries(want)) {
    const p = pipelineForDomain(ps, domain);
    assert.ok(p, `no pipeline for domain ${domain}`);
    assert.equal(p.id, id);
    assert.deepEqual(validatePipeline(p), { ok: true, errors: [] });
    const fullMarks = Object.fromEntries(p.gate.criteria.map(c => [c, 3]));
    assert.equal(scoreArtifact(fullMarks, p.gate).passing, true, `${id} gate unachievable at full marks`);
  }
});

test("classifyDomain routes content/ops outcomes to the right domain", () => {
  assert.equal(classifyDomain("write a blog post about onboarding").domain, "blog");
  assert.equal(classifyDomain("draft a linkedin post for the launch").domain, "social");
  assert.equal(classifyDomain("create a lead magnet checklist").domain, "marketing");
  assert.equal(classifyDomain("write our weekly newsletter").domain, "newsletter");
  assert.equal(classifyDomain("write a case study for Acme").domain, "sales");
  assert.equal(classifyDomain("write a runbook for deploys").domain, "ops");
});
