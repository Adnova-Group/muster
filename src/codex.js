import { modelForRole } from "./model.js";

// Codex is an adapter target, not a second tier resolver. Keep the conceptual
// Claude-like tiers in model.js and translate only when emitting Codex config.
// 2026-07-18 evidence-receipted retier (DeepSWE v1.1 leaderboard JSON of
// 2026-07-17, AA Coding Agent Index v1.2, and the sol reasoning-effort
// research pass -- see the codex-tier-remap-receipts PR's per-role table):
// - sol/medium is the measured workhorse point (61.1% pass@1 @ $1.86/task,
//   7.1 min; OpenAI's own recommended Codex default) -- the opus/medium roles
//   stay exactly there.
// - sol/high is the judgment lane (69.4% @ $3.47): ~1.9x medium's
//   subscription-quota burn, justified only where the output gates other
//   work (strategy, review verdicts, architecture, security). Above high the
//   marginal quality per credit collapses (+1.3pts for +36% at xhigh), so
//   xhigh is reserved for the single rare/high-consequence security lane and
//   max is never a routine default.
// - luna/xhigh (56.9% @ $1.54) is the budget lane for BOUNDED, low-context
//   work only -- luna's long-context recall is a 41.3% cliff (vs sol 91.5%),
//   so nothing that reads large diffs/codebases rides it. On quota-billed
//   plans it also spends from luna's separate ~3x larger message allowance,
//   preserving sol quota (and diversifies the model family on
//   verifier-adjacent work, where METR flags sol's reward-hack rate).
// - terra/high ($1.13 @ 53.8%, long-context safe) is the cheap locator lane:
//   haiku-tier read-only lookups that previously rode luna into its
//   long-context cliff.
export const CODEX_MODEL_POLICY = Object.freeze({
  haiku: Object.freeze({ model: "gpt-5.6-terra", reasoning: "high" }),
  sonnet: Object.freeze({ model: "gpt-5.6-luna", reasoning: "xhigh" }),
  opus: Object.freeze({ model: "gpt-5.6-sol", reasoning: "high" }),
  // Preserve the conceptual peak tier and its fallback resolution while using
  // the user's preferred Sol/high adapter policy instead of routine max effort.
  fable: Object.freeze({ model: "gpt-5.6-sol", reasoning: "high" }),
  "luna-xhigh": Object.freeze({ model: "gpt-5.6-luna", reasoning: "xhigh" })
});

export function codexModelForTier(tier) {
  const resolved = CODEX_MODEL_POLICY[tier];
  if (!resolved) throw new Error(`unknown Muster model tier: ${tier}`);
  return { ...resolved };
}

// This is the adapter boundary used by callers that resolve a role at runtime.
// modelForRole retains MUSTER_MAX_TIER and Fable's deterministic fallback.
export function codexModelForRole(role) {
  return codexModelForTier(modelForRole(role));
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
