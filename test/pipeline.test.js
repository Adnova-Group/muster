import { test } from "node:test";
import assert from "node:assert/strict";
import { validatePipeline, loadPipelines, pipelineForDomain } from "../src/pipeline.js";

test("validatePipeline accepts a well-formed pipeline", () => {
  const p = { id: "prd", domain: "pm", phases: [{ id: "draft", role: "author" }],
    gate: { criteria: ["clarity"], floor: 2 } };
  assert.deepEqual(validatePipeline(p), { ok: true, errors: [] });
});
test("validatePipeline rejects missing phases/gate", () => {
  const r = validatePipeline({ id: "x", domain: "pm" });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some(e => /phases/.test(e)));
  assert.ok(r.errors.some(e => /gate/.test(e)));
});
test("loads shipped pipelines and finds PRD by domain", async () => {
  const ps = await loadPipelines(new URL("../pipelines/", import.meta.url));
  assert.ok(ps.length > 0);
  const prd = pipelineForDomain(ps, "pm");
  assert.equal(prd.id, "prd");
  assert.ok(prd.phases.length >= 3);
});
