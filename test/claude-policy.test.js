// Claude adapter model-tiering policy (CLAUDE_MODEL_POLICY, per-role/per-tier
// resolution, neutral { tier, effort? } profile resolution). Mirrors
// test/codex-policy.test.js's neutral-profile cases: the Claude adapter is the
// same public surface as the Codex/Kimi adapters (claudeModelForRole /
// claudeProfileForConfig / claudeProfileForAgentId), with one documented
// difference -- Claude Code exposes no per-subagent reasoning-effort knob, so
// the semantic effort override is a no-op here.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CLAUDE_MODEL_POLICY,
  claudeModelForRole,
  claudeModelForTier,
  claudeProfileForAgentId,
  claudeProfileForConfig,
} from "../src/claude.js";

test("Claude policy tiers resolve to the Claude family models", () => {
  assert.deepEqual(CLAUDE_MODEL_POLICY.tiers, {
    scout: { model: "haiku" },
    core: { model: "sonnet" },
    prime: { model: "opus" },
    // apex maps to Fable for an opted-in apex dispatch (emission-layer
    // degradation in model.js means dispatch normally never reaches it).
    apex: { model: "fable" }
  });
  assert.deepEqual(claudeModelForTier("scout"), CLAUDE_MODEL_POLICY.tiers.scout);
  // legacy vocabulary keeps resolving through the alias layer
  assert.deepEqual(claudeModelForTier("haiku"), CLAUDE_MODEL_POLICY.tiers.scout);
  assert.deepEqual(claudeModelForTier("sonnet"), CLAUDE_MODEL_POLICY.tiers.core);
  assert.deepEqual(claudeModelForTier("fable"), CLAUDE_MODEL_POLICY.tiers.apex);
});

test("unknown tier fails loud", () => {
  assert.throws(() => claudeModelForTier("unknown"), /unknown Muster model tier/);
});

test("applyEffort is a no-op -- Claude Code has no per-subagent effort knob", () => {
  const base = { model: "opus" };
  assert.equal(CLAUDE_MODEL_POLICY.applyEffort(base, "peak"), base);
  assert.deepEqual(base, { model: "opus" }, "the no-op must not annotate the profile");
});

test("claudeProfileForConfig resolves a neutral profile, effort override ignored", () => {
  assert.deepEqual(claudeProfileForConfig({ tier: "prime" }), { model: "opus" });
  // The semantic effort still travels the manifest untouched -- Claude simply
  // has no knob to turn (same posture as Kimi's thinking-toggle tiers).
  assert.deepEqual(claudeProfileForConfig({ tier: "prime", effort: "peak" }), { model: "opus" });
  assert.deepEqual(claudeProfileForConfig({ tier: "scout", effort: "workhorse" }), { model: "haiku" });
});

test("claudeProfileForAgentId resolves manifest agents and returns null for non-agents", () => {
  // catalog/agents.manifest.json: muster-reviewer is prime/judgment,
  // muster-investigator is scout -- the effort is a no-op on Claude, so only
  // the tier's concrete family model resolves.
  assert.deepEqual(claudeProfileForAgentId("muster-reviewer"), { model: "opus" });
  assert.deepEqual(claudeProfileForAgentId("muster-investigator"), { model: "haiku" });
  // A skill/mcp/inline provider has no manifest entry -> null, not a throw.
  assert.equal(claudeProfileForAgentId("grep"), null);
  assert.equal(claudeProfileForAgentId("totally-not-an-agent"), null);
});

test("Claude adapter preserves shared cap and Fable fallback resolution", () => {
  const oldCap = process.env.MUSTER_MAX_TIER, oldApex = process.env.MUSTER_ENABLE_APEX, oldFable = process.env.MUSTER_ENABLE_FABLE;
  try {
    delete process.env.MUSTER_ENABLE_APEX;
    delete process.env.MUSTER_ENABLE_FABLE;
    delete process.env.MUSTER_MAX_TIER;
    assert.deepEqual(claudeModelForRole("code-review"), CLAUDE_MODEL_POLICY.tiers.core);
    // apex-set role with apex DISABLED degrades to prime (opus)
    assert.deepEqual(claudeModelForRole("architecture-review"), CLAUDE_MODEL_POLICY.tiers.prime);
    process.env.MUSTER_ENABLE_APEX = "true";
    assert.deepEqual(claudeModelForRole("architecture-review"), CLAUDE_MODEL_POLICY.tiers.apex);
    process.env.MUSTER_MAX_TIER = "sonnet";
    assert.deepEqual(claudeModelForRole("architecture-review"), CLAUDE_MODEL_POLICY.tiers.core);
  } finally {
    if (oldCap === undefined) delete process.env.MUSTER_MAX_TIER; else process.env.MUSTER_MAX_TIER = oldCap;
    if (oldApex === undefined) delete process.env.MUSTER_ENABLE_APEX; else process.env.MUSTER_ENABLE_APEX = oldApex;
    if (oldFable === undefined) delete process.env.MUSTER_ENABLE_FABLE; else process.env.MUSTER_ENABLE_FABLE = oldFable;
  }
});
