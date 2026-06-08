import { modelForRole } from "./model.js";
import { ROLES } from "./roles.js";
import { isInstalled } from "./installed.js";

// Dispatch type for a resolved provider: "agent" | "mcp" | "skill".
function providerType(entry) {
  if (entry.kind === "agent") return "agent";
  if (entry.kind === "builtin") return "skill";
  // external: derive from the detect hint.
  const dk = entry.detect?.kind;
  if (dk === "agent") return "agent";
  if (dk === "mcp_server") return "mcp";
  return "skill";
}

export function resolveCapabilities(catalog, installed) {
  const roles = {};
  for (const role of ROLES) {
    const forRole = catalog.filter(e => e.roles.includes(role)).sort((a, b) => b.rank - a.rank);
    const chain = [];
    let chosen = null;
    for (const e of forRole) {
      if (e.kind === "external" && isInstalled(e, installed)) {
        chain.push({ id: e.id, source: "installed", kind: providerType(e) });
        if (!chosen) chosen = { id: e.id, source: "installed", kind: providerType(e) };
      } else if (e.kind === "builtin" || e.kind === "agent") {
        chain.push({ id: e.id, source: "builtin", kind: providerType(e) });
        if (!chosen) chosen = { id: e.id, source: "builtin", kind: providerType(e) };
      }
    }
    if (!chosen) chosen = { id: "inline", source: "inline", kind: "inline" };
    chain.push({ id: "inline", source: "inline", kind: "inline" });

    const chosenRank = chosen.source === "installed"
      ? (forRole.find(e => e.id === chosen.id)?.rank ?? Infinity)
      : (chosen.source === "builtin" ? (forRole.find(e => e.id === chosen.id)?.rank ?? 0) : 0);
    const recommendations = [];
    for (const e of forRole) {
      if (e.kind === "external" && e.recommended && !isInstalled(e, installed) && e.rank > chosenRank) {
        recommendations.push(`install ${e.id} for ${role} — better than the ${chosen.id} fallback`);
      }
    }
    roles[role] = { chosen, chain, recommendations, model: modelForRole(role) };
  }
  return { roles, installedRaw: installed };
}
