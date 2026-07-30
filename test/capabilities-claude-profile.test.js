// capabilities-claude-profile (audit 2026-07-29, slice E): the Claude lane's
// sibling of the codexModel/kimiModel emissions. `capabilities` attaches
// claudeProfile: {model, workflowEffort?} to each agent-backed role -- the
// SAME manifest-driven resolution (claudeProfileForAgentId) the codex/kimi
// lanes use -- so orchestrator SKILL.md's native Workflow dispatch
// ("effort = the member's claudeProfile.workflowEffort") reads a field that
// EXISTS in capabilities.json instead of referencing a resolver with no live
// consumer. These tests pin the coherence: the field equals the adapter's
// own resolution for the role's chosen agent, carries workflowEffort exactly
// when the member's profile declares a semantic effort, and stays absent on
// the lanes that never had it (non-agent chosen, Work runtime).
import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveCapabilities } from "../src/capabilities.js";
import { loadCatalog } from "../src/catalog.js";
import { claudeProfileForAgentId } from "../src/claude.js";

// Hermetic inventory, same posture as test/capabilities-codex-model.test.js:
// agent-kind roles resolve the same chosen agents deterministically without
// reading the live home dir.
const installed = { skills: [], plugins: [], mcpServers: [] };

async function caps(opts = {}) {
  const catalog = await loadCatalog(new URL("../catalog/", import.meta.url));
  return resolveCapabilities(catalog, installed, undefined, opts);
}

test("capabilities: every agent-backed role carries claudeProfile equal to the adapter's own resolution", async () => {
  const { roles } = await caps();
  let agentBacked = 0;
  for (const [role, entry] of Object.entries(roles)) {
    if (entry.chosen.kind !== "agent") {
      assert.ok(!("claudeProfile" in entry), `${role}: non-agent chosen must not carry claudeProfile`);
      continue;
    }
    agentBacked += 1;
    const expected = claudeProfileForAgentId(entry.chosen.id);
    if (expected === null) {
      assert.ok(!("claudeProfile" in entry), `${role}: chosen ${entry.chosen.id} has no manifest profile, no claudeProfile key`);
      continue;
    }
    assert.deepEqual(entry.claudeProfile, expected, `${role}: claudeProfile diverged from claudeProfileForAgentId(${entry.chosen.id})`);
  }
  assert.ok(agentBacked > 0, "sanity: at least one role is agent-backed");
});

test("capabilities: workflowEffort rides claudeProfile exactly when the member's profile declares a semantic effort", async () => {
  const { roles } = await caps();
  const roleByAgent = (id) => Object.values(roles).find((r) => r.chosen.kind === "agent" && r.chosen.id === id);
  // muster-reviewer declares judgment -> workflowEffort high (test/claude-policy.test.js
  // pins the adapter resolution itself); muster-investigator declares no effort,
  // so the key is absent and Workflow agent() inherits the session effort.
  const reviewer = roleByAgent("muster-reviewer");
  assert.ok(reviewer, "no role resolves to the muster-reviewer agent");
  assert.deepEqual(reviewer.claudeProfile, { model: "opus", workflowEffort: "high" });
  const investigator = roleByAgent("muster-investigator");
  assert.ok(investigator, "no role resolves to the muster-investigator agent");
  assert.deepEqual(investigator.claudeProfile, { model: "haiku" });
  assert.ok(!("workflowEffort" in investigator.claudeProfile), "no declared effort -> no workflowEffort key");
});

test("capabilities: the Work runtime stays harness-neutral -- no claudeProfile (mirrors claudeModel)", async () => {
  const { roles } = await resolveCapabilities(
    await loadCatalog(new URL("../catalog/", import.meta.url)),
    { runtime: "work", skills: [], plugins: [], mcpServers: [] }
  );
  assert.ok(
    Object.values(roles).every((role) => !("claudeProfile" in role)),
    "Work roles must not carry claudeProfile"
  );
});
