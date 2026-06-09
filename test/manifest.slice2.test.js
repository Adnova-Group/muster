import { test } from "node:test";
import assert from "node:assert/strict";
import { validateManifest } from "../src/manifest.js";

const base = {
  outcome: "x", successCriteria: ["c"],
  crew: [{ stage: "s", provider: "p", source: "builtin", model: "sonnet", rationale: "r", evidence: "e", fallback: "inline" }],
  recommendations: [], degradations: []
};

test("accepts multi-task plan with unique ids + valid deps", () => {
  const m = { ...base, plan: [
    { id: "a", task: "A", mode: "single", deps: [] },
    { id: "b", task: "B", mode: "tournament", deps: ["a"] }
  ]};
  assert.deepEqual(validateManifest(m), { ok: true, errors: [] });
});

test("rejects duplicate ids", () => {
  const m = { ...base, plan: [
    { id: "a", task: "A", mode: "single", deps: [] },
    { id: "a", task: "B", mode: "single", deps: [] }
  ]};
  const r = validateManifest(m);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some(e => /duplicate id/.test(e)));
});

test("rejects deps referencing unknown id", () => {
  const m = { ...base, plan: [{ id: "a", task: "A", mode: "single", deps: ["ghost"] }] };
  const r = validateManifest(m);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some(e => /unknown dep/.test(e)));
});

test("slice-1 back-compat: single task without id/deps still valid", () => {
  const m = { ...base, plan: [{ task: "only", mode: "single" }] };
  assert.deepEqual(validateManifest(m), { ok: true, errors: [] });
});
