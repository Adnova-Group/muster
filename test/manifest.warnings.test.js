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

// ---------------------------------------------------------------------------
// Inventory-aware warnings: a bound skill id that does not resolve in the live
// skills inventory (resolveCapabilities().skills), and a skills binding that implies
// a surface the task explicitly set to "none".
// ---------------------------------------------------------------------------

const skillsInventory = [
  { id: "muster-builder", source: "builtin", description: "" },
  { id: "nextjs", source: "installed", description: "" },
];

test("manifestWarnings: a bound skill id absent from the inventory warns", () => {
  const m = {
    ...base,
    plan: [{ id: "t1", task: "wire up routing", mode: "single",
      skills: [{ id: "totally-fake-nonexistent-skill", rationale: "r" }] }],
  };
  const w = manifestWarnings(m, skillsInventory);
  assert.equal(w.length, 1);
  assert.match(w[0], /totally-fake-nonexistent-skill/);
  assert.match(w[0], /t1/);
  assert.match(w[0], /inventory|resolve/i);
});

test("manifestWarnings: a bound skill id present in the inventory does not warn", () => {
  const m = {
    ...base,
    plan: [{ id: "t1", task: "implement", mode: "single",
      skills: [{ id: "muster-builder", rationale: "r" }] }],
  };
  assert.deepEqual(manifestWarnings(m, skillsInventory), []);
});

test("manifestWarnings: bound skill id resolves namespace-insensitively (vendor:nextjs vs nextjs)", () => {
  const m = {
    ...base,
    plan: [{ id: "t1", task: "build the app", mode: "single",
      skills: [{ id: "vendor:nextjs", rationale: "r" }] }],
  };
  assert.deepEqual(manifestWarnings(m, skillsInventory), []);
});

test("manifestWarnings: multiple unresolved skill ids each get their own warning", () => {
  const m = {
    ...base,
    plan: [{ id: "t1", task: "x", mode: "single",
      skills: [{ id: "fake-one", rationale: "r" }, { id: "fake-two", rationale: "r" }] }],
  };
  const w = manifestWarnings(m, skillsInventory);
  assert.equal(w.length, 2);
  assert.ok(w.some(x => /fake-one/.test(x)));
  assert.ok(w.some(x => /fake-two/.test(x)));
});

test("manifestWarnings: no inventory param supplied skips the bound-skill-id check (back-compat)", () => {
  // Existing callers that don't pass a skills inventory (resolveCapabilities() wasn't
  // run) get no inventory-based warning rather than a false positive on every binding.
  const m = {
    ...base,
    plan: [{ id: "t1", task: "x", mode: "single",
      skills: [{ id: "totally-fake-nonexistent-skill", rationale: "r" }] }],
  };
  assert.deepEqual(manifestWarnings(m), []);
});

test("manifestWarnings: an explicitly empty inventory flags every bound skill as unresolved", () => {
  const m = {
    ...base,
    plan: [{ id: "t1", task: "x", mode: "single",
      skills: [{ id: "muster-builder", rationale: "r" }] }],
  };
  const w = manifestWarnings(m, []);
  assert.equal(w.length, 1);
  assert.match(w[0], /muster-builder/);
});

test("manifestWarnings: a UI-implying skill binding on a surface:none task warns", () => {
  const m = {
    ...base,
    plan: [{ id: "t1", task: "build the settings page", mode: "single", surface: "none",
      skills: [{ id: "frontend-design", rationale: "r" }] }],
  };
  const w = manifestWarnings(m, skillsInventory.concat({ id: "frontend-design", source: "builtin" }));
  assert.ok(w.some(x => /t1/.test(x) && /surface/i.test(x) && /ui/.test(x)),
    `expected a surface-mismatch warning, got ${JSON.stringify(w)}`);
});

test("manifestWarnings: a copy-implying skill binding on a surface:none task warns", () => {
  const m = {
    ...base,
    plan: [{ id: "t1", task: "write the launch copy", mode: "single", surface: "none",
      skills: [{ id: "muster-humanizer", rationale: "r" }] }],
  };
  const w = manifestWarnings(m, skillsInventory.concat({ id: "muster-humanizer", source: "builtin" }));
  assert.ok(w.some(x => /surface/i.test(x) && /copy/.test(x)),
    `expected a surface-mismatch warning, got ${JSON.stringify(w)}`);
});

test("manifestWarnings: an integration-implying skill binding on a surface:none task warns", () => {
  const m = {
    ...base,
    plan: [{ id: "t1", task: "call the billing webhook", mode: "single", surface: "none",
      skills: [{ id: "sp-verify", rationale: "r" }] }],
  };
  const w = manifestWarnings(m, skillsInventory.concat({ id: "sp-verify", source: "builtin" }));
  assert.ok(w.some(x => /surface/i.test(x) && /integration/.test(x)),
    `expected a surface-mismatch warning, got ${JSON.stringify(w)}`);
});

test("manifestWarnings: a UI-implying skill binding with a matching surface does not warn", () => {
  const m = {
    ...base,
    plan: [{ id: "t1", task: "build the settings page", mode: "single", surface: "ui",
      skills: [{ id: "frontend-design", rationale: "r" }] }],
  };
  const w = manifestWarnings(m, skillsInventory.concat({ id: "frontend-design", source: "builtin" }));
  assert.ok(!w.some(x => /surface/i.test(x)), `expected no surface warning, got ${JSON.stringify(w)}`);
});

test("manifestWarnings: a surface-implying skill with surface left unset (undefined) does not warn — only explicit \"none\" triggers it", () => {
  const m = {
    ...base,
    plan: [{ id: "t1", task: "build the settings page", mode: "single",
      skills: [{ id: "frontend-design", rationale: "r" }] }],
  };
  const w = manifestWarnings(m, skillsInventory.concat({ id: "frontend-design", source: "builtin" }));
  assert.ok(!w.some(x => /surface/i.test(x)), `expected no surface warning, got ${JSON.stringify(w)}`);
});

test("manifestWarnings: a non-surface-implying skill binding on a surface:none task does not warn", () => {
  const m = {
    ...base,
    plan: [{ id: "t1", task: "refactor internals", mode: "single", surface: "none",
      skills: [{ id: "muster-builder", rationale: "r" }] }],
  };
  assert.deepEqual(manifestWarnings(m, skillsInventory), []);
});

test("manifestWarnings: surface-mismatch check runs independent of the inventory param (no inventory passed)", () => {
  const m = {
    ...base,
    plan: [{ id: "t1", task: "build the settings page", mode: "single", surface: "none",
      skills: [{ id: "frontend-design", rationale: "r" }] }],
  };
  const w = manifestWarnings(m);
  assert.ok(w.some(x => /surface/i.test(x) && /ui/.test(x)),
    `expected a surface-mismatch warning even without an inventory, got ${JSON.stringify(w)}`);
});
