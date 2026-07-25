// Kimi-native dispatch: AgentSwarm waves + /goal run loop.
// Constants here are pinned to the shipped kimi binary's own tool schema
// (v0.29.0, unstripped) -- notably {{item}}, the >=2-item floor, the 128 cap,
// the DISTINCT-prompts rule (absent from published docs), and
// GOAL_EXIT_CODES {complete:0, blocked:3, paused:6}.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  kimiSwarmCall, kimiAgentCall, kimiGoalInvocation, interpretKimiGoalExit, resolveKimiWaveDispatch,
  KIMI_SWARM_PLACEHOLDER, KIMI_SWARM_MAX_SUBAGENTS, KIMI_GOAL_EXIT_CODES, KIMI_GOAL_MAX_OBJECTIVE, KIMI_DISPATCH_MODES
} from "../src/kimi-dispatch.js";
import { KIMI_LANES } from "../src/kimi.js";

// --- AgentSwarm -------------------------------------------------------------

test("kimiSwarmCall: builds the swarm packet with the exact binary placeholder", () => {
  assert.equal(KIMI_SWARM_PLACEHOLDER, "{{item}}");
  const call = kimiSwarmCall({
    promptTemplate: `Review ${KIMI_SWARM_PLACEHOLDER} for likely regressions.`,
    items: ["src/a.ts", "src/b.ts"],
    subagentType: "muster-reviewer",
    model: "primary"
  });
  assert.equal(call.tool, "AgentSwarm");
  assert.deepEqual(call.items, ["src/a.ts", "src/b.ts"]);
  assert.equal(call.subagent_type, "muster-reviewer");
  assert.equal(call.model, "primary");
  assert.equal(call.soleToolCall, true); // the binary enforces this contract
});

test("kimiSwarmCall: rejects a template without the placeholder", () => {
  assert.throws(() => kimiSwarmCall({ promptTemplate: "Review the code.", items: ["a", "b"] }), /must contain the \{\{item\}\}/);
});

test("kimiSwarmCall: enforces the >=2 item floor unless resuming", () => {
  assert.throws(() => kimiSwarmCall({ promptTemplate: "x {{item}}", items: ["only-one"] }), /at least 2 items/);
  // with resume_agent_ids a single item is legal
  const call = kimiSwarmCall({ promptTemplate: "x {{item}}", items: ["one"], resumeAgentIds: { "agent-0": "continue" } });
  assert.deepEqual(call.resume_agent_ids, { "agent-0": "continue" });
});

test("kimiSwarmCall: enforces the 128-subagent cap", () => {
  const items = Array.from({ length: KIMI_SWARM_MAX_SUBAGENTS + 1 }, (_, i) => `f${i}`);
  assert.throws(() => kimiSwarmCall({ promptTemplate: "x {{item}}", items }), /at most 128 subagents/);
});

test("kimiSwarmCall: catches DUPLICATE expanded prompts before dispatch (undocumented binary rule)", () => {
  // Kimi rejects the WHOLE swarm when two items expand to the same prompt.
  // Catching it here costs nothing; discovering it costs a wave round trip.
  assert.throws(
    () => kimiSwarmCall({ promptTemplate: "Audit {{item}} now.", items: ["src/a.ts", "src/a.ts"] }),
    /must expand to DISTINCT prompts/
  );
  // a template that ignores the item would collapse every prompt -- but that
  // is already caught by the placeholder rule, so distinctness only bites on
  // genuinely duplicated items.
  assert.doesNotThrow(() => kimiSwarmCall({ promptTemplate: "Audit {{item}}.", items: ["a", "b"] }));
});

test("kimiSwarmCall: model must be a lane, never a model id", () => {
  assert.throws(() => kimiSwarmCall({ promptTemplate: "x {{item}}", items: ["a", "b"], model: "kimi-code/k3" }), /must be one of primary\|secondary/);
});

// --- Agent calls ------------------------------------------------------------

test("kimiAgentCall: derives the lane from the shared manifest so dispatch matches the stamped file", () => {
  const judgment = kimiAgentCall({ agentId: "muster-reviewer", prompt: "Review the branch." });
  assert.equal(judgment.tool, "Agent");
  assert.equal(judgment.subagent_type, "muster-reviewer");
  assert.equal(judgment.model, "primary");   // opus tier

  const execution = kimiAgentCall({ agentId: "muster-surgeon", prompt: "Fix the typo." });
  assert.equal(execution.model, "secondary"); // sonnet tier
});

test("kimiAgentCall: an explicit model overrides the profile lane", () => {
  const call = kimiAgentCall({ agentId: "muster-surgeon", prompt: "x", model: "primary" });
  assert.equal(call.model, "primary");
});

test("kimiAgentCall: an unknown agent id dispatches with no lane rather than guessing", () => {
  const call = kimiAgentCall({ agentId: "not-in-manifest", prompt: "x" });
  assert.equal(call.model, undefined);
});

test("kimiAgentCall: background flag and required args", () => {
  assert.equal(kimiAgentCall({ agentId: "muster-reviewer", prompt: "x", background: true }).run_in_background, true);
  assert.throws(() => kimiAgentCall({ prompt: "x" }), /agentId is required/);
  assert.throws(() => kimiAgentCall({ agentId: "muster-reviewer" }), /prompt is required/);
});

// --- /goal ------------------------------------------------------------------

test("interpretKimiGoalExit: maps the binary's exit codes onto run dispositions", () => {
  assert.deepEqual(KIMI_GOAL_EXIT_CODES, { complete: 0, blocked: 3, paused: 6 });

  const complete = interpretKimiGoalExit(0);
  assert.equal(complete.status, "complete");
  assert.equal(complete.terminal, true);
  assert.equal(complete.escalate, false);

  const blocked = interpretKimiGoalExit(3);
  assert.equal(blocked.status, "blocked");
  assert.equal(blocked.escalate, true); // muster's escalation signal

  const paused = interpretKimiGoalExit(6);
  assert.equal(paused.status, "paused");
  assert.equal(paused.resumable, true);
});

test("interpretKimiGoalExit: a non-goal exit code is a FAULT, never a clean stop", () => {
  const crashed = interpretKimiGoalExit(1);
  assert.equal(crashed.status, "failed");
  assert.equal(crashed.escalate, true);
  assert.match(crashed.reason, /not a \/goal terminal state/);
});

test("kimiGoalInvocation: builds argv + the per-process lane env", () => {
  const inv = kimiGoalInvocation({ objective: "Fix the failing checkout test and run the suite" });
  assert.deepEqual(inv.argv.slice(0, 2), ["-p", "/goal Fix the failing checkout test and run the suite"]);
  assert.deepEqual(inv.argv.slice(-2), ["-m", KIMI_LANES.primary]);
  // the env pair binds the lanes without touching the user's config.toml
  assert.equal(inv.env.KIMI_CODE_EXPERIMENTAL_FLAG, "1");
  assert.equal(inv.env.KIMI_SECONDARY_MODEL, KIMI_LANES.secondary);
});

test("kimiGoalInvocation: stream-json is opt-in, and the /goal prefix is never doubled", () => {
  assert.ok(kimiGoalInvocation({ objective: "x", streamJson: true }).argv.includes("stream-json"));
  assert.throws(() => kimiGoalInvocation({ objective: "/goal already prefixed" }), /the \/goal prefix is added here/);
});

test("kimiGoalInvocation: enforces the binary's 4000-char objective cap", () => {
  assert.equal(KIMI_GOAL_MAX_OBJECTIVE, 4000);
  assert.throws(() => kimiGoalInvocation({ objective: "x".repeat(4001) }), /caps it at 4000/);
  assert.doesNotThrow(() => kimiGoalInvocation({ objective: "x".repeat(4000) }));
  assert.throws(() => kimiGoalInvocation({ objective: "  " }), /objective is required/);
});

// --- Wave shape selection ---------------------------------------------------

test("resolveKimiWaveDispatch: swarm for a uniform fan-out, agent-calls for a mixed crew", () => {
  const uniform = resolveKimiWaveDispatch({ items: ["a.ts", "b.ts", "c.ts"], uniformTask: true });
  assert.equal(uniform.mode, KIMI_DISPATCH_MODES.SWARM);
  assert.equal(uniform.concurrencyEnv, "KIMI_CODE_AGENT_SWARM_MAX_CONCURRENCY");

  // a typical muster wave is N DISTINCT roles -- Kimi's own guidance says use
  // separate Agent calls for differently-shaped tasks.
  const mixed = resolveKimiWaveDispatch({ items: ["builder", "test-author", "reviewer"] });
  assert.equal(mixed.mode, KIMI_DISPATCH_MODES.AGENT_CALLS);
  assert.match(mixed.reason, /differently-shaped/);

  // below the floor, swarm is not even legal
  const single = resolveKimiWaveDispatch({ items: ["only"], uniformTask: true });
  assert.equal(single.mode, KIMI_DISPATCH_MODES.AGENT_CALLS);
  assert.match(single.reason, /below AgentSwarm's 2-item floor/);
});
