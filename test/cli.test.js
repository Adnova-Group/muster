import { test } from "node:test";
import assert from "node:assert/strict";
import { parseDomainArgs, formatError } from "../src/cli-args.js";

test("parseDomainArgs: --domain pm with no trailing outcome does not reuse pm as outcome", () => {
  const { override, outcome } = parseDomainArgs(["--domain", "pm"]);
  assert.equal(override, "pm");
  assert.equal(outcome, ""); // empty -> caller fails on missing outcome
});

test("parseDomainArgs: --domain value plus trailing outcome", () => {
  const { override, outcome } = parseDomainArgs(["--domain", "pm", "write a PRD"]);
  assert.equal(override, "pm");
  assert.equal(outcome, "write a PRD");
});

test("parseDomainArgs: outcome before the flag", () => {
  const { override, outcome } = parseDomainArgs(["write a PRD", "--domain", "pm"]);
  assert.equal(override, "pm");
  assert.equal(outcome, "write a PRD");
});

test("parseDomainArgs: bare outcome, no override", () => {
  const { override, outcome } = parseDomainArgs(["write a PRD"]);
  assert.equal(override, undefined);
  assert.equal(outcome, "write a PRD");
});

test("parseDomainArgs: empty args -> empty outcome, no override", () => {
  const { override, outcome } = parseDomainArgs([]);
  assert.equal(override, undefined);
  assert.equal(outcome, "");
});

test("formatError: friendly one-liner without DEBUG", () => {
  const e = new Error("boom");
  assert.equal(formatError(e, {}), "boom");
});

test("formatError: full stack under DEBUG", () => {
  const e = new Error("boom");
  const out = formatError(e, { DEBUG: "1" });
  assert.ok(out.includes("boom"));
  assert.ok(out.split("\n").length > 1, "stack should be multi-line");
});
