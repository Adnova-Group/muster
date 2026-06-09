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

export function modelForRole(role) {
  if (HAIKU.has(role)) return "haiku";
  if (FABLE.has(role)) return "fable";
  return "sonnet";
}

// Fable may be unavailable on a given plan (e.g. it requires extra usage
// credits). Dispatch degrades per this map — never fail the task over a model
// tier, and never silently inherit the orchestrator's model. Tiers without an
// entry are their own fallback.
const FALLBACK = { fable: "opus" };

export function fallbackModelFor(model) {
  return FALLBACK[model] || model;
}

// Ascending capability order. opus is included because it is a valid dispatch
// tier via fallbackModelFor (fable degrades to opus) even though modelForRole
// never emits it directly.
export const MODEL_TIER_ORDER = ["haiku", "sonnet", "opus", "fable"];

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
