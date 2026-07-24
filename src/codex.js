import { modelForRole } from "./model.js";
import { agentProfiles } from "./agent-manifest.js";
import { resolveNeutralProfile } from "./model-policy.js";

// Codex is an adapter target, not a second tier resolver. Keep the conceptual
// Claude-like tiers in model.js and translate only when emitting Codex config.
// This adapter now consumes the harness-neutral { tier, effort? } shape
// (src/model-policy.js): a manifest agent declares a conceptual tier and an
// optional SEMANTIC effort (workhorse|judgment|peak); the `tiers` map picks the
// gpt-5.6 model + a tier-default effort, and `applyEffort` dials the reasoning
// effort per the evidence below. No agent names a concrete gpt-5.6 model any more.
//
// 2026-07-18 evidence-receipted lanes (DeepSWE v1.1 leaderboard JSON of
// 2026-07-17, AA Coding Agent Index v1.2, and the sol reasoning-effort research
// pass -- see the codex-tier-remap-receipts PR's per-role table):
// - sol/medium (semantic "workhorse") is the measured workhorse point (61.1%
//   pass@1 @ $1.86/task, 7.1 min; OpenAI's own recommended Codex default).
// - sol/high (semantic "judgment", and the opus/fable tier default) is the
//   judgment lane (69.4% @ $3.47): ~1.9x medium's subscription-quota burn,
//   justified only where the output gates other work (strategy, review
//   verdicts, architecture). Above high the marginal quality per credit
//   collapses (+1.3pts for +36% at xhigh), so...
// - sol/xhigh (semantic "peak") is reserved for the single rare/high-consequence
//   security lane; max is never a routine default.
// - luna/xhigh (56.9% @ $1.54) is the sonnet-tier lane for BOUNDED, low-context
//   work -- luna's long-context recall is a 41.3% cliff (vs sol 91.5%), so
//   nothing that reads large diffs/codebases rides it; it also spends luna's
//   separate ~3x larger message allowance, preserving sol quota, and diversifies
//   the family on verifier-adjacent work (METR flags sol's reward-hack rate).
//   (The former "luna-xhigh" tier was byte-identical to sonnet and is gone.)
// - terra/high (the haiku tier, $1.13 @ 53.8%, long-context safe) is the cheap
//   read-only locator lane.
const CODEX_EFFORT = Object.freeze({ workhorse: "medium", judgment: "high", peak: "xhigh" });

export const CODEX_MODEL_POLICY = Object.freeze({
  tiers: Object.freeze({
    haiku: Object.freeze({ model: "gpt-5.6-terra", effort: "high" }),
    sonnet: Object.freeze({ model: "gpt-5.6-luna", effort: "xhigh" }),
    opus: Object.freeze({ model: "gpt-5.6-sol", effort: "high" }),
    // Fable stays a conceptual peak tier; on Codex it adapts to Sol/high, never
    // routine max (model.js still degrades fable -> opus when Fable is disabled).
    fable: Object.freeze({ model: "gpt-5.6-sol", effort: "high" })
  }),
  // A semantic effort override dials the reasoning effort on the tier's model;
  // an unknown semantic (shouldn't reach here -- assertNeutralProfile guards it)
  // leaves the tier default in place.
  applyEffort(base, semantic) {
    return { ...base, effort: CODEX_EFFORT[semantic] ?? base.effort };
  }
});

export function codexModelForTier(tier) {
  const resolved = CODEX_MODEL_POLICY.tiers[tier];
  if (!resolved) throw new Error(`unknown Muster model tier: ${tier}`);
  return { ...resolved };
}

// This is the adapter boundary used by callers that resolve a role at runtime.
// modelForRole retains MUSTER_MAX_TIER and Fable's deterministic fallback.
export function codexModelForRole(role) {
  return codexModelForTier(modelForRole(role));
}

// The frozen agent map comes from the shared, harness-neutral manifest
// (agent-manifest.js reads catalog/agents.manifest.json) — the SAME file the Kimi
// adapter resolves. Keyed by agent id (== .codex/agents/<id>.toml filename ==
// `capabilities --codex` chosen.id for an agent provider).

// SINGLE SOURCE for the concrete {model, effort} a manifest agent entry
// resolves to on Codex: the harness-neutral { tier, effort? } config resolves
// through CODEX_MODEL_POLICY (resolveNeutralProfile validates tier/effort and
// applies applyEffort). codex-release.js's profileToml emits the committed TOML
// pins through this exact resolution, and the `capabilities --codex` lane reads
// it, so a driver sees the precise pre-dispatch profile without the post-run
// codex-conformance audit.
export function codexProfileForConfig(config) {
  return resolveNeutralProfile(config, CODEX_MODEL_POLICY);
}

// Resolve an agent id (a `capabilities --codex` chosen.id) to its Codex
// {model, effort}. Returns null for an id with no manifest profile (a non-agent
// provider — skill/mcp/inline — has no .codex/agents TOML to dispatch on).
export function codexProfileForAgentId(id) {
  const config = agentProfiles()[id];
  return config ? codexProfileForConfig(config) : null;
}

export const CODEX_COUNTS = Object.freeze({
  agents: 27,
  nativeSkills: 11,
  builtinSkills: 51,
  publicSkills: 12,
  internalSkills: 62,
  pipelines: 20,
  mcpTools: 28,
  primaryModes: 8,
  aliases: 3
});
