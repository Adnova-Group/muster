// Claude adapter model-tiering policy (CLAUDE_MODEL_POLICY, per-role/per-tier
// resolution, neutral { tier, effort? } profile resolution). Mirrors
// test/codex-policy.test.js's neutral-profile cases: the Claude adapter is the
// same public surface as the Codex/Kimi adapters (claudeModelForRole /
// claudeProfileForConfig / claudeProfileForAgentId), with one documented
// difference -- Claude Code's per-subagent effort surface exists ONLY on the
// Workflow tool's agent() (observed live 2.1.220, 2026-07-29), not the Agent
// tool, so a semantic effort resolves to a lane-scoped `workflowEffort` field
// rather than an unconditional `effort` like Codex's.
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

test("applyEffort maps semantic efforts to Workflow-lane efforts without mutating the base", () => {
  const base = { model: "opus" };
  // Same lane semantics as Codex's CODEX_EFFORT (workhorse=medium, judgment=high,
  // peak=xhigh; max never routine), but scoped to `workflowEffort`: only the
  // Workflow tool's agent() takes an effort -- the Agent tool has no such param.
  assert.deepEqual(CLAUDE_MODEL_POLICY.applyEffort({ ...base }, "workhorse"), { model: "opus", workflowEffort: "medium" });
  assert.deepEqual(CLAUDE_MODEL_POLICY.applyEffort({ ...base }, "judgment"), { model: "opus", workflowEffort: "high" });
  assert.deepEqual(CLAUDE_MODEL_POLICY.applyEffort({ ...base }, "peak"), { model: "opus", workflowEffort: "xhigh" });
  // An unknown semantic leaves the profile untouched (assertNeutralProfile
  // guards upstream; this is the same fall-through codex.js takes).
  assert.deepEqual(CLAUDE_MODEL_POLICY.applyEffort({ ...base }, "nonsense"), { model: "opus" });
  assert.deepEqual(base, { model: "opus" }, "applyEffort must not annotate the caller's base profile");
});

test("claudeProfileForConfig resolves a neutral profile; effort becomes workflowEffort", () => {
  // No declared effort -> no workflowEffort key at all: Workflow agent() omits
  // effort to inherit the session effort, so an absent key IS the contract.
  assert.deepEqual(claudeProfileForConfig({ tier: "prime" }), { model: "opus" });
  assert.deepEqual(claudeProfileForConfig({ tier: "prime", effort: "peak" }), { model: "opus", workflowEffort: "xhigh" });
  assert.deepEqual(claudeProfileForConfig({ tier: "scout", effort: "workhorse" }), { model: "haiku", workflowEffort: "medium" });
});

test("claudeProfileForAgentId resolves manifest agents and returns null for non-agents", () => {
  // catalog/agents.manifest.json: muster-reviewer is prime/judgment (so it
  // carries the Workflow-lane judgment effort); muster-investigator is scout
  // with no declared effort (so no workflowEffort key -- inherit at dispatch).
  assert.deepEqual(claudeProfileForAgentId("muster-reviewer"), { model: "opus", workflowEffort: "high" });
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
