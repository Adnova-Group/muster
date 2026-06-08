import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyFailure, buildDiagnoseManifest } from "../src/diagnose.js";
import { validateManifest } from "../src/manifest.js";

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

const caps = { roles: {
  debug: { chosen: { id: "sp-debug", source: "builtin" }, recommendations: ["install wshobson debugging agents for debug"] },
  implement: { chosen: { id: "sp-debug", source: "builtin" }, recommendations: [] },
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
