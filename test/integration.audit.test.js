import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { loadCatalog } from "../src/catalog.js";
import { readInstalled } from "../src/harness.js";
import { resolveCapabilities } from "../src/capabilities.js";
import { validateManifest } from "../src/manifest.js";
import { computeWaves } from "../src/wave.js";
import { buildAuditManifest, AUDIT_DIMENSIONS } from "../src/audit.js";

const CATALOG = new URL("../catalog/", import.meta.url);

const DIM_ROLE = {
  architecture: "architecture-review",
  "tech-debt": "tech-debt",
  coverage: "test-author",
  simplification: "refactor",
  readability: "code-review",
  security: "security-review"
};

test("buildAuditManifest over real capabilities validates with all 6 dimensions resolved", async () => {
  const caps = resolveCapabilities(await loadCatalog(CATALOG), await readInstalled(process.env.HOME || "/tmp"));
  const m = buildAuditManifest(caps);
  assert.deepEqual(validateManifest(m), { ok: true, errors: [] });
  // every dimension maps to its role and is present in the plan
  assert.equal(AUDIT_DIMENSIONS.length, 6);
  for (const d of AUDIT_DIMENSIONS) {
    assert.equal(d.role, DIM_ROLE[d.id], `${d.id} -> ${DIM_ROLE[d.id]}`);
    assert.ok(m.plan.some(t => t.id === `audit-${d.id}`), `plan has audit-${d.id}`);
  }
});

test("the audit fan-out is parallel, then consolidate -> fix -> verify", () => {
  const m = buildAuditManifest({});
  const audits = m.plan.filter(t => t.id.startsWith("audit-"));
  assert.equal(audits.length, 6);
  for (const a of audits) assert.deepEqual(a.deps, [], `${a.id} must fan out (no deps)`);
  const consolidate = m.plan.find(t => t.id === "consolidate");
  for (const a of audits) assert.ok(consolidate.deps.includes(a.id), "consolidate waits on every audit");
  assert.deepEqual(m.plan.find(t => t.id === "fix").deps, ["consolidate"]);
  assert.deepEqual(m.plan.find(t => t.id === "verify").deps, ["fix"]);
  // waves: all 6 audits in wave 0
  const waves = computeWaves(m.plan);
  assert.equal(waves[0].length, 6, "wave 0 is the 6-way parallel sweep");
  assert.equal(waves.at(-1)[0].id, "verify");
});

test("the audit command + README document the mode", async () => {
  const cmd = await readFile(new URL("../plugin/commands/audit.md", import.meta.url), "utf8");
  for (const dim of ["architecture", "tech-debt", "coverage", "simplif", "readab", "security"]) {
    assert.match(cmd, new RegExp(dim, "i"), `audit.md must mention ${dim}`);
  }
  assert.match(cmd, /muster audit/, "audit.md must seed via muster audit");
  const readme = await readFile(new URL("../README.md", import.meta.url), "utf8");
  assert.match(readme, /Audit mode/, "README must document audit mode");
});
