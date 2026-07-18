// test/codex-wave-dispatch.test.js — Codex-native dispatch behind the
// codex-spawn-agent-dispatch item (orchestrator/SKILL.md's "Codex-native
// dispatch: spawn_agent" subsection, src/wave-dispatch.js's Codex section).
//
// Codex has no `Workflow`-tool counterpart: its own native wave-dispatch
// primitive is subagent collaboration itself -- `collaboration.spawn_agent`
// (fork_turns: "none", agent_type: "<chosen.id>"), `collaboration.wait_agent`,
// `collaboration.list_agents` -- gated by the session's own
// `features.multi_agent` (default on). None of those tools are invocable
// from a unit test; what's fixture-driven and testable here is the pure
// decision/packet-building layer: which mode a wave rides (spawn_agent vs
// the sequential-inline floor when multi_agent is off), that the built
// dispatch packet honors each crew member's agent_type, and -- the whole
// point of this item -- that a rejected/unregistered profile fails LOUD
// with a registration diagnostic rather than silently degrading to a
// generic agent (docs/research/codex-cli.md sec 6).

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CODEX_MULTI_AGENT_ENV,
  CODEX_DISPATCH_MODES,
  declaredCodexMultiAgent,
  resolveCodexWaveDispatch,
  codexSpawnAgentCall,
  assertCodexSpawnAgentAccepted,
} from "../src/wave-dispatch.js";

// ── criterion 3: sequential-inline fallback when multi_agent is off ───────

test("resolveCodexWaveDispatch: no signal at all defaults to spawn_agent (Codex ships multi_agent default-on)", () => {
  const r = resolveCodexWaveDispatch({ env: {} });
  assert.equal(r.mode, CODEX_DISPATCH_MODES.SPAWN_AGENT);
  assert.equal(r.multiAgent, true);
  assert.match(r.reason, /collaboration\.spawn_agent/);
});

test("resolveCodexWaveDispatch: multiAgent:false selects the sequential-inline fallback", () => {
  const r = resolveCodexWaveDispatch({ multiAgent: false, env: {} });
  assert.equal(r.mode, CODEX_DISPATCH_MODES.SEQUENTIAL_INLINE);
  assert.equal(r.multiAgent, false);
  assert.match(r.reason, /sequentially inline/);
});

test("resolveCodexWaveDispatch: multiAgent:false explicitly overrides a truthy env declaration (self-observation wins)", () => {
  const r = resolveCodexWaveDispatch({ multiAgent: false, env: { [CODEX_MULTI_AGENT_ENV]: "1" } });
  assert.equal(r.mode, CODEX_DISPATCH_MODES.SEQUENTIAL_INLINE);
});

test("resolveCodexWaveDispatch: multiAgent omitted falls back to the declared env var", () => {
  const off = resolveCodexWaveDispatch({ env: { [CODEX_MULTI_AGENT_ENV]: "0" } });
  assert.equal(off.mode, CODEX_DISPATCH_MODES.SEQUENTIAL_INLINE);
  const on = resolveCodexWaveDispatch({ env: { [CODEX_MULTI_AGENT_ENV]: "true" } });
  assert.equal(on.mode, CODEX_DISPATCH_MODES.SPAWN_AGENT);
});

test("declaredCodexMultiAgent: absent env var means Codex's own shipped default (on) -- inverse of agent-teams' absent-means-off", () => {
  assert.equal(declaredCodexMultiAgent({}), true);
  assert.equal(declaredCodexMultiAgent({ [CODEX_MULTI_AGENT_ENV]: "0" }), false);
  assert.equal(declaredCodexMultiAgent({ [CODEX_MULTI_AGENT_ENV]: "false" }), false);
  assert.equal(declaredCodexMultiAgent({ [CODEX_MULTI_AGENT_ENV]: "1" }), true);
});

test("declaredCodexMultiAgent: canonical values are normalized and unknown values fail closed", () => {
  assert.equal(declaredCodexMultiAgent({ [CODEX_MULTI_AGENT_ENV]: " TRUE " }), true);
  assert.equal(declaredCodexMultiAgent({ [CODEX_MULTI_AGENT_ENV]: " FALSE " }), false);
  for (const value of ["yes", "on", "01", "tru", "2"]) {
    assert.equal(declaredCodexMultiAgent({ [CODEX_MULTI_AGENT_ENV]: value }), false, `${value} must fail closed`);
  }
});

test("resolveCodexWaveDispatch: called with no args at all still resolves (real process.env), never throws", () => {
  const r = resolveCodexWaveDispatch();
  assert.ok(r.mode === CODEX_DISPATCH_MODES.SPAWN_AGENT || r.mode === CODEX_DISPATCH_MODES.SEQUENTIAL_INLINE);
});

// ── criterion 1: a routed multi-wave run dispatches each crew member via
//    spawn_agent honoring its agent_type ─────────────────────────────────

test("codexSpawnAgentCall: builds a spawn_agent packet with fork_turns:none and the exact resolved agent_type", () => {
  const call = codexSpawnAgentCall({ taskId: "task-1", message: "implement X", agentType: "muster-builder" });
  assert.equal(call.tool, "collaboration.spawn_agent");
  assert.equal(call.task_name, "task-1");
  assert.equal(call.fork_turns, "none");
  assert.equal(call.agent_type, "muster-builder");
  assert.equal(call.message, "implement X");
});

test("codexSpawnAgentCall: a multi-wave routed run honors each crew member's own agent_type, never a shared default", () => {
  const wave = [
    { taskId: "wave1-a", agentType: "muster-builder" },
    { taskId: "wave1-b", agentType: "wsh-frontend-developer" },
    { taskId: "wave2-a", agentType: "muster-reviewer" },
  ];
  const calls = wave.map(codexSpawnAgentCall);
  assert.deepEqual(calls.map(c => c.agent_type), ["muster-builder", "wsh-frontend-developer", "muster-reviewer"]);
  for (const call of calls) {
    assert.equal(call.fork_turns, "none", `${call.task_name} must never fork_turns:"all"`);
    assert.equal(call.tool, "collaboration.spawn_agent");
  }
});

test("codexSpawnAgentCall: never silently substitutes a generic type -- a missing agentType fails loud, not a blank dispatch", () => {
  assert.throws(() => codexSpawnAgentCall({ taskId: "task-2" }), /agentType is required/);
  assert.throws(() => codexSpawnAgentCall({ taskId: "task-2", agentType: "" }), /agentType is required/);
});

// ── criterion 2: fail-closed on a rejected/unregistered profile ───────────

test("assertCodexSpawnAgentAccepted: a rejected profile fails LOUD with a registration diagnostic, never a silent generic-agent fallback", () => {
  assert.throws(
    () => assertCodexSpawnAgentAccepted({
      taskId: "task-3",
      agentType: "wsh-ghost-specialist",
      rejected: true,
      rejectionReason: "unknown agent_type",
    }),
    (err) => {
      assert.match(err.message, /rejected agent_type "wsh-ghost-specialist"/);
      assert.match(err.message, /task "task-3"/);
      assert.match(err.message, /[Rr]egistration diagnostic/);
      assert.match(err.message, /[Ff]ail(ing)? closed/);
      // The defining anti-pattern this guards: never silently fall back to a
      // generic/default agent that would drop the pinned model/reasoning/
      // sandbox policy.
      assert.match(err.message, /generic/);
      assert.doesNotMatch(err.message, /^\s*$/);
      return true;
    }
  );
});

test("assertCodexSpawnAgentAccepted: an accepted spawn returns a plain confirmation, no throw", () => {
  const result = assertCodexSpawnAgentAccepted({ taskId: "task-4", agentType: "muster-builder", rejected: false });
  assert.deepEqual(result, { taskId: "task-4", agentType: "muster-builder", accepted: true });
});

test("assertCodexSpawnAgentAccepted: rejected with no rejectionReason still throws a complete registration diagnostic", () => {
  assert.throws(
    () => assertCodexSpawnAgentAccepted({ taskId: "task-5", agentType: "wsh-ghost-specialist", rejected: true }),
    /[Rr]egistration diagnostic/
  );
});

test("assertCodexSpawnAgentAccepted: only an explicit rejected:false status with valid identifiers is accepted", () => {
  for (const outcome of [
    {},
    { taskId: "task-6", agentType: "muster-builder" },
    { taskId: "task-6", agentType: "muster-builder", rejected: 0 },
    { taskId: "task-6", agentType: "muster-builder", rejected: "false" },
    { taskId: "", agentType: "muster-builder", rejected: false },
    { taskId: "   ", agentType: "muster-builder", rejected: false },
    { taskId: "task-6", agentType: "", rejected: false },
    { taskId: "task-6", agentType: "   ", rejected: false },
  ]) {
    assert.throws(() => assertCodexSpawnAgentAccepted(outcome), /spawn_agent|taskId|agentType|malformed/i);
  }
});
