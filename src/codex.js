import { modelForRole } from "./model.js";

// Codex is an adapter target, not a second tier resolver. Keep the conceptual
// Claude-like tiers in model.js and translate only when emitting Codex config.
export const CODEX_MODEL_POLICY = Object.freeze({
  haiku: Object.freeze({ model: "gpt-5.6-luna", reasoning: "high" }),
  sonnet: Object.freeze({ model: "gpt-5.6-terra", reasoning: "xhigh" }),
  opus: Object.freeze({ model: "gpt-5.6-sol", reasoning: "high" }),
  fable: Object.freeze({ model: "gpt-5.6-sol", reasoning: "max" })
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
  pipelines: 20,
  mcpTools: 21,
  primaryModes: 8,
  aliases: 3
});
