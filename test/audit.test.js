import { test } from "node:test";
import assert from "node:assert/strict";
import { AUDIT_DIMENSIONS, buildAuditManifest } from "../src/audit.js";
import { validateManifest } from "../src/manifest.js";
import { computeWaves } from "../src/wave.js";
import { modelForRole } from "../src/model.js";

// Ensure MUSTER_MAX_TIER never leaks in from the caller's environment and
// silently makes tier assertions wrong. Mirror agents.muster.test.js.
delete process.env.MUSTER_MAX_TIER;

const EXPECTED_ROLES = {
  architecture: "architecture-review",
  "tech-debt": "tech-debt",
  coverage: "test-author",
  simplification: "refactor",
  readability: "code-review",
  security: "security-review"
};

test("buildAuditManifest({}) passes validateManifest", () => {
  const m = buildAuditManifest({});
  const r = validateManifest(m);
  assert.ok(r.ok, `expected valid manifest, got errors: ${JSON.stringify(r.errors)}`);
});

test("plan has exactly 6 audit-* tasks, all with empty deps", () => {
  const m = buildAuditManifest({});
  const audits = m.plan.filter(p => p.id.startsWith("audit-"));
  assert.equal(audits.length, 6);
  for (const a of audits) assert.deepEqual(a.deps, []);
});

test("consolidate/fix/verify dependency chain", () => {
  const m = buildAuditManifest({});
  const auditIds = m.plan.filter(p => p.id.startsWith("audit-")).map(p => p.id);
  const consolidate = m.plan.find(p => p.id === "consolidate");
  const fix = m.plan.find(p => p.id === "fix");
  const verify = m.plan.find(p => p.id === "verify");
  for (const id of auditIds) assert.ok(consolidate.deps.includes(id), `consolidate missing dep ${id}`);
  assert.equal(consolidate.deps.length, 6);
  assert.deepEqual(fix.deps, ["consolidate"]);
  assert.deepEqual(verify.deps, ["fix"]);
});

test("each dimension audit task + crew maps to expected role", () => {
  const m = buildAuditManifest({});
  for (const dim of AUDIT_DIMENSIONS) {
    assert.equal(dim.role, EXPECTED_ROLES[dim.id], `dimension ${dim.id} role`);
    const task = m.plan.find(p => p.id === `audit-${dim.id}`);
    assert.ok(task, `missing audit task for ${dim.id}`);
    const crewEntry = m.crew.find(c => c.stage === dim.role);
    assert.ok(crewEntry, `missing crew entry for role ${dim.role}`);
  }
});

test("computeWaves fans out audits then chains consolidate/fix/verify", () => {
  const m = buildAuditManifest({});
  const waves = computeWaves(m.plan);
  const wave0 = waves[0].map(t => t.id).sort();
  assert.deepEqual(wave0, AUDIT_DIMENSIONS.map(d => `audit-${d.id}`).sort());
  assert.deepEqual(waves[1].map(t => t.id), ["consolidate"]);
  assert.deepEqual(waves[2].map(t => t.id), ["fix"]);
  assert.deepEqual(waves[3].map(t => t.id), ["verify"]);
  assert.equal(waves.length, 4);
});

test("every audit crew member carries the model resolved for its role", () => {
  const m = buildAuditManifest({});
  for (const c of m.crew) {
    assert.equal(c.model, modelForRole(c.stage), `crew stage ${c.stage} model`);
  }
  // architecture-review is heavy judgment -> fable (top tier); the rest default to sonnet.
  assert.equal(m.crew.find(c => c.stage === "architecture-review").model, "fable");
});

test("chosen provider for a role surfaces in crew", () => {
  const caps = {
    roles: {
      "security-review": {
        chosen: { id: "ext-sec", source: "installed" },
        recommendations: ["install audit-tool"]
      }
    }
  };
  const m = buildAuditManifest(caps);
  const secCrew = m.crew.find(c => c.stage === "security-review");
  assert.equal(secCrew.provider, "ext-sec");
  assert.equal(secCrew.source, "installed");
  assert.ok(m.recommendations.includes("install audit-tool"));
});
