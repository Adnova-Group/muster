import { modelForRole, normalizeTier } from "./model.js";
import { resolveNeutralProfile } from "./model-policy.js";
import { agentProfiles } from "./agent-manifest.js";

// Claude is an adapter target, not the identity muster's tiers are named after —
// the same posture as codex.js and kimi.js. Through 2026-07-26 the conceptual
// tiers WERE the Claude family names (haiku|sonnet|opus|fable), which made this
// adapter implicit and unwritten; the semantic-tier rename (scout|core|prime|
// apex, model.js) makes it explicit. The family names below are Claude's
// CONCRETE model values — what Claude Code's own surfaces consume: the agent
// frontmatter `model:` field, the Agent tool's `model` param, and settings-level
// model aliases. They are harness words now, exactly like "gpt-5.6-sol" and
// "kimi-code/k3".
//
// Claude Code exposes no per-subagent reasoning-effort knob, so a semantic
// effort override (workhorse|judgment|peak) is a documented no-op here — the
// same posture as Kimi's always-thinking coding models. Effort still travels
// through the shared manifest untouched: Codex dials reasoning_effort with it
// and Kimi dials K3's effort ladder; Claude simply has no knob to turn.
export const CLAUDE_MODEL_POLICY = Object.freeze({
  tiers: Object.freeze({
    scout: Object.freeze({ model: "haiku" }),
    core: Object.freeze({ model: "sonnet" }),
    prime: Object.freeze({ model: "opus" }),
    // apex maps to Fable when platform-enabled; model.js's emission-layer
    // degradation (apex → prime unless MUSTER_ENABLE_APEX) means dispatch
    // normally never reaches this entry — it exists so an opted-in apex
    // dispatch resolves rather than throwing.
    apex: Object.freeze({ model: "fable" }),
  }),
  applyEffort(base) {
    return base; // no per-subagent effort surface on Claude Code
  },
});

export function claudeModelForTier(tier) {
  const resolved = CLAUDE_MODEL_POLICY.tiers[normalizeTier(tier)];
  if (!resolved) throw new Error(`unknown Muster model tier: ${tier}`);
  return { ...resolved };
}

// Adapter boundary for callers that resolve a role at runtime. modelForRole
// keeps MUSTER_MAX_TIER and the apex → prime degradation.
export function claudeModelForRole(role) {
  return claudeModelForTier(modelForRole(role));
}

// SINGLE SOURCE for the concrete Claude model a HARNESS-NEUTRAL agent config
// resolves to. Consumes { tier, effort? } (model-policy.js) from the SAME
// catalog/agents.manifest.json the Codex and Kimi adapters read. Mirrors
// codexProfileForConfig / kimiProfileForConfig.
export function claudeProfileForConfig(config) {
  return resolveNeutralProfile(config, CLAUDE_MODEL_POLICY);
}

// Resolve an agent id (a manifest key) to its concrete Claude {model}. Returns
// null for a non-agent provider (skill/mcp/inline) with no manifest entry.
export function claudeProfileForAgentId(id) {
  const config = agentProfiles()[id];
  return config ? claudeProfileForConfig(config) : null;
}
