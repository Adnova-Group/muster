import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  DIAGNOSTIC_CONTENT_MAX_BYTES,
  classifyFailure,
  buildDiagnoseManifest
} from "../src/diagnose.js";
import { validateManifest } from "../src/manifest.js";
import { modelForRole } from "../src/model.js";

test("classifyFailure: test/CI output -> ci", () => {
  assert.equal(classifyFailure("FAIL test/foo.test.js\n  at x.js:3").mode, "ci");
});
test("classifyFailure: prose symptom -> bug", () => {
  assert.equal(classifyFailure("the login button sometimes does nothing").mode, "bug");
});
test("classifyFailure: --ci flag forces ci", () => {
  assert.equal(classifyFailure("anything", { ci: true }).mode, "ci");
});
test("classifyFailure: empty throws", () => {
  assert.throws(() => classifyFailure("  "), /empty/);
});

test("diagnose preserves a long failure for reproduction while keeping its display label capped", () => {
  const discriminator = "UNIQUE-DISCRIMINATOR-AFTER-CHAR-200";
  const input = `${"x".repeat(460)}${discriminator}`.padEnd(500, "z");
  const failure = classifyFailure(input);
  const manifest = buildDiagnoseManifest(failure, caps);
  const repro = manifest.plan.find(task => task.id === "repro");

  assert.equal(input.length, 500);
  assert.equal(failure.signal.length, 200, "UI-facing failure label stays capped");
  assert.ok(!failure.signal.includes(discriminator), "the discriminator exercises content beyond the label");
  assert.equal(repro.diagnostic.encoding, "base64");
  assert.equal(
    Buffer.from(repro.diagnostic.contentBase64, "base64").toString("utf8"),
    input,
    "the reproduction task can recover the exact diagnostic without raw prompt content"
  );
  assert.equal(repro.diagnostic.length, input.length);
  assert.match(repro.diagnostic.sha256, /^[a-f0-9]{64}$/);
});

test("diagnose bounds oversized diagnostic content but retains its full-input digest", () => {
  const input = `prefix-${"q".repeat(DIAGNOSTIC_CONTENT_MAX_BYTES)}-tail`;
  const failure = classifyFailure(input);
  const differentTail = classifyFailure(`${input.slice(0, -1)}X`);

  assert.equal(failure.diagnostic.contentBase64, null);
  assert.equal(failure.diagnostic.truncated, true);
  assert.ok(failure.diagnostic.bytes > DIAGNOSTIC_CONTENT_MAX_BYTES);
  assert.equal(
    failure.diagnostic.sha256,
    createHash("sha256").update(input, "utf8").digest("hex"),
    "digest covers the complete oversized input"
  );
  assert.notEqual(failure.diagnostic.sha256, differentTail.diagnostic.sha256);
});

const caps = { roles: {
  debug: { chosen: { id: "sp-debug", source: "builtin" }, recommendations: ["install wshobson debugging agents for debug"] },
  implement: { chosen: { id: "wsh-api-design-principles", source: "builtin" }, recommendations: [] },
  "test-author": { chosen: { id: "sp-tdd", source: "builtin" }, recommendations: [] },
  "code-review": { chosen: { id: "superpowers", source: "installed" }, recommendations: [] }
}};

test("buildDiagnoseManifest produces a valid fix manifest", () => {
  const m = buildDiagnoseManifest(classifyFailure("x is null"), caps);
  assert.deepEqual(validateManifest(m), { ok: true, errors: [] });
  assert.deepEqual(m.plan.map(p => p.id), ["repro", "root-cause", "fix", "regression", "verify"]);
  assert.ok(m.crew.some(c => c.stage === "debug" && c.provider === "sp-debug"));
  assert.ok(m.recommendations.some(r => /wshobson/.test(r)));
});

// Regression: the resolved per-role model must travel WITH the crew member the
// orchestrator dispatches — not live only in caps as a separate lookup the prose
// can drop. A dropped override silently inherits the orchestrator's model (Opus).
test("every diagnose crew member carries the model resolved for its role", () => {
  const m = buildDiagnoseManifest(classifyFailure("x is null"), caps);
  for (const c of m.crew) {
    assert.equal(c.model, modelForRole(c.stage), `crew stage ${c.stage} model`);
  }
});

test("diagnose crew binds caps.roles[role].model when the caps map provides one", () => {
  const richCaps = { roles: {
    debug: { chosen: { id: "d", source: "builtin" }, model: "opus", recommendations: [] },
    implement: { chosen: { id: "i", source: "builtin" }, model: "fable", recommendations: [] },
    "test-author": { chosen: { id: "t", source: "builtin" }, model: "sonnet", recommendations: [] },
    "code-review": { chosen: { id: "c", source: "builtin" }, model: "haiku", recommendations: [] }
  }};
  const m = buildDiagnoseManifest(classifyFailure("x"), richCaps);
  assert.equal(m.crew.find(c => c.stage === "debug").model, "opus");
  assert.equal(m.crew.find(c => c.stage === "implement").model, "fable");
  assert.equal(m.crew.find(c => c.stage === "code-review").model, "haiku");
});
