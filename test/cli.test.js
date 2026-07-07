import { test } from "node:test";
import assert from "node:assert/strict";
import { parseDomainArgs, formatError, requireArg, flagValue } from "../src/cli-args.js";

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

test("requireArg: returns the arg when present", () => {
  let failed = false;
  const v = requireArg(["a", "b.json"], 1, "usage", () => { failed = true; });
  assert.equal(v, "b.json");
  assert.equal(failed, false);
});

test("requireArg: invokes fail(usage) when the arg is missing", () => {
  let msg = null;
  requireArg(["a"], 1, "manifest validate <file>: missing file path", (m) => { msg = m; });
  assert.equal(msg, "manifest validate <file>: missing file path");
});

test("requireArg: invokes fail when the arg is an empty string", () => {
  let failed = false;
  requireArg(["a", ""], 1, "usage", () => { failed = true; });
  assert.equal(failed, true);
});

test("flagValue: returns the token after the flag", () => {
  assert.equal(flagValue(["x", "--model", "rice"], "--model"), "rice");
});

test("flagValue: returns undefined when the flag is absent", () => {
  assert.equal(flagValue(["x", "y"], "--model"), undefined);
});

test("flagValue: returns undefined when the flag has no following value", () => {
  assert.equal(flagValue(["x", "--done"], "--done"), undefined);
});

test("flagValue: finds the flag regardless of position", () => {
  assert.equal(flagValue(["--ci", "ci.txt", "extra"], "--ci"), "ci.txt");
});

test("flagValue: returns undefined when the following token is itself a flag, not a value", () => {
  assert.equal(flagValue(["match", "--skills", "--stack", "foo"], "--skills"), undefined);
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
