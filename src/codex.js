import { modelForRole } from "./model.js";

// Codex is an adapter target, not a second tier resolver. Keep the conceptual
// Claude-like tiers in model.js and translate only when emitting Codex config.
export const CODEX_MODEL_POLICY = Object.freeze({
  haiku: Object.freeze({ model: "gpt-5.6-luna", reasoning: "high" }),
  sonnet: Object.freeze({ model: "gpt-5.6-luna", reasoning: "xhigh" }),
  opus: Object.freeze({ model: "gpt-5.6-sol", reasoning: "high" }),
  // Preserve the conceptual peak tier and its fallback resolution while using
  // the user's preferred Sol/high adapter policy instead of routine max effort.
  fable: Object.freeze({ model: "gpt-5.6-sol", reasoning: "high" }),
  // Fix-2 retier (user-approved amendment, evidence: DeepSWE v1.1 luna/low
  // 1.5% pass@1 vs luna/xhigh 56.9% pass@1 at $1.54/task): an ADDED lane, not
  // a change to `sonnet` above. The same narrowly scoped, mechanical
  // Sonnet-sourced Codex agents (muster-surgeon, wsh-api-documenter,
  // wsh-tutorial-engineer) that keyed off the wave-3 luna-low lane now key
  // their codex/agents.manifest.json entry off this cost-based Luna/xhigh
  // lane instead, so every other Sonnet-tier role's runtime model resolution
  // (via codexModelForRole/CODEX_MODEL_POLICY.sonnet) is untouched. The
  // reservation clause is now cost-based: xhigh is allowed on the luna model;
  // terra (any effort) and xhigh on any non-luna model remain reserved for
  // muster-strategist (fable tier, gpt-5.6-sol/high, unchanged).
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
  mcpTools: 21,
  primaryModes: 8,
  aliases: 3
});
