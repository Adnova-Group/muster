// test/harness-delegation.test.js -- contract tests for backlog item
// `harness-native-delegation`: muster keeps its judgment layer and rides harness-native
// primitives where a real one exists, with a documented fallback for harnesses that lack it.
// Every assertion here pins prose in plugin/commands and plugin/skills, not runtime behavior,
// since muster's orchestration is markdown-driven and these files ARE the executable contract.
//
// Revival stage 2b: the fan-out, isolation and review loop moved into the Workflow scripts
// (plugin/workflows/), so the go-backlog, muster-runner and task-board delegations these tests
// used to pin are gone. What stays is the native plan-mode ride at the approval stop and the
// native Workflow primitives with a prose fallback.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const root = new URL("../", import.meta.url);
const read = (p) => readFile(new URL(p, root), "utf8");

test("plan.md rides ExitPlanMode at the approval stop and keeps the AskUserQuestion fallback", async () => {
  const text = await read("plugin/commands/plan.md");
  assert.match(text, /ExitPlanMode/, "must name the native ExitPlanMode tool");
  assert.match(text, /native plan mode/i, "must name native plan mode as the primitive being ridden");
  assert.match(text, /AskUserQuestion/, "must keep the AskUserQuestion fallback");
  for (const option of ["Approve & build", "Revise", "Cancel"]) {
    assert.ok(text.includes(`**${option}**`), `fallback must offer **${option}**`);
  }
});

test("plan and go ride the native Workflow tool and name the prose fallback for surfaces without it", async () => {
  for (const f of ["plugin/commands/plan.md", "plugin/commands/go.md"]) {
    const text = await read(f);
    assert.match(text, /Workflow\(\{name:"muster:make-plan"/, `${f} must call the muster:make-plan workflow`);
    assert.match(text, /prose fallback/, `${f} must name the orchestrator's prose fallback`);
  }
  const go = await read("plugin/commands/go.md");
  assert.match(go, /Workflow\(\{name:"muster:build"/);
  assert.match(go, /Workflow\(\{name:"muster:backlog"/);
  assert.match(go, /resumeFromRunId/, "resume must use {name, resumeFromRunId}");
  const orchestrator = await read("plugin/skills/orchestrator/SKILL.md");
  assert.match(orchestrator, /## Prose fallback \(no Workflow tool\)/);
  assert.match(orchestrator, /isolation: "worktree"/, "the fallback rides the Agent tool's native worktree isolation");
});
