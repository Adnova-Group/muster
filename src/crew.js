// Manifest-builder primitives shared by diagnose.js and audit.js. Includes
// capability-reading helpers and the makeStage factory that produces the
// capability-derived crew-member shape used by both builders.
import { modelForRole } from "./model.js";

// Safe accessor: returns caps.roles[role] or undefined without throwing on a
// partial / missing caps map.
function getRoleEntry(caps, role) {
  return caps && caps.roles && caps.roles[role];
}

// The model tier a role's crew member must dispatch on. Prefer the model the
// capabilities map resolved for the role; fall back to the policy in model.js
// when caps doesn't carry one. This binds the model TO the crew member so the
// orchestrator can't drop the override and silently inherit its own (Opus).
export function modelFor(caps, role) {
  const entry = getRoleEntry(caps, role);
  return (entry && entry.model) || modelForRole(role);
}

// The chosen provider for a role, defaulting to the inline fallback when the
// capabilities map has no entry for it.
export function chosen(caps, role) {
  const entry = getRoleEntry(caps, role);
  return (entry && entry.chosen) || { id: "inline", source: "inline" };
}

// Deduped union of the recommendation strings across the given roles, preserving
// first-seen order. Guards the caps shape so a partial map can't throw.
export function collectRecommendations(caps, roles) {
  const recs = [];
  for (const r of roles) {
    const entry = getRoleEntry(caps, r);
    for (const rec of ((entry && entry.recommendations) || []))
      if (!recs.includes(rec)) recs.push(rec);
  }
  return recs;
}

// Factory: returns a stage builder closed over caps and a fixed evidence string.
// Both diagnose.js and audit.js use this to produce crew-member objects.
export function makeStage(caps, evidence) {
  return (role, rationale) => {
    const p = chosen(caps, role);
    return { stage: role, provider: p.id, source: p.source, model: modelFor(caps, role), rationale, evidence, fallback: "inline" };
  };
}
