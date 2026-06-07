const ROLES = [
  "code-navigation", "docs-research", "brainstorm", "plan", "implement",
  "code-review", "security-review", "test-author", "refactor", "frontend", "tech-debt"
];

function isInstalled(entry, installed) {
  if (entry.kind !== "external" || !entry.detect) return false;
  const { kind, match } = entry.detect;
  if (kind === "plugin") return installed.plugins.includes(match);
  if (kind === "skill") return installed.skills.includes(match);
  if (kind === "mcp_server") return installed.mcpServers.includes(match);
  return false;
}

export function resolveCapabilities(catalog, installed) {
  const roles = {};
  for (const role of ROLES) {
    const forRole = catalog.filter(e => e.roles.includes(role)).sort((a, b) => b.rank - a.rank);
    const chain = [];
    let chosen = null;
    for (const e of forRole) {
      if (e.kind === "external" && isInstalled(e, installed)) {
        chain.push({ id: e.id, source: "installed" });
        if (!chosen) chosen = { id: e.id, source: "installed" };
      } else if (e.kind === "builtin") {
        chain.push({ id: e.id, source: "builtin" });
        if (!chosen) chosen = { id: e.id, source: "builtin" };
      }
    }
    if (!chosen) chosen = { id: "inline", source: "inline" };
    chain.push({ id: "inline", source: "inline" });

    const chosenRank = chosen.source === "installed"
      ? (forRole.find(e => e.id === chosen.id)?.rank ?? Infinity)
      : (chosen.source === "builtin" ? (forRole.find(e => e.id === chosen.id)?.rank ?? 0) : 0);
    const recommendations = [];
    for (const e of forRole) {
      if (e.kind === "external" && e.recommended && !isInstalled(e, installed) && e.rank > chosenRank) {
        recommendations.push(`install ${e.id} for ${role} — better than the ${chosen.id} fallback`);
      }
    }
    roles[role] = { chosen, chain, recommendations };
  }
  return { roles, installedRaw: installed };
}
