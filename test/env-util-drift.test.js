// test/env-util-drift.test.js — byte-mirror drift guard for env-util.js
//
// src/env-util.js and plugin/hooks/env-util.js are intentional byte-mirrors
// (self-containment invariant: hooks cannot import from src/). This test
// imports envInt from BOTH locations and asserts identical output across a
// shared case table, making any future divergence an immediate test failure.
//
// Mirrors the approach used by hook-guidance-selfcontained.test.js: machine-
// check the invariant rather than relying on review discipline alone.
import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

// Import both copies. Dynamic imports used (same as hook-env-util.test.js)
// so we can build the path at runtime without fighting ESM static analysis.
const { envInt: envIntSrc  } = await import(path.join(ROOT, "src", "env-util.js"));
const { envInt: envIntHook } = await import(path.join(ROOT, "plugin", "hooks", "env-util.js"));

// ── Shared case table ─────────────────────────────────────────────────────────
// Each entry: [rawValue | undefined, opts, expectedResult, label]
// Values chosen to exercise every branch documented in the JSDoc:
//   absent/empty → def, malformed → def, below-min → def, valid → parsed.
const CASES = [
  // (1) absent / empty → def
  [undefined,  { min: 0, def: 7 },  7,  "undefined value → def"],
  ["",         { min: 0, def: 7 },  7,  "empty string → def"],
  ["   ",      { min: 0, def: 7 },  7,  "whitespace-only → def (trim → empty)"],

  // (2) malformed strings → def
  ["3foo",     { min: 0, def: 5 },  5,  "'3foo' → def (partial integer)"],
  ["2.9",      { min: 0, def: 5 },  5,  "'2.9' → def (float string)"],
  ["abc",      { min: 0, def: 5 },  5,  "'abc' → def (non-numeric)"],
  ["3.0",      { min: 0, def: 5 },  5,  "'3.0' → def (float even if looks integer)"],

  // (3) below-min → def
  ["-1",       { min: 0, def: 5 },  5,  "'-1' below min=0 → def"],
  ["0",        { min: 1, def: 5 },  5,  "'0' below min=1 → def"],

  // (4) valid at or above min → parsed integer
  ["3",        { min: 0, def: 5 },  3,  "'3' at/above min=0 → 3"],
  ["0",        { min: 0, def: 5 },  0,  "'0' at min=0 → 0"],
  ["2",        { min: 2, def: 5 },  2,  "'2' at min=2 → 2 (boundary)"],
  ["-3",       { min: -10, def: 5 }, -3, "'-3' above min=-10 → -3"],

  // (5) min defaults to 0 when absent from opts
  ["7",        { def: 99 },          7,  "'7' with implicit min=0 → 7"],
  ["-1",       { def: 99 },          99, "'-1' with implicit min=0 → def"],
];

for (const [raw, opts, expected, label] of CASES) {
  test(`drift: ${label}`, () => {
    const env = raw === undefined ? {} : { TEST_VAR: raw };
    const resultSrc  = envIntSrc( "TEST_VAR", opts, env);
    const resultHook = envIntHook("TEST_VAR", opts, env);

    // Both copies must return the same value (drift guard).
    assert.equal(
      resultSrc,
      resultHook,
      `src/env-util and plugin/hooks/env-util diverged for case "${label}": ` +
      `src returned ${resultSrc}, hook returned ${resultHook}`,
    );

    // The shared value must also match our expected result (behavior guard).
    assert.equal(
      resultSrc,
      expected,
      `envInt returned ${resultSrc} but expected ${expected} for case "${label}"`,
    );
  });
}
