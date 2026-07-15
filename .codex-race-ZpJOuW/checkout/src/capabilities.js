import { homedir } from "node:os";
import { modelForRole } from "./model.js";
import { ROLES } from "./roles.js";
import { isInstalled } from "./installed.js";
import { installedSkillDescription } from "./plugin-inventory.js";

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

// `home` is a 3rd, optional parameter (defaulting to the real home dir) so
// cli.js's existing 2-arg call sites (frozen, un-awaited) are unaffected,
// while tests can pin it to a fixture dir for deterministic installed-skill
// description lookups. See plugin-inventory.js's installedSkillDescription.
export function resolveCapabilities(catalog, installed, home = homedir()) {
  const roles = {};
  for (const role of ROLES) {
    const forRole = catalog.filter(e => e.roles.includes(role)).sort((a, b) => b.rank - a.rank);
    const chain = [];
    let chosen = null;
    let chosenRank = 0; // inline default: 0
    for (const e of forRole) {
      let entry = null;
      if (e.kind === "external" && isInstalled(e, installed)) {
        entry = { id: e.id, source: "installed", kind: providerType(e) };
      } else if (e.kind === "builtin" || e.kind === "agent") {
        entry = { id: e.id, source: "builtin", kind: providerType(e) };
      }
      if (!entry) continue;
      chain.push(entry);
      if (!chosen) {
        chosen = entry;
        // first qualifying entry == chosen; capture its rank here (single pass).
        // ?? Infinity applies only when the installed entry's catalog rank is absent (undefined);
        // it ensures an installed provider cannot be displaced by any catalog-ranked recommendation.
        chosenRank = entry.source === "installed" ? (e.rank ?? Infinity) : (e.rank ?? 0);
      }
    }
    if (!chosen) chosen = { id: "inline", source: "inline", kind: "inline" };
    chain.push({ id: "inline", source: "inline", kind: "inline" });

    const recommendations = [];
    for (const e of forRole) {
      if (e.kind === "external" && e.recommended && !isInstalled(e, installed) && e.rank > chosenRank) {
        recommendations.push(`install ${e.id} for ${role} — better than the ${chosen.id} fallback`);
      }
    }
    roles[role] = { chosen, chain, recommendations, model: modelForRole(role) };
  }

  // Skills inventory: every currently-installed skill (name from
  // installed.skills, description parsed from its SKILL.md frontmatter) plus
  // every catalog builtin not already covered by an installed skill of the
  // same id — installed wins on a name collision, matching the roles ladder's
  // installed-beats-builtin precedence.
  const skills = [];
  const seen = new Set();
  // One shared cache for this call's whole installed-skills loop (see
  // installedSkillDescription / findSkillMdSync in plugin-inventory.js) —
  // every skill name shares the same plugins-tree walk instead of each
  // re-walking it from scratch. Call-scoped, not module-level state.
  const skillDescriptionCache = {};
  for (const name of new Set(installed.skills || [])) {
    seen.add(name);
    skills.push({ id: name, source: "installed", description: installedSkillDescription(home, name, skillDescriptionCache) });
  }
  for (const e of catalog) {
    if (e.kind !== "builtin" || seen.has(e.id)) continue;
    seen.add(e.id);
    skills.push({ id: e.id, source: "builtin", description: e.description || "" });
  }

  return { roles, installedRaw: installed, skills };
}
