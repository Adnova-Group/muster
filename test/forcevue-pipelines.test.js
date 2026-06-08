import { test } from "node:test";
import assert from "node:assert/strict";
import { loadPipelines, routePipeline, validatePipeline } from "../src/pipeline.js";
import { classifyDomain } from "../src/domain.js";
import { scoreArtifact } from "../src/score.js";
import { loadCatalog } from "../src/catalog.js";
import { resolveCapabilities } from "../src/capabilities.js";
import { readInstalled } from "../src/harness.js";
import { tmpProject } from "../test-support/helpers.js";

const PIPE = new URL("../pipelines/", import.meta.url);
const newIds = ["book", "epic", "user-story", "launch-plan", "release-notes",
  "executive-summary", "okrs", "competitive-battlecard", "ai-implementation-spec", "ai-test-plan"];

test("new pipelines load, validate, and gates are achievable at full marks", async () => {
  const ps = await loadPipelines(PIPE);
  for (const id of newIds) {
    const p = ps.find(x => x.id === id);
    assert.ok(p, `missing ${id}`);
    assert.deepEqual(validatePipeline(p), { ok: true, errors: [] });
    const full = Object.fromEntries(p.gate.criteria.map(c => [c, 3]));
    assert.equal(scoreArtifact(full, p.gate).passing, true, `${id} gate unachievable`);
  }
});

test("routePipeline picks the right pipeline by outcome (match wins; domain default otherwise)", async () => {
  const ps = await loadPipelines(PIPE);
  const route = (o) => { const { domain } = classifyDomain(o); const p = routePipeline(ps, o, domain); return p ? p.id : null; };
  assert.equal(route("write an epic for checkout"), "epic");
  assert.equal(route("draft a user story"), "user-story");
  assert.equal(route("build a launch plan"), "launch-plan");
  assert.equal(route("write release notes"), "release-notes");
  assert.equal(route("write an executive summary"), "executive-summary");
  assert.equal(route("set our okrs"), "okrs");
  assert.equal(route("make a competitive battlecard"), "competitive-battlecard");
  assert.equal(route("write an implementation spec"), "ai-implementation-spec");
  assert.equal(route("write a test plan"), "ai-test-plan");
  assert.equal(route("write a book about resilience"), "book");
  assert.equal(route("write a PRD for onboarding"), "prd");
  assert.equal(route("build a business case"), "business-case");
});

test("author/research/score roles resolve to built-ins on a bare machine", async () => {
  const home = await tmpProject({});
  const caps = resolveCapabilities(await loadCatalog(new URL("../catalog/", import.meta.url)), await readInstalled(home));
  for (const r of ["author", "research", "score"]) {
    assert.equal(caps.roles[r].chosen.source, "builtin", `${r} not builtin`);
    assert.notEqual(caps.roles[r].chosen.id, "inline");
  }
});
