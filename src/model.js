// Pick the cheapest model that fits a role's work (quota-aware, atomic-style).
// haiku: cheap/mechanical (locating, gathering). fable: peak judgment (the
// tournament judge, architecture review) — the only spots worth its 2x cost.
// sonnet: the default for implementation, review, authoring, scoring.
const HAIKU = new Set(["code-navigation", "docs-research", "research"]);
// "judge" is an intentional conceptual role OUTSIDE the resolved ROLES enum
// (roles.js): the tournament skill (plugin/skills/tournament/SKILL.md) dispatches
// a judge agent to score candidates. "architecture-review" is a canonical ROLES
// member. Dead names (strategist, architect) removed — never passed to
// modelForRole; muster-strategist is a provider id, not a role.
const FABLE = new Set(["judge", "architecture-review"]);

// Ascending capability order. opus is included because it is a valid dispatch
// tier via fallbackModelFor (fable degrades to opus) even though modelForRole
// never emits it directly. Declared before capTier/modelForRole to avoid TDZ.
export const MODEL_TIER_ORDER = ["haiku", "sonnet", "opus", "fable"];

// Caps a resolved tier to a maximum. If cap is a valid tier name from
// MODEL_TIER_ORDER and tier sits strictly above cap in the order, returns cap;
// otherwise returns tier unchanged. An invalid or unset cap is a no-op
// (fail-open so a misconfigured env never breaks dispatch).
export function capTier(tier, cap = process.env.MUSTER_MAX_TIER) {
  if (!cap) return tier;
  const capIdx = MODEL_TIER_ORDER.indexOf(cap);
  if (capIdx === -1) return tier; // invalid cap name — ignore
  const tierIdx = MODEL_TIER_ORDER.indexOf(tier);
  if (tierIdx === -1) return tier; // unknown tier — ignore
  return tierIdx > capIdx ? cap : tier;
}

export function modelForRole(role) {
  if (HAIKU.has(role)) return capTier("haiku");
  if (FABLE.has(role)) return capTier("fable");
  return capTier("sonnet");
}

// Fable may be unavailable on a given plan (e.g. it requires extra usage
// credits). Dispatch degrades per this map — never fail the task over a model
// tier, and never silently inherit the orchestrator's model. Tiers without an
// entry are their own fallback.
const FALLBACK = { fable: "opus" };

export function fallbackModelFor(model) {
  return FALLBACK[model] || model;
}

// Floors a resolved tier at sonnet. An agent never pins below sonnet — haiku-
// tier (mechanical) roles ride the orchestrator's override instead.
// Returns sonnet if tier is undefined or below sonnet in MODEL_TIER_ORDER.
const SONNET_IDX = MODEL_TIER_ORDER.indexOf("sonnet");
export function floorAtSonnet(tier) {
  if (tier === undefined) return MODEL_TIER_ORDER[SONNET_IDX];
  return MODEL_TIER_ORDER.indexOf(tier) >= SONNET_IDX ? tier : MODEL_TIER_ORDER[SONNET_IDX];
}

// Returns the highest-capability tier from a list of model names, according to
// MODEL_TIER_ORDER. Unknown names are silently ignored. Returns undefined when
// the list is empty or contains no known tiers.
export function maxTier(models) {
  let best = -1;
  for (const m of models) {
    const idx = MODEL_TIER_ORDER.indexOf(m);
    if (idx > best) best = idx;
  }
  return best === -1 ? undefined : MODEL_TIER_ORDER[best];
}
