// Pick the cheapest model that fits a role's work (quota-aware, atomic-style).
// haiku: cheap/mechanical (locating, gathering). opus: heavy judgment (strategy, the tournament judge).
// sonnet: the default for implementation, review, authoring, scoring.
const HAIKU = new Set(["code-navigation", "docs-research", "research"]);
const OPUS = new Set(["strategist", "judge", "architect", "architecture-review"]);

export function modelForRole(role) {
  if (HAIKU.has(role)) return "haiku";
  if (OPUS.has(role)) return "opus";
  return "sonnet";
}
