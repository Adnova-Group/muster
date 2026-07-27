// Harness-neutral model-tier override shape + resolver.
//
// The adopted model-policy shape (2026-07-23 neutral-shape migration, documented
// in catalog/agents.manifest.json): an agent's per-agent override names NO concrete
// model — it declares only its conceptual tier and an OPTIONAL semantic effort:
//   "muster-reviewer": { "tier": "prime", "effort": "judgment" }
// Harness-neutral by construction — a Kimi (or Hermes) adapter reuses the same
// entry unchanged, so no harness hardcodes its own model names into the manifest.
// This module defines the neutral vocabulary every adapter shares; each harness
// policy resolves it to its own concrete profile.
//
// Neutral agent profile: { tier, effort? }
//   tier   — a conceptual tier from MODEL_TIER_ORDER (model.js): scout|core|prime|apex.
//            Selects the model. Legacy names (haiku|sonnet|opus|fable) are accepted
//            and normalized — see LEGACY_TIER_ALIASES in model.js.
//   effort — an OPTIONAL semantic reasoning intent, NOT a harness effort string:
//              "workhorse" — the cost/quality sweet spot for producing work
//              "judgment"  — stronger reasoning where the output gates other work
//              "peak"      — the rare high-consequence maximum, reserved not routine
//            Omit to take the tier's default effort.
//
// The manifest's real overrides all fit this shape directly (Codex resolution
// shown; each harness policy resolves the same entry its own way):
//   prime + effort workhorse (builders/debuggers)  — Sol/medium on Codex
//   prime + effort judgment  (the two reviewers)   — Sol/high on Codex
//   prime + effort peak      (security-auditor)    — Sol/xhigh on Codex
//   core                     (surgeon/doc recipes) — Luna/xhigh on Codex
// so no manifest entry needs a concrete model string.
//
// Each harness supplies a policy:
//   { tiers: { <tier>: <concrete profile> }, applyEffort(baseProfile, semanticEffort) }
// `tiers` gives the default concrete profile per tier; `applyEffort` maps a semantic
// effort onto a base profile in that harness's native ladder — and MAY be a no-op
// where the resolved model exposes no effort knob (e.g. Kimi's k2.7-code/k2.6).

import { MODEL_TIER_ORDER, normalizeTier } from "./model.js";

export const NEUTRAL_EFFORTS = Object.freeze(["workhorse", "judgment", "peak"]);

// Throws on a malformed neutral profile so a typo fails loud at resolve time rather
// than silently resolving to some default tier/effort — the same fail-loud posture
// codexModelForTier already takes on an unknown tier.
export function assertNeutralProfile(profile) {
  if (!profile || typeof profile !== "object") {
    throw new Error(`neutral profile must be an object, got ${typeof profile}`);
  }
  if (!MODEL_TIER_ORDER.includes(normalizeTier(profile.tier))) {
    throw new Error(
      `unknown neutral tier: ${JSON.stringify(profile.tier)} (expected one of ${MODEL_TIER_ORDER.join(", ")}, or a legacy alias)`
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
  const base = policy.tiers[normalizeTier(profile.tier)];
  if (!base) throw new Error(`harness policy has no entry for tier: ${profile.tier}`);
  if (profile.effort === undefined) return { ...base };
  return policy.applyEffort({ ...base }, profile.effort);
}
