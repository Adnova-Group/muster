import { test } from "node:test";
import assert from "node:assert/strict";
import { validatePipeline, loadPipelines, pipelineForDomain, pickPipeline, routePipeline } from "../src/pipeline.js";

test("validatePipeline accepts a well-formed pipeline", () => {
  const p = { id: "prd", domain: "pm", phases: [{ id: "draft", role: "author" }],
    gate: { criteria: ["clarity"], floor: 2, pass_total: 10 } };
  assert.deepEqual(validatePipeline(p), { ok: true, errors: [] });
});
test("validatePipeline rejects missing phases/gate", () => {
  const r = validatePipeline({ id: "x", domain: "pm" });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some(e => /phases/.test(e)));
  assert.ok(r.errors.some(e => /gate/.test(e)));
});
test("validatePipeline rejects gate missing pass_total", () => {
  const r = validatePipeline({ id: "x", domain: "pm", phases: [{ id: "a", role: "author" }],
    gate: { criteria: ["c"], floor: 2 } });   // no pass_total
  assert.equal(r.ok, false);
  assert.ok(r.errors.some(e => /pass_total/.test(e)));
});
test("loads shipped pipelines and finds PRD by domain", async () => {
  const ps = await loadPipelines(new URL("../pipelines/", import.meta.url));
  assert.ok(ps.length > 0);
  const prd = pipelineForDomain(ps, "pm");
  assert.equal(prd.id, "prd");
  assert.ok(prd.phases.length >= 3);
});
test("business-case pipeline loads and resolves by domain + id", async () => {
  const ps = await loadPipelines(new URL("../pipelines/", import.meta.url));
  const byDomain = pipelineForDomain(ps, "business");
  assert.equal(byDomain.id, "business-case");
  assert.equal(byDomain.domain, "business");
  assert.ok(byDomain.phases.length >= 3);
  assert.ok(byDomain.gate.criteria.includes("roi"));
});

test("pickPipeline routes by earliest match position, not file order", () => {
  const ps = [
    { id: "launch-plan", match: ["launch plan", "product launch"] },
    { id: "video-content", match: ["video script"] },
  ];
  // artifact named at the head wins over subject named at the tail
  assert.equal(pickPipeline(ps, "write a video script about our new product launch").id, "video-content");
  assert.equal(pickPipeline(ps, "write a launch plan for the video tool").id, "launch-plan");
});

test("pickPipeline position ties break by longer phrase, then file order", () => {
  const ps = [
    { id: "a", match: ["launch"] },
    { id: "b", match: ["launch plan"] },
  ];
  assert.equal(pickPipeline(ps, "launch plan for q3").id, "b"); // same index 0, longer phrase wins
  const ps2 = [ { id: "x", match: ["report"] }, { id: "y", match: ["report"] } ];
  assert.equal(pickPipeline(ps2, "quarterly report").id, "x"); // identical -> file order
});

test("pickPipeline returns null when nothing matches", () => {
  const ps = [
    { id: "prd", match: ["prd", "product spec"] },
    { id: "roadmap", match: ["roadmap"] },
  ];
  assert.equal(pickPipeline(ps, "totally unrelated outcome text"), null);
});

test("routePipeline: explicit match wins over the domain default", () => {
  const ps = [
    { id: "prd", domain: "pm", default: true },
    { id: "video-content", domain: "video", match: ["video script"] },
  ];
  const r = routePipeline(ps, "write a video script for our launch", "pm");
  assert.equal(r.id, "video-content");
});

test("routePipeline: no match falls back to the domain default", () => {
  const ps = [
    { id: "roadmap", domain: "pm", match: ["prioritize"] },
    { id: "prd", domain: "pm", default: true },
  ];
  const r = routePipeline(ps, "an outcome with no match keywords at all", "pm");
  assert.equal(r.id, "prd");
});

test("routePipeline: no match and no matching domain -> null", () => {
  const ps = [
    { id: "prd", domain: "pm", default: true },
    { id: "video-content", domain: "video", match: ["video script"] },
  ];
  const r = routePipeline(ps, "an outcome with no match keywords at all", "unknown");
  assert.equal(r, null);
});

test("pipelineForDomain prefers the default:true pipeline when multiple pipelines share a domain", () => {
  const ps = [
    { id: "roadmap", domain: "pm" },
    { id: "prd", domain: "pm", default: true },
  ];
  assert.equal(pipelineForDomain(ps, "pm").id, "prd");
});
