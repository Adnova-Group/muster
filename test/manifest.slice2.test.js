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

test("accepts plan[].owns and plan[].frozen as arrays of non-empty strings", () => {
  const m = { ...base, plan: [
    { id: "a", task: "A", mode: "single", owns: ["src/manifest.js", "test/manifest.test.js"], frozen: ["plugin/**"] }
  ]};
  assert.deepEqual(validateManifest(m), { ok: true, errors: [] });
});

test("owns/frozen are optional — absent is valid", () => {
  const m = { ...base, plan: [{ id: "a", task: "A", mode: "single" }] };
  assert.deepEqual(validateManifest(m), { ok: true, errors: [] });
});

test("rejects plan[].owns that is not an array", () => {
  const m = { ...base, plan: [{ id: "a", task: "A", mode: "single", owns: "src/manifest.js" }] };
  const r = validateManifest(m);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some(e => e === "plan[0].owns must be an array of non-empty strings"),
    `expected owns-shape error, got ${JSON.stringify(r.errors)}`);
});

test("rejects plan[].frozen that is not an array", () => {
  const m = { ...base, plan: [{ id: "a", task: "A", mode: "single", frozen: 42 }] };
  const r = validateManifest(m);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some(e => e === "plan[0].frozen must be an array of non-empty strings"),
    `expected frozen-shape error, got ${JSON.stringify(r.errors)}`);
});

test("rejects plan[].owns containing a non-string entry", () => {
  const m = { ...base, plan: [{ id: "a", task: "A", mode: "single", owns: ["src/x.js", 7] }] };
  const r = validateManifest(m);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some(e => e === "plan[0].owns must be an array of non-empty strings"));
});

test("rejects plan[].frozen containing an empty/whitespace-only string", () => {
  const m = { ...base, plan: [{ id: "a", task: "A", mode: "single", frozen: ["plugin/**", "   "] }] };
  const r = validateManifest(m);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some(e => e === "plan[1].frozen must be an array of non-empty strings")
    || r.errors.some(e => e === "plan[0].frozen must be an array of non-empty strings"));
});

test("accepts plan[].owns and plan[].frozen as empty arrays", () => {
  const m = { ...base, plan: [{ id: "a", task: "A", mode: "single", owns: [], frozen: [] }] };
  assert.deepEqual(validateManifest(m), { ok: true, errors: [] });
});

test("rejects plan[2].owns with path-specific index in error message", () => {
  const m = { ...base, plan: [
    { id: "a", task: "A", mode: "single" },
    { id: "b", task: "B", mode: "single" },
    { id: "c", task: "C", mode: "single", owns: [""] }
  ]};
  const r = validateManifest(m);
  assert.equal(r.ok, false);
  assert.ok(r.errors.includes("plan[2].owns must be an array of non-empty strings"),
    `expected plan[2] path in error, got ${JSON.stringify(r.errors)}`);
});
