// hook-env-util.test.js — unit tests for plugin/hooks/env-util.js
//
// Verifies the integer-only parsing rule (rejects junk like "3foo") and that
// both consumer sites (scaleThreshold in inline-budget.js, env vars N/K in
// user-prompt-submit.js) correctly fall back on junk/negative/empty input.
import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HOOKDIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "plugin",
  "hooks",
);

const { envInt } = await import(path.join(HOOKDIR, "env-util.js"));

// ── envInt pure-function tests ────────────────────────────────────────────────
test("envInt: valid integer at or above min is returned", () => {
  assert.equal(envInt("X", { min: 1, def: 10 }, { X: "5" }), 5);
});

test("envInt: junk value '3foo' falls back to default (not 3)", () => {
  assert.equal(envInt("X", { min: 1, def: 10 }, { X: "3foo" }), 10);
});

test("envInt: decimal '2.9' falls back to default", () => {
  assert.equal(envInt("X", { min: 1, def: 10 }, { X: "2.9" }), 10);
});

test("envInt: negative value below min falls back to default", () => {
  assert.equal(envInt("X", { min: 1, def: 10 }, { X: "-1" }), 10);
});

test("envInt: zero below min=1 falls back to default", () => {
  assert.equal(envInt("X", { min: 1, def: 10 }, { X: "0" }), 10);
});

test("envInt: empty string falls back to default", () => {
  assert.equal(envInt("X", { min: 1, def: 10 }, { X: "" }), 10);
});

test("envInt: absent key falls back to default", () => {
  assert.equal(envInt("X", { min: 1, def: 10 }, {}), 10);
});

test("envInt: non-numeric string 'abc' falls back to default", () => {
  assert.equal(envInt("X", { min: 1, def: 10 }, { X: "abc" }), 10);
});

test("envInt: value equal to min boundary is accepted", () => {
  assert.equal(envInt("X", { min: 2, def: 10 }, { X: "2" }), 2);
});

test("envInt: value above min is accepted", () => {
  assert.equal(envInt("X", { min: 2, def: 10 }, { X: "7" }), 7);
});

test("envInt: default min=0 allows non-negative values", () => {
  assert.equal(envInt("X", { def: 5 }, { X: "0" }), 0);
  assert.equal(envInt("X", { def: 5 }, { X: "3" }), 3);
});

// ── scaleThreshold consumer site ──────────────────────────────────────────────
const { scaleThreshold, DEFAULT_SCALE } = await import(path.join(HOOKDIR, "inline-budget.js"));

test("scaleThreshold: junk '3foo' falls back to DEFAULT_SCALE (not 3)", () => {
  assert.equal(
    scaleThreshold({ MUSTER_INLINE_SCALE: "3foo" }),
    DEFAULT_SCALE,
    "junk integer-prefix string must not be accepted",
  );
});

test("scaleThreshold: negative value falls back to DEFAULT_SCALE", () => {
  assert.equal(scaleThreshold({ MUSTER_INLINE_SCALE: "-1" }), DEFAULT_SCALE);
});

test("scaleThreshold: empty string falls back to DEFAULT_SCALE", () => {
  assert.equal(scaleThreshold({ MUSTER_INLINE_SCALE: "" }), DEFAULT_SCALE);
});

test("scaleThreshold: '1' (below min=2) falls back to DEFAULT_SCALE", () => {
  assert.equal(scaleThreshold({ MUSTER_INLINE_SCALE: "1" }), DEFAULT_SCALE);
});

test("scaleThreshold: '2' (at min=2) is accepted", () => {
  assert.equal(scaleThreshold({ MUSTER_INLINE_SCALE: "2" }), 2);
});

test("scaleThreshold: '5' is accepted as-is", () => {
  assert.equal(scaleThreshold({ MUSTER_INLINE_SCALE: "5" }), 5);
});
