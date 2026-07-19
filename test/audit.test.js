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

test("prompting projects get a 7th prompt-quality dimension; plain projects do not", () => {
  const plain = buildAuditManifest({});
  assert.ok(!plain.plan.some(p => p.id === "audit-prompt-quality"), "no prompt dim by default");

  const m = buildAuditManifest({}, { prompting: true });
  const audits = m.plan.filter(p => p.id.startsWith("audit-"));
  assert.equal(audits.length, 7, "prompting adds a 7th dimension");
  const pq = m.plan.find(p => p.id === "audit-prompt-quality");
  assert.ok(pq, "audit-prompt-quality task present");
  assert.deepEqual(pq.deps, []);
  assert.ok(m.crew.some(c => c.stage === "prompt-quality"), "prompt-quality crew member present");
  // consolidate now waits on all 7
  assert.equal(m.plan.find(p => p.id === "consolidate").deps.length, 7);
  assert.ok(validateManifest(m).ok, "prompting manifest still validates");
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
  // architecture-review is heavy judgment -> top tier, which degrades fable->opus by
  // default (fable disabled platform-wide); the rest default to sonnet.
  assert.equal(m.crew.find(c => c.stage === "architecture-review").model, "opus");
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

// ── backlog mode (read-only sweep -> ranked capture, no fix/verify waves) ────
// Parity with the $muster-audit skill's backlog mode (plugin/commands/audit.md):
// same read-only dimension sweep + consolidate, then WRITE a ranked backlog instead
// of fixing. The remediation crew (implement + review-gate) and the fix/verify plan
// stages are dropped; a single read-only `capture` stage replaces them.
test("backlog mode: drops the fix/verify plan stages for a single capture stage after consolidate", () => {
  const m = buildAuditManifest({}, { backlog: true });
  assert.ok(validateManifest(m).ok, `backlog manifest must validate: ${JSON.stringify(validateManifest(m).errors)}`);
  const ids = m.plan.map(p => p.id);
  assert.ok(!ids.includes("fix"), "no fix stage in backlog mode");
  assert.ok(!ids.includes("verify"), "no verify stage in backlog mode");
  const capture = m.plan.find(p => p.id === "capture");
  assert.ok(capture, "capture stage present");
  assert.deepEqual(capture.deps, ["consolidate"], "capture waits on the consolidated ledger");
  // the read-only sweep is unchanged: 6 dimensions fanned out, consolidate waits on all 6
  assert.equal(m.plan.filter(p => p.id.startsWith("audit-")).length, 6);
  assert.equal(m.plan.find(p => p.id === "consolidate").deps.length, 6);
});

test("backlog mode: no remediation crew (implement + review-gate); dimension reviewers remain", () => {
  const m = buildAuditManifest({}, { backlog: true });
  assert.ok(!m.crew.some(c => c.stage === "implement"), "no implement/remediate crew member");
  // the readability dimension's role IS code-review; only the extra review-gate member drops,
  // so exactly one code-review crew member (the dimension) survives.
  assert.equal(m.crew.filter(c => c.stage === "code-review").length, 1, "only the readability dimension's code-review remains");
  for (const dim of AUDIT_DIMENSIONS) {
    assert.ok(m.crew.some(c => c.stage === dim.role), `dimension role ${dim.role} still present`);
  }
});

test("backlog mode waves: audits fan out -> consolidate -> capture (3 waves, no fix/verify tail)", () => {
  const m = buildAuditManifest({}, { backlog: true });
  const waves = computeWaves(m.plan);
  assert.deepEqual(waves[0].map(t => t.id).sort(), AUDIT_DIMENSIONS.map(d => `audit-${d.id}`).sort());
  assert.deepEqual(waves[1].map(t => t.id), ["consolidate"]);
  assert.deepEqual(waves[2].map(t => t.id), ["capture"]);
  assert.equal(waves.length, 3);
});

test("backlog mode: prompting projects still add the 7th dimension", () => {
  const m = buildAuditManifest({}, { backlog: true, prompting: true });
  assert.equal(m.plan.filter(p => p.id.startsWith("audit-")).length, 7);
  assert.equal(m.plan.find(p => p.id === "consolidate").deps.length, 7);
  assert.ok(!m.plan.some(p => p.id === "fix" || p.id === "verify"));
});

// ── scoped mode (paths) ─────────────────────────────────────────────────────
test("paths scope: outcome + audit task text name the scope; default (no paths) leaks nothing", () => {
  const scoped = buildAuditManifest({}, { paths: ["src/audit.js", "cowork/"] });
  assert.ok(validateManifest(scoped).ok);
  assert.match(scoped.outcome, /src\/audit\.js/, "outcome names the scope");
  assert.match(scoped.plan.find(p => p.id === "audit-security").task, /src\/audit\.js/, "audit task names the scope");
  const plain = buildAuditManifest({});
  assert.equal(plain.outcome, "Audit + remediate the codebase", "default outcome unchanged");
  assert.doesNotMatch(plain.plan.find(p => p.id === "audit-security").task, /scope:/i, "no scope leakage by default");
});

test("backlog + paths compose: scoped, read-only, capture-only", () => {
  const m = buildAuditManifest({}, { backlog: true, paths: ["src/"] });
  assert.ok(validateManifest(m).ok);
  assert.ok(!m.plan.some(p => p.id === "fix" || p.id === "verify"), "no fix/verify");
  assert.ok(m.plan.some(p => p.id === "capture"), "capture present");
  assert.match(m.outcome, /src\//, "scope named");
  assert.match(m.outcome, /read-only|backlog/i, "read-only intent stated");
});

test("default mode is unchanged: no opts === {backlog:false, paths:[]}", () => {
  assert.deepEqual(buildAuditManifest({}), buildAuditManifest({}, { backlog: false, paths: [] }));
});
