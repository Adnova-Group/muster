// Pick the cheapest model that fits a role's work (quota-aware, atomic-style).
// haiku: cheap/mechanical (locating, gathering). opus: heavy judgment (strategy, the tournament judge).
// sonnet: the default for implementation, review, authoring, scoring.
const HAIKU = new Set(["code-navigation", "docs-research", "research"]);
// "judge" is an intentional conceptual role OUTSIDE the resolved ROLES enum
// (roles.js): the tournament skill (plugin/skills/tournament/SKILL.md) dispatches
// a "judge agent on opus" to score candidates. "architecture-review" is a
// canonical ROLES member. Dead names (strategist, architect) removed — never
// passed to modelForRole; muster-strategist is a provider id, not a role.
const OPUS = new Set(["judge", "architecture-review"]);

export function modelForRole(role) {
  if (HAIKU.has(role)) return "haiku";
  if (OPUS.has(role)) return "opus";
  return "sonnet";
}
