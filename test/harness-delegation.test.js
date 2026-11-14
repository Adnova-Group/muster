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

// Live run 8 (run8a-1, turn 4): with the Workflow tool present, /muster:go took the prose
// fallback. The tool's description allows a call only when the user opted into multi-agent
// orchestration or invoked a command whose instructions say to call Workflow; no command said so.
test("every command that drives a muster workflow says its invocation is the opt-in and to call Workflow", async () => {
  const commands = {
    "plugin/commands/go.md": "/muster:go",
    "plugin/commands/plan.md": "/muster:plan",
    "plugin/commands/diagnose.md": "/muster:diagnose",
    "plugin/commands/pm.md": "/muster:pm run",
    "plugin/commands/audit.md": "/muster:audit",
    "plugin/commands/write-book.md": "/muster:write-book",
  };
  const { readdir } = await import("node:fs/promises");
  const callers = [];
  for (const f of await readdir(new URL("../plugin/commands/", import.meta.url))) {
    if (/Workflow\(\{name:"muster:/.test(await read(`plugin/commands/${f}`))) callers.push(`plugin/commands/${f}`);
  }
  assert.deepEqual(callers.sort(), Object.keys(commands).sort(), "a new workflow-driving command needs the opt-in sentence too");
  for (const [f, cmd] of Object.entries(commands)) {
    const text = (await read(f)).replace(/\s+/g, " ");
    assert.ok(text.includes(`Invoking \`${cmd}\` is the user's explicit opt-in to multi-agent orchestration`) || text.includes(`invoking \`${cmd}\` is the user's explicit opt-in to multi-agent orchestration`), `${f} must say invoking ${cmd} is the opt-in`);
    assert.match(text, /call (it|the `Workflow` tool)/, `${f} must say to call the Workflow tool`);
  }
  const go = (await read("plugin/commands/go.md")).replace(/\s+/g, " ");
  assert.match(go, /Only when no `Workflow` tool exists, follow the skill's prose fallback instead of steps 3-6/);
  const orchestrator = (await read("plugin/skills/orchestrator/SKILL.md")).replace(/\s+/g, " ");
  assert.match(orchestrator, /Invoking a muster command is the user's explicit opt-in to multi-agent orchestration/);
  assert.match(orchestrator, /never because of the tool's opt-in rule, which the command met/);
});

// Live run 8 (scenario C): a resumed backlog item was never ticked.
test("go links backlog items to their runs and ticks a resumed item when next names it", async () => {
  const go = (await read("plugin/commands/go.md")).replace(/\s+/g, " ");
  assert.match(go, /`M build-args <runId> --item <itemId>` per planned item/);
  assert.match(go, /`tick` -> Backlog step 5, then 7/);
  assert.match(go, /Workflow\(\{name:"muster:backlog", args:\{items:\[\{itemId, \.\.\.its build-args args\}\]\}\}\)/);
});
