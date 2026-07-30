import { emissionTier, modelForRole, normalizeTier } from "./model.js";
import { assertNeutralProfile, resolveNeutralProfile } from "./model-policy.js";
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
// Claude Code's per-subagent reasoning-effort knob exists on exactly ONE
// surface: the Workflow tool's agent() takes `effort:
// 'low'|'medium'|'high'|'xhigh'|'max'` per spawned agent (observed live against
// a 2.1.220 session, 2026-07-29 — the cc-workflow-lane correction; through
// 2026-07-28 this adapter documented "no per-subagent effort surface", which
// was true of the Agent tool and still is: the Agent tool carries no effort
// parameter). A semantic effort therefore resolves to a lane-scoped
// `workflowEffort` field — consumed only by Workflow-lane dispatch
// (orchestrator SKILL.md's native lane), never emitted into agent frontmatter
// or Agent-tool calls. Ladder mirrors the Codex lanes (codex.js CODEX_EFFORT):
// workhorse=medium (the cost/quality default), judgment=high (output gates
// other work), peak=xhigh (rare high-consequence; max never routine). No
// declared effort -> no workflowEffort key: Workflow agent() omits effort to
// inherit the session effort, so an absent key is the correct default.
const CLAUDE_WORKFLOW_EFFORT = Object.freeze({ workhorse: "medium", judgment: "high", peak: "xhigh" });

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
  // A semantic effort dials the Workflow-lane effort on the tier's model; an
  // unknown semantic (shouldn't reach here -- assertNeutralProfile guards it)
  // leaves the profile untouched, same fall-through as codex.js.
  applyEffort(base, semantic) {
    const workflowEffort = CLAUDE_WORKFLOW_EFFORT[semantic];
    return workflowEffort ? { ...base, workflowEffort } : { ...base };
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
//
// The declared tier goes through the shared emission layer (model.js
// emissionTier: apex opt-in check + MUSTER_MAX_TIER) before it is resolved,
// because on Claude the apex tier's model is PLATFORM-GATED -- Fable. The
// Codex/Kimi apex entries (sol/high, k3/max) are always dispatchable, so those
// adapters can resolve a manifest tier raw; a Claude dispatch on a disabled
// apex is REJECTED, which is exactly what model.js's degradation exists to
// prevent (and why the apex tier entry above documents "dispatch normally never
// reaches it"). Since capabilities.js now treats this profile as the
// authoritative dispatch pin (audit S3), resolving apex raw here would have put
// `fable` in the field the orchestrator dispatches on, and a manifest-declared
// prime agent would have escaped a MUSTER_MAX_TIER=core budget cap. The
// semantic effort is a separate axis and is never touched by the cap.
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
