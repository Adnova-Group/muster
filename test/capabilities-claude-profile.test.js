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
import { adaptCatalogForCodex } from "../src/codex-catalog.js";
import { claudeModelForTier, claudeProfileForAgentId } from "../src/claude.js";
import { modelForRole } from "../src/model.js";

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

// ── audit S3 (2026-07-30): the two Claude-lane coherence rules ──────────────
// P1 PRECEDENCE. Through 2026-07-29 an agent-backed role emitted TWO different
// Claude models: claudeModel came from the role's tier
// (claudeModelForTier(modelForRole(role))) while claudeProfile came from the
// chosen agent's manifest entry -- and on live roles they disagreed (implement:
// sonnet vs opus), so a driver reading capabilities.json had no single dispatch
// pin. The manifest profile is authoritative (the same fail-closed posture the
// Codex lane's committed profile pins take), so claudeModel IS
// claudeProfile.model whenever the chosen agent has a profile; the role-tier
// derivation survives only as the fallback for roles with no agent-backed
// profile (inline/skill/mcp chosen, or an agent with no manifest entry).
test("capabilities: an agent-backed role's claudeModel IS its claudeProfile.model, and the role tier is only the fallback", async () => {
  const { roles } = await caps();
  let profileBacked = 0;
  for (const [role, entry] of Object.entries(roles)) {
    if (!("claudeProfile" in entry)) {
      assert.equal(entry.claudeModel, claudeModelForTier(modelForRole(role)).model,
        `${role}: no agent-backed profile -> claudeModel must fall back to the role tier`);
      continue;
    }
    profileBacked += 1;
    assert.equal(entry.claudeModel, entry.claudeProfile.model,
      `${role}: claudeModel (${entry.claudeModel}) contradicts its own claudeProfile.model (${entry.claudeProfile.model})`);
  }
  assert.ok(profileBacked > 0, "sanity: at least one role is profile-backed");
  // The live contradiction this fix closes: implement resolves to muster-builder
  // (prime + workhorse in catalog/agents.manifest.json) while the implement role
  // tier is core -- claudeModel used to say sonnet next to a profile saying opus.
  assert.equal(roles.implement.chosen.id, "muster-builder", "sanity: implement resolves to muster-builder");
  assert.deepEqual(roles.implement.claudeProfile, { model: "opus", workflowEffort: "medium" });
  assert.equal(roles.implement.claudeModel, "opus", "implement must dispatch on the profile's model, not the role tier");
});

// The profile is authoritative for WHICH tier a member dispatches on, but the
// emission layer still governs what may be emitted: a manifest apex entry
// (muster-strategist, muster-improver) must degrade like every other apex
// dispatch (model.js) instead of pinning platform-gated Fable, and
// MUSTER_MAX_TIER must still cap the concrete pin -- otherwise making the
// profile authoritative would smuggle an undispatchable/uncapped model into the
// one field the orchestrator dispatches on.
test("capabilities: the profile-authoritative claudeModel still honors apex degradation and MUSTER_MAX_TIER", async () => {
  const saved = { apex: process.env.MUSTER_ENABLE_APEX, fable: process.env.MUSTER_ENABLE_FABLE, cap: process.env.MUSTER_MAX_TIER };
  try {
    delete process.env.MUSTER_ENABLE_APEX;
    delete process.env.MUSTER_ENABLE_FABLE;
    delete process.env.MUSTER_MAX_TIER;
    const off = await caps();
    assert.equal(off.roles.plan.chosen.id, "muster-strategist", "sanity: plan resolves to the apex-tier strategist");
    assert.deepEqual(off.roles.plan.claudeProfile, { model: "opus" }, "apex disabled -> the manifest apex profile degrades to prime");
    assert.equal(off.roles.plan.claudeModel, "opus", "apex disabled -> no Fable pin on the dispatch field");
    process.env.MUSTER_ENABLE_APEX = "1";
    const on = await caps();
    assert.equal(on.roles.plan.claudeModel, "fable", "apex opted in -> the peak tier resolves");
    delete process.env.MUSTER_ENABLE_APEX;
    process.env.MUSTER_MAX_TIER = "core";
    const capped = await caps();
    assert.equal(capped.roles.implement.claudeModel, "sonnet", "MUSTER_MAX_TIER=core must cap the profile-derived pin");
    assert.equal(capped.roles.implement.claudeProfile.model, "sonnet", "the capped profile and the pin stay identical");
  } finally {
    for (const [key, value] of [["MUSTER_ENABLE_APEX", saved.apex], ["MUSTER_ENABLE_FABLE", saved.fable], ["MUSTER_MAX_TIER", saved.cap]]) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
});

// P2 LANE SCOPE. claudeModel/claudeProfile are Claude DISPATCH fields: they
// belong on the lanes whose host dispatches Claude models (default + cowork).
// The --codex and --kimi lanes emit their own codexModel/kimiModel and their
// drivers never call the Agent tool, so a Claude model sitting beside
// codexModel is noise a driver could act on. Through 2026-07-29 the only guard
// was `!work`, so both fields leaked into those two lanes.
test("capabilities: claudeModel/claudeProfile ride the Claude lanes only -- absent under --codex and --kimi", async () => {
  const catalog = await loadCatalog(new URL("../catalog/", import.meta.url));
  const claudeLane = await caps();
  const claudeRole = Object.entries(claudeLane.roles).find(([, r]) => "claudeProfile" in r);
  assert.ok(claudeRole, "sanity: the default lane has a profile-backed role");
  assert.ok("claudeModel" in claudeRole[1], "the default lane keeps claudeModel");

  const codexLane = resolveCapabilities(adaptCatalogForCodex(catalog, installed), installed, undefined, { codex: true });
  for (const [role, entry] of Object.entries(codexLane.roles)) {
    assert.ok(!("claudeModel" in entry), `--codex ${role}: must not carry claudeModel`);
    assert.ok(!("claudeProfile" in entry), `--codex ${role}: must not carry claudeProfile`);
  }
  assert.ok(Object.values(codexLane.roles).some((r) => "codexModel" in r), "sanity: the --codex lane still carries codexModel");

  const kimiLane = resolveCapabilities(catalog, installed, undefined, { kimi: true });
  for (const [role, entry] of Object.entries(kimiLane.roles)) {
    assert.ok(!("claudeModel" in entry), `--kimi ${role}: must not carry claudeModel`);
    assert.ok(!("claudeProfile" in entry), `--kimi ${role}: must not carry claudeProfile`);
  }
  assert.ok(Object.values(kimiLane.roles).some((r) => "kimiModel" in r), "sanity: the --kimi lane still carries kimiModel");
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
