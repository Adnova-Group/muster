import { test } from "node:test";
import assert from "node:assert/strict";
import { validateManifest } from "../src/manifest.js";

const base = {
  outcome: "x", successCriteria: ["c"],
  crew: [{ stage: "s", provider: "p", source: "builtin", model: "sonnet", rationale: "r", evidence: "e", fallback: "inline" }],
  recommendations: [], degradations: [],
  plan: [{ task: "only", mode: "single" }],
};

test("forbiddenActions is absent by default and that's valid", () => {
  assert.deepEqual(validateManifest(base), { ok: true, errors: [] });
});

test("accepts a top-level forbiddenActions drawn from the fixed action-class set", () => {
  const m = { ...base, forbiddenActions: ["send", "sign", "submit", "publish", "purchase", "delete-remote"] };
  assert.deepEqual(validateManifest(m), { ok: true, errors: [] });
});

test("accepts an empty forbiddenActions array", () => {
  const m = { ...base, forbiddenActions: [] };
  assert.deepEqual(validateManifest(m), { ok: true, errors: [] });
});

test("rejects an unknown top-level forbiddenActions class with a path-specific error", () => {
  const m = { ...base, forbiddenActions: ["send", "teleport"] };
  const r = validateManifest(m);
  assert.equal(r.ok, false);
  assert.ok(
    r.errors.some((e) => e.includes("forbiddenActions[1]") && e.includes("teleport")),
    `expected path-specific unknown-class error, got ${JSON.stringify(r.errors)}`,
  );
});

test("rejects a non-array top-level forbiddenActions", () => {
  const m = { ...base, forbiddenActions: "send" };
  const r = validateManifest(m);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.includes("forbiddenActions")), `expected forbiddenActions error, got ${JSON.stringify(r.errors)}`);
});

test("accepts per-task forbiddenActions drawn from the fixed action-class set", () => {
  const m = { ...base, plan: [{ task: "only", mode: "single", forbiddenActions: ["publish"] }] };
  assert.deepEqual(validateManifest(m), { ok: true, errors: [] });
});

test("accepts an empty per-task forbiddenActions array", () => {
  const m = { ...base, plan: [{ task: "only", mode: "single", forbiddenActions: [] }] };
  assert.deepEqual(validateManifest(m), { ok: true, errors: [] });
});

test("rejects an unknown per-task forbiddenActions class with a path-specific error naming the plan index", () => {
  const m = { ...base, plan: [{ task: "only", mode: "single", forbiddenActions: ["nuke"] }] };
  const r = validateManifest(m);
  assert.equal(r.ok, false);
  assert.ok(
    r.errors.some((e) => e.includes("plan[0].forbiddenActions") && e.includes("nuke")),
    `expected plan[0]-scoped unknown-class error, got ${JSON.stringify(r.errors)}`,
  );
});

test("rejects a non-array per-task forbiddenActions", () => {
  const m = { ...base, plan: [{ task: "only", mode: "single", forbiddenActions: "publish" }] };
  const r = validateManifest(m);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.includes("plan[0].forbiddenActions")), `expected error, got ${JSON.stringify(r.errors)}`);
});

test("per-task forbiddenActions error names the correct plan index among multiple tasks", () => {
  const m = {
    ...base,
    plan: [
      { id: "a", task: "A", mode: "single" },
      { id: "b", task: "B", mode: "single", forbiddenActions: ["bogus"] },
    ],
  };
  const r = validateManifest(m);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.includes("plan[1].forbiddenActions") && e.includes("bogus")));
});
