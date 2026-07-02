/**
 * Tests for src/env-util.js: envInt
 *
 * TDD: written to encode the intended behavior. Run with `node --test`.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { envInt, isPlainObject } from "../src/env-util.js";

// ---------------------------------------------------------------------------
// Helper: build a fake env object
// ---------------------------------------------------------------------------
const e = (val) => ({ MY_VAR: val });

// ---------------------------------------------------------------------------
// 1. Undefined / empty-string -> default
// ---------------------------------------------------------------------------

test("envInt: undefined variable returns def", () => {
  assert.equal(envInt("MY_VAR", { min: 0, def: 5 }, {}), 5);
});

test("envInt: empty-string value returns def", () => {
  assert.equal(envInt("MY_VAR", { min: 0, def: 5 }, e("")), 5);
});

// ---------------------------------------------------------------------------
// 2. Valid integer strings
// ---------------------------------------------------------------------------

test("envInt: valid positive integer string returns parsed value", () => {
  assert.equal(envInt("MY_VAR", { min: 0, def: 5 }, e("3")), 3);
});

test("envInt: valid zero string returns 0 when min=0", () => {
  assert.equal(envInt("MY_VAR", { min: 0, def: 5 }, e("0")), 0);
});

test("envInt: value exactly at min is accepted", () => {
  assert.equal(envInt("MY_VAR", { min: 2, def: 5 }, e("2")), 2);
});

test("envInt: value above min is accepted", () => {
  assert.equal(envInt("MY_VAR", { min: 1, def: 5 }, e("10")), 10);
});

test("envInt: trims leading/trailing whitespace before parsing", () => {
  assert.equal(envInt("MY_VAR", { min: 0, def: 5 }, e("  7  ")), 7);
});

// ---------------------------------------------------------------------------
// 3. Malformed strings -> default (tightened regex: only /^-?\d+$/)
// ---------------------------------------------------------------------------

test("envInt: '3foo' returns def (partial integer, old parseInt would return 3)", () => {
  assert.equal(envInt("MY_VAR", { min: 0, def: 5 }, e("3foo")), 5);
});

test("envInt: '2.9' returns def (float string rejected, old parseInt would truncate to 2)", () => {
  assert.equal(envInt("MY_VAR", { min: 0, def: 1 }, e("2.9")), 1);
});

test("envInt: 'abc' returns def", () => {
  assert.equal(envInt("MY_VAR", { min: 0, def: 5 }, e("abc")), 5);
});

test("envInt: 'not-a-number' returns def", () => {
  assert.equal(envInt("MY_VAR", { min: 0, def: 3 }, e("not-a-number")), 3);
});

test("envInt: '3.0' returns def (float string rejected)", () => {
  assert.equal(envInt("MY_VAR", { min: 0, def: 5 }, e("3.0")), 5);
});

test("envInt: '' (empty after trim) — whitespace-only string returns def", () => {
  assert.equal(envInt("MY_VAR", { min: 0, def: 5 }, e("   ")), 5);
});

// ---------------------------------------------------------------------------
// 4. Negative values and the min guard
// ---------------------------------------------------------------------------

test("envInt: negative value below min=0 returns def", () => {
  assert.equal(envInt("MY_VAR", { min: 0, def: 5 }, e("-3")), 5);
});

test("envInt: negative value below min=1 returns def", () => {
  assert.equal(envInt("MY_VAR", { min: 1, def: 3 }, e("-1")), 3);
});

test("envInt: '-5' with min=0 returns def (negative below min)", () => {
  assert.equal(envInt("MY_VAR", { min: 0, def: 1 }, e("-5")), 1);
});

test("envInt: negative value is accepted when min is negative and value >= min", () => {
  assert.equal(envInt("MY_VAR", { min: -10, def: 5 }, e("-3")), -3);
});

// ---------------------------------------------------------------------------
// 5. min defaults to 0 when not supplied
// ---------------------------------------------------------------------------

test("envInt: min defaults to 0 — positive value accepted", () => {
  assert.equal(envInt("MY_VAR", { def: 99 }, e("7")), 7);
});

test("envInt: min defaults to 0 — negative value returns def", () => {
  assert.equal(envInt("MY_VAR", { def: 99 }, e("-1")), 99);
});

// ---------------------------------------------------------------------------
// 6. env defaults to process.env
// ---------------------------------------------------------------------------

test("envInt: reads from process.env by default", () => {
  const prev = process.env.__ENVINT_TEST_VAR;
  process.env.__ENVINT_TEST_VAR = "42";
  try {
    assert.equal(envInt("__ENVINT_TEST_VAR", { min: 0, def: 0 }), 42);
  } finally {
    if (prev === undefined) delete process.env.__ENVINT_TEST_VAR;
    else process.env.__ENVINT_TEST_VAR = prev;
  }
});

// ---------------------------------------------------------------------------
// isPlainObject — canonical guard extracted from advisor.js + fusion.js
// ---------------------------------------------------------------------------

test("isPlainObject: null returns false", () => { assert.equal(isPlainObject(null), false); });
test("isPlainObject: array returns false", () => { assert.equal(isPlainObject([]), false); });
test("isPlainObject: plain object returns true", () => { assert.equal(isPlainObject({}), true); });
test("isPlainObject: string returns false", () => { assert.equal(isPlainObject("s"), false); });
test("isPlainObject: number returns false", () => { assert.equal(isPlainObject(3), false); });
