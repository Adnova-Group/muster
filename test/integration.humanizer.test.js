import { test } from "node:test";
import assert from "node:assert/strict";
import { loadPipelines } from "../src/pipeline.js";
import { loadCatalog } from "../src/catalog.js";
import { resolveCapabilities } from "../src/capabilities.js";

// Humanizer domain: human-facing output passes through the humanizer filter;
// machine-facing artifacts do not (preserve technical precision).
const HUMAN_FACING = new Set([
  "prd", "business-case", "epic", "user-story", "launch-plan", "release-notes",
  "executive-summary", "okrs", "competitive-battlecard", "blog-post", "social-post",
  "lead-magnet", "newsletter", "case-study", "runbook", "book"
]);
const MACHINE_FACING = new Set(["ai-implementation-spec", "ai-test-plan"]);

test("every human-facing pipeline ends with a humanize phase", async () => {
  const ps = await loadPipelines(new URL("../pipelines/", import.meta.url));
  for (const id of HUMAN_FACING) {
    const p = ps.find(x => x.id === id);
    assert.ok(p, `missing pipeline ${id}`);
    const last = p.phases[p.phases.length - 1];
    assert.equal(last.id, "humanize", `${id} must END with a humanize phase`);
    assert.equal(last.role, "humanize", `${id} humanize phase must use the humanize role`);
  }
});

test("machine-facing pipelines never humanize (preserve technical precision)", async () => {
  const ps = await loadPipelines(new URL("../pipelines/", import.meta.url));
  for (const id of MACHINE_FACING) {
    const p = ps.find(x => x.id === id);
    assert.ok(p, `missing pipeline ${id}`);
    assert.ok(!p.phases.some(ph => ph.role === "humanize"), `${id} must NOT contain a humanize phase`);
  }
});

test("the humanize role resolves to the muster-humanizer built-in", async () => {
  const catalog = await loadCatalog(new URL("../catalog/", import.meta.url));
  const caps = resolveCapabilities(catalog, { plugins: [], skills: [], mcpServers: [] });
  const role = caps.roles["humanize"];
  assert.ok(role, "humanize role missing from capabilities");
  assert.equal(role.chosen.id, "muster-humanizer");
  assert.equal(role.chosen.source, "builtin");
});
