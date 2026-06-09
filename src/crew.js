// Manifest-builder primitives shared by diagnose.js and audit.js. Each builder
// keeps its own stage/crew/plan composition; only these capability-reading
// helpers are shared.
import { modelForRole } from "./model.js";

// The model tier a role's crew member must dispatch on. Prefer the model the
// capabilities map resolved for the role; fall back to the policy in model.js
// when caps doesn't carry one. This binds the model TO the crew member so the
// orchestrator can't drop the override and silently inherit its own (Opus).
export function modelFor(caps, role) {
  return (caps && caps.roles && caps.roles[role] && caps.roles[role].model) || modelForRole(role);
}

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
