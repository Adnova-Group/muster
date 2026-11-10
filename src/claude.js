import { emissionTier, modelForRole, normalizeTier } from "./model.js";
import { assertNeutralProfile, resolveNeutralProfile } from "./model-policy.js";
import { agentProfiles } from "./agent-manifest.js";

// Claude is an adapter target, not the identity muster's tiers are named after —
// the same posture as codex.js. Through 2026-07-26 the conceptual
// tiers WERE the Claude family names (haiku|sonnet|opus|fable), which made this
// adapter implicit and unwritten; the semantic-tier rename (scout|core|prime|
// apex, model.js) makes it explicit. The family names below are Claude's
// CONCRETE model values — what Claude Code's own surfaces consume: the agent
// frontmatter `model:` field, the Agent tool's `model` param, and settings-level
// model aliases. They are harness words now, exactly like "gpt-5.6-sol".
//
// Claude Code's per-subagent reasoning effort has two dispatch surfaces, and the
// same semantic ladder feeds both:
//   - the Workflow tool's agent() `effort` (observed live on 2.1.220, 2026-07-29),
//     resolved here as `workflowEffort`;
//   - the Agent tool's `effort` parameter, added in Claude Code 2.1.292 (it
//     overrides the agent's frontmatter `effort:`), resolved here as `agentEffort`.
//     Through 2.1.291 the Agent tool had no effort parameter and this adapter said
//     so; the prose fallback (orchestrator SKILL.md) now passes it per seat.
// Agent frontmatter `effort:` is written from the same ladder by vendor.js. Ladder
// mirrors the Codex lanes (codex.js CODEX_EFFORT): workhorse=medium (the
// cost/quality default), judgment=high (output gates other work), peak=xhigh
// (rare high-consequence; max never routine). No declared effort -> neither key:
// an omitted effort inherits the session's, so an absent key is the correct
// default. CLAUDE_CODE_EFFORT_LEVEL still beats both surfaces (preflight warns).
const CLAUDE_EFFORT = Object.freeze({ workhorse: "medium", judgment: "high", peak: "xhigh" });

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
  // A semantic effort dials both lanes' effort on the tier's model; an
  // unknown semantic (shouldn't reach here -- assertNeutralProfile guards it)
  // leaves the profile untouched, same fall-through as codex.js.
  applyEffort(base, semantic) {
    const effort = CLAUDE_EFFORT[semantic];
    return effort ? { ...base, workflowEffort: effort, agentEffort: effort } : { ...base };
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
// catalog/agents.manifest.json the Codex adapter reads. Mirrors
// codexProfileForConfig.
//
// The declared tier goes through the shared emission layer (model.js
// emissionTier: apex opt-in check + MUSTER_MAX_TIER) before it is resolved.
// Every harness adapter applies that governance to manifest profiles so an
// agent-level tier cannot escape the same cap and apex opt-in used by role
// resolution. This is especially load-bearing on Claude, where a disabled apex
// would emit platform-gated Fable and be rejected. The semantic effort is a
// separate axis and is never touched by the cap.
export function claudeProfileForConfig(config) {
  // Asserted on the CALLER's config first so a malformed entry still fails loud
  // with its own message (a governed tier would mask which field was wrong).
  assertNeutralProfile(config);
  return resolveNeutralProfile({ ...config, tier: emissionTier(config.tier) }, CLAUDE_MODEL_POLICY);
}

// Resolve an agent id (a manifest key) to its concrete Claude {model}. Returns
// null for a non-agent provider (skill/mcp/inline) with no manifest entry.
export function claudeProfileForAgentId(id) {
  const config = agentProfiles()[id];
  return config ? claudeProfileForConfig(config) : null;
}
