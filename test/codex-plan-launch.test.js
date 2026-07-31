import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

import {
  answerPlanUserInput,
  buildPlanCollaborationMode,
  buildPlanTurnStart,
  classifyPlanTurn,
  detectEffectivePlanMode,
  launchCodexPlan,
  renderPlanNotification,
} from "../src/codex-plan-launch.js";

const PLAN_PRESETS = [
  { name: "Plan", mode: "plan", model: null, reasoning_effort: "medium" },
  { name: "Default", mode: "default", model: null, reasoning_effort: null },
];

test("native activation derives the schema-required mode from the discovered Plan preset and thread model", () => {
  assert.deepEqual(buildPlanCollaborationMode(PLAN_PRESETS, {
    model: "gpt-5.6-sol",
    reasoningEffort: "high",
  }), {
    mode: "plan",
    settings: {
      model: "gpt-5.6-sol",
      reasoning_effort: "medium",
      developer_instructions: null,
    },
  });
});

test("effective-mode detection requires the app-server's thread settings receipt", () => {
  assert.deepEqual(detectEffectivePlanMode({
    method: "thread/settings/updated",
    params: { threadSettings: { collaborationMode: { mode: "plan", settings: {
      model: "gpt-5.6-sol", reasoning_effort: "medium", developer_instructions: null,
    } } } },
  }), { effectiveMode: "plan", active: true });

  assert.deepEqual(detectEffectivePlanMode({
    method: "turn/started",
    params: { turn: { id: "turn-1" } },
  }), { effectiveMode: "unknown", active: false });
});

test("turn/start invokes muster-plan without overriding any approval control", () => {
  const params = buildPlanTurnStart({
    threadId: "thread-1",
    outcome: "Design the import flow",
    skill: { name: "muster-plan", path: "/plugin/skills/muster-plan/SKILL.md" },
    collaborationMode: buildPlanCollaborationMode(PLAN_PRESETS, {
      model: "gpt-5.6-sol", reasoningEffort: "high",
    }),
  });

  assert.deepEqual(params.input, [
    { type: "text", text: "$muster-plan Design the import flow" },
    { type: "skill", name: "muster-plan", path: "/plugin/skills/muster-plan/SKILL.md" },
  ]);
  assert.equal(params.collaborationMode.mode, "plan");
  for (const forbidden of ["approvalPolicy", "approvalsReviewer", "permissions", "sandboxPolicy"])
    assert.equal(Object.hasOwn(params, forbidden), false, `${forbidden} must remain inherited`);
});

test("request_user_input answers are relayed explicitly instead of auto-approved", async () => {
  const prompts = [];
  const response = await answerPlanUserInput({ questions: [{
    id: "approval",
    header: "Plan",
    question: "Approve this plan?",
    options: [
      { label: "Approve & run", description: "Begin implementation." },
      { label: "Adjust", description: "Keep planning." },
    ],
  }] }, async (question, options) => {
    prompts.push({ question, options });
    return "2";
  });
  assert.equal(prompts.length, 1);
  assert.deepEqual(response, { answers: { approval: { answers: ["Adjust"] } } });
  await assert.rejects(() => answerPlanUserInput({ questions: [{ id: "approval", question: "Approve?" }] }), /no interactive input surface/i);
});

test("authoritative completed plan and agent messages render before interactive input", () => {
  const rendered = [];
  assert.equal(renderPlanNotification({ method: "item/completed", params: {
    item: { id: "plan-1", type: "plan", text: "## Crew Manifest\n1. builder" },
  } }, text => rendered.push(text)), true);
  assert.equal(renderPlanNotification({ method: "item/completed", params: {
    item: { id: "message-1", type: "agentMessage", text: "Approve, adjust, or cancel." },
  } }, text => rendered.push(text)), true);
  assert.deepEqual(rendered, ["\n## Crew Manifest\n1. builder\n", "\nApprove, adjust, or cancel.\n"]);
  assert.equal(renderPlanNotification({ method: "item/completed", params: {
    item: { id: "command-1", type: "commandExecution" },
  } }, () => assert.fail("non-message item must not render")), false);
});

test("turn completion preserves failed and interrupted status", () => {
  assert.deepEqual(classifyPlanTurn({ status: "completed" }), { status: "completed", exitCode: 0 });
  assert.deepEqual(classifyPlanTurn({ status: "failed" }), { status: "failed", exitCode: 2 });
  assert.deepEqual(classifyPlanTurn({ status: "interrupted" }), { status: "interrupted", exitCode: 2 });
  assert.deepEqual(classifyPlanTurn({}), { status: "failed", exitCode: 2 });
});

test("native launch reports Plan only after the schema-shaped effective-mode confirmation", async () => {
  const calls = [];
  const client = {
    async request(method, params) {
      calls.push({ method, params });
      if (method === "initialize") return {};
      if (method === "collaborationMode/list") return { data: PLAN_PRESETS };
      if (method === "skills/list") return { data: [{ cwd: "/repo", errors: [], skills: [
        { name: "muster-plan", path: "/plugin/skills/muster-plan/SKILL.md", enabled: true },
      ] }] };
      if (method === "thread/start") return {
        thread: { id: "thread-1" }, model: "gpt-5.6-sol", reasoningEffort: "high",
      };
      if (method === "turn/start") return { turn: { id: "turn-1" } };
      throw new Error(`unexpected request ${method}`);
    },
    async notify(method) { calls.push({ method }); },
    async waitForNotification() {
      return { method: "thread/settings/updated", params: {
        threadId: "thread-1",
        threadSettings: {
          collaborationMode: { mode: "plan", settings: {
            model: "gpt-5.6-sol", reasoning_effort: "medium", developer_instructions: null,
          } },
        },
      } };
    },
  };

  const result = await launchCodexPlan({ client, cwd: "/repo", outcome: "Design the import flow" });
  assert.deepEqual(result, {
    status: "started", native: true, effectiveMode: "plan",
    threadId: "thread-1", turnId: "turn-1",
  });
  const start = calls.find(call => call.method === "turn/start");
  assert.equal(start.params.collaborationMode.mode, "plan");
});

test("unavailable App Server control fails safely with explicit /plan guidance", async () => {
  const result = await launchCodexPlan({
    cwd: "/repo",
    outcome: "Design the import flow",
    clientFactory: async () => { throw new Error("codex app-server is unavailable"); },
  });

  assert.equal(result.status, "fallback");
  assert.equal(result.native, false);
  assert.equal(result.effectiveMode, "unknown");
  assert.match(result.guidance, /\/plan/);
  assert.match(result.guidance, /\$muster-plan/);
  assert.match(result.reason, /unavailable/);
});

test("non-interactive CLI falls back before starting a hidden approval-less session", () => {
  const run = spawnSync(process.execPath, ["src/cli.js", "codex-plan", "Design", "the", "import", "flow"], {
    cwd: new URL("..", import.meta.url),
    encoding: "utf8",
  });
  assert.equal(run.status, 2);
  assert.match(run.stdout, /"status": "fallback"/);
  assert.match(run.stdout, /\/plan \$muster-plan Design the import flow/);
  assert.match(run.stdout, /interactive terminal/i);
});
