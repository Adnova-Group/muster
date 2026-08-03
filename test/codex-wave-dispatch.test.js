// test/codex-wave-dispatch.test.js — Codex-native dispatch behind the
// codex-spawn-agent-dispatch item (orchestrator/SKILL.md's "Codex-native
// dispatch: spawn_agent" subsection, src/codex-dispatch.js).
//
// Production waves have no shared-CWD selector: they use the authenticated
// process lane. Explicit non-wave leaf delegation may use versioned spawn
// packets. The fixture-driven layer verifies that those packets honor each
// crew member's agent_type and that a rejected/unregistered profile fails LOUD
// with a registration diagnostic rather than silently degrading to a
// generic agent (docs/research/codex-cli.md sec 6).

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  codexSpawnAgentCall,
  assertCodexSpawnAgentAccepted,
} from "../src/codex-dispatch.js";

// Explicit non-wave leaf delegation may still use versioned spawn packets.

// Codex 0.145.0 split the subagent API into v1/v2, resolved PER MODEL from the
// catalog (docs/research/codex-cli.md sec 10.1), so the packet shape is now
// version-dependent and the caller must say which. Full coverage of the split
// lives in test/codex-multi-agent-version.test.js.
test("codexSpawnAgentCall: builds a v2 spawn_agent packet with fork_turns:none and the exact resolved agent_type", () => {
  const call = codexSpawnAgentCall({ taskId: "task-1", message: "implement X", agentType: "muster-builder", version: "v2" });
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
  const calls = wave.map(task => codexSpawnAgentCall({ ...task, version: "v2" }));
  assert.deepEqual(calls.map(c => c.agent_type), ["muster-builder", "wsh-frontend-developer", "muster-reviewer"]);
  for (const call of calls) {
    assert.equal(call.fork_turns, "none", `${call.task_name} must never fork_turns:"all"`);
    assert.equal(call.tool, "collaboration.spawn_agent");
  }
  // The same crew on a v1 model gets the v1 packet, agent_type still exact.
  const v1 = wave.map(task => codexSpawnAgentCall({ ...task, version: "v1" }));
  assert.deepEqual(v1.map(c => c.agent_type), ["muster-builder", "wsh-frontend-developer", "muster-reviewer"]);
  for (const call of v1) {
    assert.equal(call.tool, "multi_agent_v1.spawn_agent");
    assert.equal(call.fork_context, false);
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

// ── prose guards: orchestrator references/codex-dispatch.md ───────────────
// The Kimi sibling reference carries guards like these (test/kimi-dispatch.test.js);
// this reference had none, so the contracts the wave-dispatch mechanics depend on
// could rot silently. Pin NAMES, never sentences, so prose edits stay free.
const CODEX_DISPATCH_REF = new URL("../plugin/skills/orchestrator/references/codex-dispatch.md", import.meta.url);

async function codexDispatchSection() {
  const text = await readFile(CODEX_DISPATCH_REF, "utf8");
  const match = text.match(/### Codex-native dispatch[^\n]*\n([\s\S]*?)(?=\n### |\n## |$)/);
  assert.ok(match, "references/codex-dispatch.md must carry the '### Codex-native dispatch' section");
  return match[1];
}

test("references/codex-dispatch.md names the version-resolving packet builders (src/codex-dispatch.js is canonical)", async () => {
  const section = await codexDispatchSection();
  assert.match(section, /`codexSpawnAgentCall`/, "the Codex subsection must name codexSpawnAgentCall");
  assert.match(section, /`codexWaitAgentCall`/, "the Codex subsection must name codexWaitAgentCall");
});

test("references/codex-dispatch.md pins the fork_turns-is-a-string contract", async () => {
  const section = await codexDispatchSection();
  assert.match(section, /`fork_turns`/, "the Codex subsection must name fork_turns");
  assert.match(section, /STRING/, "the Codex subsection must state fork_turns is a STRING, not an integer");
});

test("production Codex surfaces contain no legacy shared-cwd wave selector", async () => {
  const source = await readFile(new URL("../src/wave-dispatch.js", import.meta.url), "utf8");
  const section = await codexDispatchSection();
  assert.doesNotMatch(source, /resolveCodexWaveDispatch|SEQUENTIAL_INLINE/);
  assert.doesNotMatch(section, /resolveCodexWaveDispatch|sequential-inline/);
});

test("references/codex-dispatch.md pins the mailbox-not-list_agents receipts rule", async () => {
  const section = await codexDispatchSection();
  assert.match(section, /mailbox/, "the Codex subsection must source receipts from the mailbox");
  assert.match(section, /`list_agents`/, "the Codex subsection must name list_agents as the thing NOT to receipt from");
});

test("references/codex-dispatch.md names assertCodexSpawnAgentAccepted for the fail-closed rejection path", async () => {
  const section = await codexDispatchSection();
  assert.match(section, /`assertCodexSpawnAgentAccepted`/, "the Codex subsection must name assertCodexSpawnAgentAccepted");
});
