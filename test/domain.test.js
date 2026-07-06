import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyDomain, knownDomains } from "../src/domain.js";

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
test("classifyDomain matches keywords on word boundaries, not substrings", () => {
  assert.notEqual(classifyDomain("describe the epicenter of the outage").domain, "pm");
  assert.notEqual(classifyDomain("write a functional walkthrough").domain, "software");
});
test("video keyword in outcome routes to the video domain (reachable by domain, not just match list)", () => {
  assert.equal(classifyDomain("put together a screencast for onboarding").domain, "video");
  assert.equal(classifyDomain("write a video script about our launch").domain, "video");
});
test("knownDomains exposes the classifier's domain vocabulary, including video and software", () => {
  const domains = knownDomains();
  assert.ok(domains.includes("video"));
  assert.ok(domains.includes("software"));
  assert.ok(domains.includes("pm"));
});
