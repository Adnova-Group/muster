// test/native-plan-mode-parity.test.js -- contract tests for backlog item
// `native-plan-mode-parity`: extend the ExitPlanMode ride (test/harness-delegation.test.js,
// item `harness-native-delegation`, already shipped) so /muster:plan and /muster:plan-backlog
// also route their approve-first gate through Codex's and Hermes's own native plan surfaces,
// with Claude Cowork degrading explicitly to the existing prose flow.
//
// Two kinds of assertion, matching this repo's established doc-binding style
// (test/docs-binding-interface.test.js, test/harness-delegation.test.js): prose pins on
// plugin/commands/plan.md and plan-backlog.md (muster's orchestration is markdown-driven; these
// files ARE the executable contract an attended session follows), plus ordinary unit tests on
// the new pure capability-check module, src/plan-surface.js, whose SELECTION branch is the part
// that can actually be exercised in a test -- the native plan surfaces themselves are not
// invocable from node:test.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolvePlanSurface } from "../src/plan-surface.js";

const root = new URL("../", import.meta.url);
const read = (p) => readFile(new URL(p, root), "utf8");

const CODEX_CITE = "docs/research/codex-cli.md";
const HERMES_CITE = "docs/research/hermes.md";
const COWORK_CITE = "docs/research/claude-cowork.md";
const MODULE_CITE = "src/plan-surface.js";

// ─── plan.md: single-outcome approval gate ────────────────────────────────────────────────

test("plan.md names Codex's native plan surface (permission_mode + bundled plan skill), cited", async () => {
  const text = await read("plugin/commands/plan.md");
  assert.match(text, /permission_mode:\s*"plan"/, "must name the concrete Codex hook signal");
  assert.match(text, /bundled system\s+\*\*`plan`\*\*\s+skill|bundled system.*plan.*skill/, "must name the bundled system plan skill");
  assert.match(text, /item\.completed/, 'must name the native "plan update" item surfacing');
  assert.ok(text.includes(CODEX_CITE), `must cite ${CODEX_CITE}`);
  // Codex has no ExitPlanMode-equivalent approval call -- the fallback for the actual
  // approve/adjust/cancel decision must still be named explicitly, not silently assumed.
  assert.match(text, /AskUserQuestion.*fallback|fallback.*AskUserQuestion/is, "must name the AskUserQuestion fallback for the Codex approval decision");
});

test("plan.md names Hermes's native plan surface (plan skill + goal completion contract), cited", async () => {
  const text = await read("plugin/commands/plan.md");
  assert.match(text, /`\/plan`/, "must name the Hermes /plan slash command");
  assert.match(text, /`\/goal`/, "must name the Hermes /goal completion contract");
  assert.match(text, /stop_when/, "must name a concrete completion-contract field");
  assert.ok(text.includes(HERMES_CITE), `must cite ${HERMES_CITE}`);
  assert.match(text, /clarify/, "must name Hermes's clarify tool as the actual approval-decision surface");
});

test("plan.md's fallback bullet names Cowork's explicit prose degradation, no longer lumping it with Codex/Hermes", async () => {
  const text = await read("plugin/commands/plan.md");
  const fallback = text.slice(text.indexOf("**Every other case**"), text.indexOf("**Approve & run**:"));
  assert.ok(fallback.length > 0, "the fallback bullet must exist");
  assert.match(fallback, /Cowork/, "must name Cowork as a harness that degrades to prose");
  assert.ok(text.includes(COWORK_CITE), `must cite ${COWORK_CITE}`);
});

test("plan.md cites the plan-surface capability-check module", async () => {
  const text = await read("plugin/commands/plan.md");
  assert.ok(text.includes(MODULE_CITE), `must cite ${MODULE_CITE}`);
});

// ─── plan-backlog.md: batch-plan approval gate (same doctrine, mirrored) ──────────────────

test("plan-backlog.md names Codex's native plan surface, cited", async () => {
  const text = await read("plugin/commands/plan-backlog.md");
  assert.match(text, /permission_mode:\s*"plan"/);
  assert.match(text, /bundled system.*plan.*skill/i);
  assert.ok(text.includes(CODEX_CITE), `must cite ${CODEX_CITE}`);
});

test("plan-backlog.md names Hermes's native plan surface, cited", async () => {
  const text = await read("plugin/commands/plan-backlog.md");
  assert.match(text, /`\/plan`/);
  assert.match(text, /`\/goal`/);
  assert.ok(text.includes(HERMES_CITE), `must cite ${HERMES_CITE}`);
});

test("plan-backlog.md's fallback bullet names Cowork's explicit prose degradation, cited", async () => {
  const text = await read("plugin/commands/plan-backlog.md");
  const fallback = text.slice(text.indexOf("**Every other case**"), text.indexOf("**Approve & clear**:"));
  assert.ok(fallback.length > 0);
  assert.match(fallback, /Cowork/);
  assert.ok(text.includes(COWORK_CITE), `must cite ${COWORK_CITE}`);
});

test("plan-backlog.md cites the plan-surface capability-check module", async () => {
  const text = await read("plugin/commands/plan-backlog.md");
  assert.ok(text.includes(MODULE_CITE), `must cite ${MODULE_CITE}`);
});

// ─── The Codex adapter binding must not mis-map ExitPlanMode onto TodoWrite ───────────────

test("codex/skill-adapter.md does not flatten ExitPlanMode onto TodoWrite; it points at the native branch", async () => {
  const text = await read("codex/skill-adapter.md");
  assert.match(text, /do not map `ExitPlanMode` to `TodoWrite`/);
  assert.match(text, /permission_mode:\s*"plan"/);
  assert.ok(text.includes(MODULE_CITE), `must cite ${MODULE_CITE}`);
});

// ─── src/plan-surface.js: the SELECTION branch, the only part fixture-testable in isolation ──

test("resolvePlanSurface: claude-code, codex, hermes all resolve to a native surface", () => {
  for (const runtime of ["claude-code", "codex", "hermes"]) {
    const r = resolvePlanSurface(runtime);
    assert.equal(r.surface, "native", `${runtime} must resolve native`);
    assert.ok(r.primitive, `${runtime} must name a concrete primitive`);
  }
});

test("resolvePlanSurface: cowork and anything unrecognized resolve to the prose fallback", () => {
  for (const runtime of ["cowork", "agents-sdk", "", undefined]) {
    const r = resolvePlanSurface(runtime);
    assert.equal(r.surface, "prose", `${JSON.stringify(runtime)} must resolve to prose`);
  }
});
