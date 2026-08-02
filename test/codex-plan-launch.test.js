import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

import {
  answerPlanUserInput,
  buildPlanCollaborationMode,
  buildPlanTurnStart,
  classifyPlanTurn,
  createCodexAppServerClient,
  detectEffectivePlanMode,
  launchCodexPlan,
  readSecretTerminalInput,
  renderPlanNotification,
  sanitizeTerminalText,
} from "../src/codex-plan-launch.js";

const PLAN_PRESETS = [
  { name: "Plan", mode: "plan", model: null, reasoning_effort: "medium" },
  { name: "Default", mode: "default", model: null, reasoning_effort: null },
];

function fakeAppServerProcess() {
  const child = new EventEmitter();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.killed = false;
  child.exitCode = null;
  child.signalCode = null;
  child.kill = signal => {
    child.killed = true;
    child.signalCode = signal ?? "SIGTERM";
    queueMicrotask(() => child.emit("exit", null, child.signalCode));
    return true;
  };
  return child;
}

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

test("request_user_input forwards the server auto-resolution deadline", async () => {
  const seen = [];
  await answerPlanUserInput({ autoResolutionMs: 100, questions: [
    { id: "first", question: "Choose first" },
    { id: "second", question: "Choose second" },
  ] }, async (_question, _options, autoResolutionMs) => {
    seen.push(autoResolutionMs);
    if (seen.length === 1) await new Promise(resolve => setTimeout(resolve, 20));
    return "manual";
  });
  assert.equal(seen[0] <= 100 && seen[0] > 0, true);
  assert.equal(seen[1] < seen[0] && seen[1] > 0, true);
});

test("authoritative completed plan and agent messages render before interactive input", () => {
  const rendered = [];
  assert.equal(renderPlanNotification({ method: "item/completed", params: {
    item: { id: "plan-1", type: "plan", text: "## Crew Manifest\n1. builder" },
  } }, text => rendered.push(text)), true);
  assert.equal(renderPlanNotification({ method: "item/completed", params: {
    item: { id: "message-1", type: "agentMessage", text: "Approve, adjust, or cancel." },
  } }, text => rendered.push(text)), true);
  assert.deepEqual(rendered, [
    "\n[Codex Plan output]\n## Crew Manifest\n1. builder\n",
    "\n[Codex Plan output]\nApprove, adjust, or cancel.\n",
  ]);
  assert.equal(renderPlanNotification({ method: "item/completed", params: {
    item: { id: "command-1", type: "commandExecution" },
  } }, () => assert.fail("non-message item must not render")), false);
});

test("terminal-bound App Server text strips ANSI, OSC, and unsafe controls", () => {
  assert.equal(sanitizeTerminalText("safe\u001b[31m red\u001b[0m\u001b]52;c;poison\u0007\u0000\nnext\trow"),
    "safe red\nnext\trow");
  const rendered = [];
  renderPlanNotification({ method: "item/completed", params: {
    item: { type: "plan", text: "Plan\u001b]52;c;poison\u0007 text" },
  } }, text => rendered.push(text));
  assert.deepEqual(rendered, ["\n[Codex Plan output]\nPlan text\n"]);
});

test("secret App Server input is not echoed and honors terminal cleanup", async () => {
  const input = new EventEmitter();
  input.isTTY = true;
  input.isRaw = false;
  input.setRawMode = value => { input.isRaw = value; };
  input.resume = () => {};
  const writes = [];
  const answer = readSecretTerminalInput({ input, output: { write: text => writes.push(text) }, timeoutMs: 1000 });
  input.emit("data", "s3cr\u007fet\r");
  assert.equal(await answer, "s3cet");
  assert.equal(input.isRaw, false);
  assert.equal(writes.join(""), "> \n");
  assert.doesNotMatch(writes.join(""), /s3cet/);

  const endedInput = new EventEmitter();
  endedInput.isTTY = true;
  endedInput.isRaw = false;
  endedInput.setRawMode = value => { endedInput.isRaw = value; };
  endedInput.resume = () => {};
  const ended = readSecretTerminalInput({ input: endedInput, output: { write() {} }, timeoutMs: 100 });
  endedInput.emit("end");
  await assert.rejects(ended, /ended before an answer/i);
  assert.equal(endedInput.isRaw, false);
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
  assert.equal(calls.find(call => call.method === "initialize").params.clientInfo.version, "0.6.0");
});

test("native launch requires exact nonempty thread and turn receipt correlation", async () => {
  const predicates = [];
  const client = {
    async request(method) {
      if (method === "initialize") return {};
      if (method === "collaborationMode/list") return { data: PLAN_PRESETS };
      if (method === "skills/list") return { data: [{ cwd: "/repo", errors: [], skills: [
        { name: "muster-plan", path: "/plugin/skills/muster-plan/SKILL.md", enabled: true },
      ] }] };
      if (method === "thread/start") return { thread: { id: "thread-1" }, model: "gpt-5.6-sol" };
      if (method === "turn/start") return { turn: { id: "turn-1" } };
      throw new Error(`unexpected request ${method}`);
    },
    async notify() {},
    async waitForNotification(_method, predicate) {
      predicates.push(
        predicate({ method: "thread/settings/updated", params: { threadSettings: { collaborationMode: { mode: "plan" } } } }),
        predicate({ method: "thread/settings/updated", params: { threadId: "wrong", threadSettings: { collaborationMode: { mode: "plan" } } } }),
        predicate({ method: "thread/settings/updated", params: { threadId: "thread-1", threadSettings: { collaborationMode: { mode: "plan" } } } }),
      );
      return { method: "thread/settings/updated", params: {
        threadId: "thread-1", threadSettings: { collaborationMode: { mode: "plan" } },
      } };
    },
  };
  const result = await launchCodexPlan({ client, cwd: "/repo" });
  assert.equal(result.status, "started");
  assert.deepEqual(predicates, [false, false, true]);

  const missingTurn = { ...client, request: async method => {
    const response = await client.request(method);
    return method === "turn/start" ? { turn: {} } : response;
  } };
  assert.equal((await launchCodexPlan({ client: missingTurn, cwd: "/repo" })).status, "fallback");
});

test("skills/list must match the requested cwd exactly", async () => {
  const client = {
    async request(method) {
      if (method === "initialize") return {};
      if (method === "collaborationMode/list") return { data: PLAN_PRESETS };
      if (method === "skills/list") return { data: [{ cwd: "/other", errors: [], skills: [
        { name: "muster-plan", path: "/untrusted/SKILL.md", enabled: true },
      ] }] };
      if (method === "thread/start") return { thread: { id: "thread-1" }, model: "gpt-5.6-sol" };
      throw new Error(`unexpected request ${method}`);
    },
    async notify() {},
  };
  const result = await launchCodexPlan({ client, cwd: "/repo" });
  assert.equal(result.status, "fallback");
  assert.match(result.reason, /working directory/i);
});

test("JSON-RPC transport rejects malformed and oversized frames without escaping fallback", async () => {
  for (const frame of ["null", "1", "[]", "{}", "not-json", '{"jsonrpc":"2.0","id":1,"error":null}']) {
    const child = fakeAppServerProcess();
    const client = await createCodexAppServerClient({ cwd: "/repo", spawnProcess: () => child, timeoutMs: 100 });
    const pending = client.request("initialize");
    child.stdout.write(`${frame}\n`);
    await assert.rejects(pending, /invalid JSON-RPC/i, frame);
    assert.equal(child.killed, true, frame);
  }

  const child = fakeAppServerProcess();
  const client = await createCodexAppServerClient({ cwd: "/repo", spawnProcess: () => child, timeoutMs: 100 });
  const pending = client.request("initialize");
  child.stdout.write("x".repeat(1024 * 1024 + 1));
  await assert.rejects(pending, /frame.*large|buffer.*large/i);
  assert.equal(child.killed, true);

  const fallbackChild = fakeAppServerProcess();
  const fallbackClient = await createCodexAppServerClient({ cwd: "/repo", spawnProcess: () => fallbackChild, timeoutMs: 100 });
  const launching = launchCodexPlan({ client: fallbackClient, cwd: "/repo", outcome: "Design the import flow" });
  fallbackChild.stdout.write("null\n");
  const fallback = await launching;
  assert.equal(fallback.status, "fallback");
  assert.match(fallback.guidance, /\/plan \$muster-plan/);
});

test("JSON-RPC transport declines approvals and rejects unknown requests", async () => {
  const responseChild = fakeAppServerProcess();
  const responseClient = await createCodexAppServerClient({ cwd: "/repo", spawnProcess: () => responseChild, timeoutMs: 100 });
  const response = responseClient.request("initialize");
  responseChild.stdout.write(`${JSON.stringify({ id: 1, result: { accepted: true } })}\n`);
  assert.deepEqual(await response, { accepted: true });
  await responseClient.close();

  const child = fakeAppServerProcess();
  const written = [];
  child.stdin.setEncoding("utf8");
  child.stdin.on("data", chunk => written.push(...chunk.trim().split("\n").filter(Boolean).map(JSON.parse)));
  const client = await createCodexAppServerClient({ cwd: "/repo", spawnProcess: () => child, timeoutMs: 100 });
  child.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: 9, method: "item/commandExecution/requestApproval", params: {} })}\n`);
  child.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: 10, method: "unknown\u001b[31m", params: {} })}\n`);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(written.find(message => message.id === 9)?.result, { decision: "decline" });
  assert.equal(written.find(message => message.id === 10)?.error?.code, -32601);

  const interrupting = client.interruptTurn("thread-1", "turn-1");
  await new Promise(resolve => setImmediate(resolve));
  const interrupt = written.find(message => message.method === "turn/interrupt");
  assert.deepEqual(interrupt.params, { threadId: "thread-1", turnId: "turn-1" });
  child.stdout.write(`${JSON.stringify({ id: interrupt.id, result: {} })}\n`);
  await interrupting;
  await client.close();
  assert.equal(child.killed, true);
});

test("close, child exit, and transport error abort active secret input", async () => {
  for (const terminate of [
    async ({ client }) => client.close(),
    async ({ child }) => { child.emit("exit", 1); },
    async ({ child }) => { child.stdin.emit("error", new Error("broken pipe")); },
  ]) {
    const child = fakeAppServerProcess();
    const input = new EventEmitter();
    input.isTTY = true;
    input.isRaw = false;
    input.setRawMode = value => { input.isRaw = value; };
    input.resume = () => {};
    const client = await createCodexAppServerClient({
      cwd: "/repo",
      spawnProcess: () => child,
      timeoutMs: 100,
      userInput: (_question, _options, timeoutMs, signal) =>
        readSecretTerminalInput({ input, output: { write() {} }, timeoutMs, signal }),
    });
    child.stdout.write(`${JSON.stringify({ id: 12, method: "item/tool/requestUserInput", params: {
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "item-1",
      questions: [{ id: "secret", header: "Secret", question: "Token?", isSecret: true }],
    } })}\n`);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(input.isRaw, true);
    assert.equal(input.listenerCount("data"), 1);
    await terminate({ child, client });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(input.isRaw, false);
    assert.equal(input.listenerCount("data"), 0);
  }
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
