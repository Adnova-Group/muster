import { test } from "node:test";
import assert from "node:assert/strict";
import { manifestWarnings, validateManifest } from "../src/manifest.js";

const base = {
  outcome: "Ship the 0.4.0 bundle",
  successCriteria: ["build clean", "tests green"],
  recommendations: [],
  degradations: [],
  plan: [{ task: "do it", mode: "single" }],
};

const inlineMember = { stage: "build", provider: "inline", source: "inline", rationale: "r", evidence: "e", fallback: "inline" };
const builtinMember = { stage: "implement", provider: "muster-builder", source: "builtin", rationale: "r", evidence: "e", fallback: "inline" };

test("manifestWarnings: all-inline crew warns about a likely routing bypass", () => {
  const w = manifestWarnings({ ...base, crew: [inlineMember, { ...inlineMember, stage: "verify" }] });
  assert.equal(w.length, 1);
  assert.match(w[0], /inline/i);
  assert.match(w[0], /capabilities/i);
});

test("manifestWarnings: a crew with any non-inline member does not warn", () => {
  assert.deepEqual(manifestWarnings({ ...base, crew: [builtinMember, inlineMember] }), []);
});

test("manifestWarnings: empty/invalid crew yields no warning (errors handle that)", () => {
  assert.deepEqual(manifestWarnings({ ...base, crew: [] }), []);
  assert.deepEqual(manifestWarnings({ ...base }), []);
});

test("validateManifest contract is unchanged (no warnings key)", () => {
  // An all-inline crew is still structurally VALID — the warning is advisory, not an error.
  const r = validateManifest({ ...base, crew: [inlineMember] });
  assert.deepEqual(r, { ok: true, errors: [] });
});
