// Harness-neutral model-tier override shape + resolver.
//
// The parked model-policy refactor's first slice. Today an agent's per-agent
// override in codex/agents.manifest.json names a CONCRETE Codex model/effort:
//   "muster-reviewer": { "tier": "sonnet", "model": "gpt-5.6-sol", "reasoning": "high" }
// Those strings are Codex-only — a Kimi (or Hermes) adapter cannot reuse them, so
// every new harness would re-hardcode its own model names into the manifest. This
// module defines the neutral vocabulary every adapter shares, so an agent declares
// only its conceptual tier and an OPTIONAL semantic effort, and each harness policy
// resolves those to its own concrete profile.
//
// Neutral agent profile: { tier, effort? }
//   tier   — a conceptual tier from MODEL_TIER_ORDER (model.js): haiku|sonnet|opus|fable.
//            Selects the model. This is already what the manifest calls "tier".
//   effort — an OPTIONAL semantic reasoning intent, NOT a harness effort string:
//              "workhorse" — the cost/quality sweet spot for producing work
//              "judgment"  — stronger reasoning where the output gates other work
//              "peak"      — the rare high-consequence maximum, reserved not routine
//            Omit to take the tier's default effort.
//
// The three real override shapes in today's manifest all reduce to { tier, effort }:
//   opus + reasoning:medium  (builders/debuggers)  -> { tier: opus,   effort: workhorse }
//   opus + reasoning:xhigh   (security-auditor)    -> { tier: opus,   effort: peak }
//   sonnet + model:sol,high  (the two reviewers)   -> { tier: opus,   effort: judgment }
//   tier: "luna-xhigh"       (surgeon/doc recipes) -> { tier: sonnet }  (Codex's sonnet
//                                                       policy IS luna/xhigh — byte-identical)
// so no manifest entry needs a concrete model string once the adapters adopt this shape.
//
// Each harness supplies a policy:
//   { tiers: { <tier>: <concrete profile> }, applyEffort(baseProfile, semanticEffort) }
// `tiers` gives the default concrete profile per tier; `applyEffort` maps a semantic
// effort onto a base profile in that harness's native ladder — and MAY be a no-op
// where the resolved model exposes no effort knob (e.g. Kimi's k2.7-code/k2.6).

import { MODEL_TIER_ORDER } from "./model.js";

export const NEUTRAL_EFFORTS = Object.freeze(["workhorse", "judgment", "peak"]);

// Throws on a malformed neutral profile so a typo fails loud at resolve time rather
// than silently resolving to some default tier/effort — the same fail-loud posture
// codexModelForTier already takes on an unknown tier.
export function assertNeutralProfile(profile) {
  if (!profile || typeof profile !== "object") {
    throw new Error(`neutral profile must be an object, got ${typeof profile}`);
  }
  if (!MODEL_TIER_ORDER.includes(profile.tier)) {
    throw new Error(
      `unknown neutral tier: ${JSON.stringify(profile.tier)} (expected one of ${MODEL_TIER_ORDER.join(", ")})`
    );
  }
  if (profile.effort !== undefined && !NEUTRAL_EFFORTS.includes(profile.effort)) {
    throw new Error(
      `unknown neutral effort: ${JSON.stringify(profile.effort)} (expected one of ${NEUTRAL_EFFORTS.join(", ")} or omit)`
    );
  }
}

// Resolve a neutral { tier, effort? } through a harness policy to that harness's
// concrete { model, ... } profile. Pure — never mutates the policy's frozen tier
// entries (applyEffort receives a shallow copy to shape).
export function resolveNeutralProfile(profile, policy) {
  assertNeutralProfile(profile);
  if (!policy || typeof policy.tiers !== "object" || typeof policy.applyEffort !== "function") {
    throw new Error("harness policy must be an object with { tiers, applyEffort }");
  }
  const base = policy.tiers[profile.tier];
  if (!base) throw new Error(`harness policy has no entry for tier: ${profile.tier}`);
  if (profile.effort === undefined) return { ...base };
  return policy.applyEffort({ ...base }, profile.effort);
}
