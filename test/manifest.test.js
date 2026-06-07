import { test } from "node:test";
import assert from "node:assert/strict";
import { validateManifest } from "../src/manifest.js";

const valid = {
  outcome: "Add rate limiting",
  successCriteria: ["429 past N req/min", "tests green"],
  crew: [{ stage: "navigate", provider: "grep", source: "builtin",
           rationale: "no LSP", evidence: "no serena", fallback: "inline" }],
  recommendations: ["install serena"],
  degradations: ["nav fell to builtin"],
  plan: [{ task: "middleware", mode: "single" }]
};

test("accepts a well-formed manifest", () => {
  assert.deepEqual(validateManifest(valid), { ok: true, errors: [] });
});

test("rejects missing outcome / empty success criteria", () => {
  const r = validateManifest({ ...valid, outcome: "", successCriteria: [] });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some(e => /outcome/.test(e)));
  assert.ok(r.errors.some(e => /successCriteria/.test(e)));
});

test("rejects bad source and bad plan mode", () => {
  const r = validateManifest({
    ...valid,
    crew: [{ ...valid.crew[0], source: "magic" }],
    plan: [{ task: "x", mode: "parallel" }]
  });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some(e => /source/.test(e)));
  assert.ok(r.errors.some(e => /mode/.test(e)));
});
