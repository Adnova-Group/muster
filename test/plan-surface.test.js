// test/plan-surface.test.js -- contract tests for the plan-surface capability check
// (backlog item `native-plan-mode-parity`): given a caller-supplied runtime identifier,
// which native plan surface (if any) does /muster:plan and /muster:plan-backlog's
// approve-first gate route through, with prose (AskUserQuestion) as the universal fallback?
//
// Selection is fixture-driven and DECLARED, the same shape as readInstalledCowork's
// nativePluginRide (src/harness.js) and the --codex capabilities flag (src/cli.js): no native
// plan surface is invocable or auto-probeable from this deterministic CLI/test process, so
// these tests pin the SELECTION branch per harness rather than exercising a live plan mode.

import { test } from "node:test";
import assert from "node:assert/strict";
import { resolvePlanSurface } from "../src/plan-surface.js";

test("claude-code resolves to the native ExitPlanMode surface", () => {
  const r = resolvePlanSurface("claude-code");
  assert.equal(r.runtime, "claude-code");
  assert.equal(r.surface, "native");
  assert.equal(r.primitive, "ExitPlanMode");
  assert.match(r.cite, /claude-code-cli\.md/);
});

test("codex resolves to the native plan-skill + permission_mode surface", () => {
  const r = resolvePlanSurface("codex");
  assert.equal(r.runtime, "codex");
  assert.equal(r.surface, "native");
  assert.match(r.primitive, /plan/i);
  assert.match(r.detail, /permission_mode/);
  assert.match(r.detail, /plan/i);
  assert.match(r.cite, /codex-cli\.md/);
});

test("hermes resolves to the native plan-skill + goal-completion-contract surface", () => {
  const r = resolvePlanSurface("hermes");
  assert.equal(r.runtime, "hermes");
  assert.equal(r.surface, "native");
  assert.match(r.detail, /plan/i);
  assert.match(r.detail, /goal/i);
  assert.match(r.cite, /hermes\.md/);
});

test("cowork has no native plan surface -- resolves to the prose fallback", () => {
  const r = resolvePlanSurface("cowork");
  assert.equal(r.runtime, "cowork");
  assert.equal(r.surface, "prose");
  assert.equal(r.primitive, null);
  assert.match(r.cite, /claude-cowork\.md/);
});

test("an unrecognized or missing runtime degrades to the universal AskUserQuestion fallback", () => {
  for (const input of [undefined, null, "", "agents-sdk", "  UNKNOWN-Harness  "]) {
    const r = resolvePlanSurface(input);
    assert.equal(r.surface, "prose", `input ${JSON.stringify(input)} must resolve to prose`);
    assert.equal(r.primitive, "AskUserQuestion");
  }
});

test("Object.prototype keys receive the complete universal fallback", () => {
  for (const input of ["constructor", "__proto__", "prototype"]) {
    assert.deepEqual(resolvePlanSurface(input), {
      runtime: input,
      surface: "prose",
      primitive: "AskUserQuestion",
      detail: "fall back to the AskUserQuestion selection UI (Approve & run / Adjust the plan / Cancel)",
      cite: "plugin/commands/plan.md",
    });
  }
});

test("runtime lookup is case- and whitespace-insensitive", () => {
  assert.equal(resolvePlanSurface(" Codex ").surface, "native");
  assert.equal(resolvePlanSurface("CLAUDE-CODE").primitive, "ExitPlanMode");
});

test("every entry names a citation and a one-line detail string, never empty", () => {
  for (const runtime of ["claude-code", "codex", "hermes", "cowork", "unknown"]) {
    const r = resolvePlanSurface(runtime);
    assert.ok(r.detail && r.detail.length > 0, `${runtime} must carry a detail string`);
    assert.ok(r.cite && r.cite.length > 0, `${runtime} must carry a citation`);
  }
});
