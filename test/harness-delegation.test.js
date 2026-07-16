// test/harness-delegation.test.js -- contract tests for backlog item
// `harness-native-delegation`: muster keeps its judgment layer and rides harness-native
// primitives where a real one exists, with a documented fallback for harnesses that lack it.
// Every assertion here pins prose in plugin/commands and plugin/skills, not runtime behavior --
// the same style as test/docs-binding-interface.test.js and test/docs-currency.test.js, since
// muster's orchestration is markdown-driven and these files ARE the executable contract an
// attended session follows.
//
// Grounded in docs/research/reference-harness-design.md (the capstone naked-base-loop research;
// criterion 1 of this backlog item, already shipped on main before this item started) -- every
// delegation below cites it rather than re-deriving harness behavior.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const root = new URL("../", import.meta.url);
const read = (p) => readFile(new URL(p, root), "utf8");

const CITE = "docs/research/reference-harness-design.md";

// ─── Delegation 1: approve-first wall -> native plan mode (the flagship) ──────────────────

test("plan.md rides ExitPlanMode for the single-outcome approval gate, citing the capstone", async () => {
  const text = await read("plugin/commands/plan.md");
  assert.match(text, /ExitPlanMode/, "must name the native ExitPlanMode tool");
  assert.match(text, /plan mode/i, "must name native plan mode as the primitive being ridden");
  assert.ok(text.includes(CITE), `must cite ${CITE}`);
  // The fallback must survive verbatim for harnesses/sessions without plan mode.
  assert.match(text, /AskUserQuestion/, "must keep the AskUserQuestion fallback");
  assert.match(text, /\*\*Approve & run\*\*/, "fallback must keep the Approve & run option");
  assert.match(text, /\*\*Adjust the plan\*\*/, "fallback must keep the Adjust the plan option");
  assert.match(text, /\*\*Cancel\*\*/, "fallback must keep the Cancel option");
});

test("plan-backlog.md rides ExitPlanMode for the batch-plan approval gate, citing the capstone", async () => {
  const text = await read("plugin/commands/plan-backlog.md");
  assert.match(text, /ExitPlanMode/, "must name the native ExitPlanMode tool");
  assert.ok(text.includes(CITE), `must cite ${CITE}`);
  // The fallback must survive verbatim for harnesses/sessions without plan mode.
  assert.match(text, /AskUserQuestion/, "must keep the AskUserQuestion fallback");
  assert.match(text, /\*\*Approve & clear\*\*/, "fallback must keep the Approve & clear option");
  assert.match(text, /\*\*Adjust the plan\*\*/, "fallback must keep the Adjust the plan option");
  assert.match(text, /\*\*Cancel\*\*/, "fallback must keep the Cancel option");
});

// ─── Delegation 2: STATE-mirrored task board -> native task tools, named concretely ────────

test("orchestrator.md's Task board names the concrete native primitive and cites the capstone", async () => {
  const text = await read("plugin/skills/orchestrator/SKILL.md");
  const section = text.slice(text.indexOf("## Task board"), text.indexOf("## Scope fences"));
  assert.ok(section.length > 0, "Task board section must exist between its own heading and Scope fences");
  assert.match(section, /TaskCreate/, "must name TaskCreate as the concrete native primitive");
  assert.match(section, /TaskUpdate/, "must name TaskUpdate as the concrete native primitive");
  assert.ok(section.includes(CITE), `Task board section must cite ${CITE}`);
  // Fallback must survive: a harness with no task-tracking primitive still relies on STATE alone.
  assert.match(section, /STATE alone/, "must keep the STATE-alone fallback for a no-task-tool harness");
});

// ─── Delegation 3: hand-managed worktree references -> explicit Agent-tool isolation ──────

test("go-backlog.md wave mode names the Agent tool's isolation parameter and a non-Claude-Code fallback", async () => {
  const text = await read("plugin/commands/go-backlog.md");
  assert.match(text, /isolation:\s*"worktree"/, 'must name the literal isolation: "worktree" Agent-tool parameter');
  assert.ok(text.includes(CITE), `must cite ${CITE}`);
  // Fallback for a harness whose subagent dispatch has no isolation parameter (e.g. Codex).
  assert.match(text, /Codex/, "must name a harness lacking the isolation parameter as the fallback case");
});

test("muster-runner.md documents that its isolation is dispatcher-created, not self-created", async () => {
  const text = await read("plugin/agents/muster-runner.md");
  assert.match(text, /isolation:\s*"worktree"/, 'must name the literal isolation: "worktree" Agent-tool parameter');
  assert.ok(text.includes(CITE), `must cite ${CITE}`);
});
