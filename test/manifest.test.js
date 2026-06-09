import { test } from "node:test";
import assert from "node:assert/strict";
import { validateManifest } from "../src/manifest.js";

const valid = {
  outcome: "Add rate limiting",
  successCriteria: ["429 past N req/min", "tests green"],
  crew: [{ stage: "navigate", provider: "grep", source: "builtin", model: "sonnet",
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

// A non-inline crew member dispatches to a specific provider on a specific model.
// If the resolved model isn't bound to the member, dispatch silently inherits the
// orchestrator's model (Opus). The manifest must carry it, or validation fails loud.
test("rejects a non-inline crew member with no model", () => {
  const noModel = { stage: "implement", provider: "muster-builder", source: "builtin",
                    rationale: "r", evidence: "e", fallback: "inline" };
  const r = validateManifest({ ...valid, crew: [noModel] });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some(e => /model/.test(e)), `expected a model error, got ${JSON.stringify(r.errors)}`);
});

test("rejects an unknown model tier", () => {
  const badModel = { stage: "implement", provider: "x", source: "builtin", model: "gpt-4",
                     rationale: "r", evidence: "e", fallback: "inline" };
  const r = validateManifest({ ...valid, crew: [badModel] });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some(e => /model/.test(e)));
});

test("accepts fable as a model tier (top tier, ready for routing)", () => {
  const fableMember = { stage: "judge", provider: "x", source: "builtin", model: "fable",
                        rationale: "r", evidence: "e", fallback: "inline" };
  const r = validateManifest({ ...valid, crew: [fableMember] });
  assert.deepEqual(r, { ok: true, errors: [] });
});

test("inline crew member is exempt from the model requirement", () => {
  const inlineMember = { stage: "x", provider: "inline", source: "inline",
                         rationale: "r", evidence: "e", fallback: "inline" };
  const r = validateManifest({ ...valid, crew: [inlineMember] });
  assert.deepEqual(r, { ok: true, errors: [] });
});
