// Manifest-builder primitives shared by diagnose.js and audit.js. Each builder
// keeps its own stage/crew/plan composition; only these capability-reading
// helpers are shared.

// The chosen provider for a role, defaulting to the inline fallback when the
// capabilities map has no entry for it.
export function chosen(caps, role) {
  return (caps && caps.roles && caps.roles[role] && caps.roles[role].chosen) || { id: "inline", source: "inline" };
}

// Deduped union of the recommendation strings across the given roles, preserving
// first-seen order. Guards the caps shape so a partial map can't throw.
export function collectRecommendations(caps, roles) {
  const recs = [];
  for (const r of roles)
    for (const rec of ((caps && caps.roles && caps.roles[r] && caps.roles[r].recommendations) || []))
      if (!recs.includes(rec)) recs.push(rec);
  return recs;
}
