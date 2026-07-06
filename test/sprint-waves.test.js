import { test } from "node:test";
import assert from "node:assert/strict";
import { computeSprintWaves } from "../src/sprint-waves.js";

test("plain backlog, no annotations -> strictly sequential waves, synthetic ids", () => {
  const backlog = [
    "- [ ] Do first",
    "- [ ] Do second",
    "- [ ] Do third",
  ].join("\n");
  const r = computeSprintWaves(backlog);
  assert.equal(r.ok, true);
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.waves, [["item-1"], ["item-2"], ["item-3"]]);
  assert.equal(r.items["item-1"].line, 1);
  assert.equal(r.items["item-1"].text, "Do first");
});

test("{deps: none} on every item -> independence, same wave", () => {
  const backlog = [
    "- [ ] First {deps: none}",
    "- [ ] Second {deps: none}",
  ].join("\n");
  const r = computeSprintWaves(backlog);
  assert.equal(r.ok, true);
  assert.deepEqual(r.waves, [["item-1", "item-2"]]);
});

test("diamond dependency shape via explicit ids", () => {
  const backlog = [
    "- [ ] Task A {id: a}",
    "- [ ] Task B {id: b} {deps: a}",
    "- [ ] Task C {id: c} {deps: a}",
    "- [ ] Task D {id: d} {deps: b,c}",
  ].join("\n");
  const r = computeSprintWaves(backlog);
  assert.equal(r.ok, true);
  assert.deepEqual(r.waves, [["a"], ["b", "c"], ["d"]]);
});

test("{id} without {deps} still implicitly depends on everything above", () => {
  const backlog = [
    "- [ ] First {id: x}",
    "- [ ] Second {id: y}",
  ].join("\n");
  const r = computeSprintWaves(backlog);
  assert.equal(r.ok, true);
  assert.deepEqual(r.waves, [["x"], ["y"]]);
});

test("dependency cycle -> ok:false with a named error", () => {
  const backlog = [
    "- [ ] First {id: a} {deps: b}",
    "- [ ] Second {id: b} {deps: a}",
  ].join("\n");
  const r = computeSprintWaves(backlog);
  assert.equal(r.ok, false);
  assert.deepEqual(r.waves, []);
  assert.ok(r.errors.some((e) => /cycle/i.test(e)), r.errors.join(" | "));
});

test("unknown dep id -> ok:false with a named error", () => {
  const backlog = "- [ ] First {id: a} {deps: ghost}";
  const r = computeSprintWaves(backlog);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => /unknown dep/i.test(e)), r.errors.join(" | "));
});

test("duplicate id -> ok:false with a named error", () => {
  const backlog = [
    "- [ ] First {id: a}",
    "- [ ] Second {id: a}",
  ].join("\n");
  const r = computeSprintWaves(backlog);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => /duplicate/i.test(e)), r.errors.join(" | "));
});

test("dispositions and escalated annotations carry into items", () => {
  const backlog = [
    "- [ ] Ship it {id: a} {disposition: merge-local} {deps: none}",
    "- [ ] Escalate this {id: b} {escalated: blocked on review} {deps: none}",
  ].join("\n");
  const r = computeSprintWaves(backlog);
  assert.equal(r.ok, true);
  assert.equal(r.items.a.disposition, "merge-local");
  assert.equal(r.items.a.escalated, false);
  assert.equal(r.items.b.disposition, null);
  assert.equal(r.items.b.escalated, true);
});

test("missing content (not a string) -> ok:false", () => {
  const r = computeSprintWaves(undefined);
  assert.equal(r.ok, false);
  assert.ok(r.errors.length > 0);
});

test("empty file content -> ok:false", () => {
  const r = computeSprintWaves("");
  assert.equal(r.ok, false);
  assert.ok(r.errors.length > 0);
});

test("annotations anywhere in the line are stripped from item text", () => {
  const backlog = "- [ ] Ship the {id: a} thing {deps: none} to prod";
  const r = computeSprintWaves(backlog);
  assert.equal(r.ok, true);
  assert.equal(r.items.a.text, "Ship the thing to prod");
});

test("checked items ('- [x] ') are ignored", () => {
  const backlog = [
    "- [x] Already done",
    "- [ ] Still todo",
  ].join("\n");
  const r = computeSprintWaves(backlog);
  assert.equal(r.ok, true);
  assert.deepEqual(r.waves, [["item-2"]]);
});

test("annotated:false for a plain backlog with no {id}/{deps} annotations", () => {
  const backlog = [
    "- [ ] Do first",
    "- [ ] Do second",
  ].join("\n");
  const r = computeSprintWaves(backlog);
  assert.equal(r.ok, true);
  assert.equal(r.annotated, false);
});

test("annotated:true when any unchecked item carries an explicit {id}", () => {
  const backlog = [
    "- [ ] Plain",
    "- [ ] Named {id: a}",
  ].join("\n");
  const r = computeSprintWaves(backlog);
  assert.equal(r.ok, true);
  assert.equal(r.annotated, true);
});

test("annotated:true when any unchecked item carries an explicit {deps}", () => {
  const backlog = [
    "- [ ] Plain",
    "- [ ] Independent {deps: none}",
  ].join("\n");
  const r = computeSprintWaves(backlog);
  assert.equal(r.ok, true);
  assert.equal(r.annotated, true);
});

test("annotated:false when {id}/{deps} annotations only appear on checked lines", () => {
  const backlog = [
    "- [x] Done already {id: a} {deps: none}",
    "- [ ] Still todo",
  ].join("\n");
  const r = computeSprintWaves(backlog);
  assert.equal(r.ok, true);
  assert.equal(r.annotated, false);
  assert.deepEqual(r.waves, [["item-2"]]);
});

test("invalid {id} token (contains a space) -> ok:false with a named error", () => {
  const backlog = "- [ ] Something {id: has space}";
  const r = computeSprintWaves(backlog);
  assert.equal(r.ok, false);
  assert.deepEqual(r.waves, []);
  assert.ok(r.errors.some((e) => /invalid id/i.test(e) && /has space/.test(e)), r.errors.join(" | "));
});
