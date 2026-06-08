import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyDomain } from "../src/domain.js";

test("override always wins", () => {
  assert.deepEqual(classifyDomain("anything", {}, "marketing"),
    { domain: "marketing", source: "override", confidence: 1 });
});
test("pm keyword in outcome", () => {
  assert.equal(classifyDomain("Write a PRD for checkout", {}).domain, "pm");
});
test("business keyword", () => {
  assert.equal(classifyDomain("Build a business case for X", {}).domain, "business");
});
test("workspace -> software when no keyword", () => {
  assert.equal(classifyDomain("make it faster", { shape: "backend", greenfield: false }).domain, "software");
});
test("unknown when nothing matches", () => {
  assert.equal(classifyDomain("hello there", { shape: "unknown", greenfield: true }).domain, "unknown");
});
