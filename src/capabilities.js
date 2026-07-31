import { homedir } from "node:os";
import { modelForRole } from "./model.js";
import { claudeModelForTier, claudeProfileForAgentId } from "./claude.js";
import { ROLES } from "./roles.js";
import { isInstalled } from "./installed.js";
import { installedSkillDescription } from "./plugin-inventory.js";
import { codexProfileForAgentId } from "./codex.js";
import { kimiProfileForAgentId } from "./kimi.js";

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
export function resolveCapabilities(catalog, installed, home = homedir(), opts = {}) {
  // --codex lane only (opts.codex). Each role additionally carries the EXACT
  // Codex profile its chosen agent dispatches on — codexModel: {model, effort},
  // single-sourced from the same manifest-override resolution the committed
  // .codex/agents/<id>.toml pins use (codexProfileForAgentId). A Codex driver
  // reads the resolved gpt-5.6 model + reasoning effort pre-dispatch, without
  // the post-run codex-conformance audit. Non-codex output shape is unchanged.
  const codex = opts.codex === true;
  // --kimi lane (opts.kimi): the Kimi sibling of the codex lane. Each agent-backed
  // role additionally carries kimiModel: {model, effort|thinking} -- the exact Kimi
  // Code alias + effort it dispatches on, resolved from the SAME neutral manifest
  // (kimiProfileForAgentId). Non-kimi output shape is unchanged.
  const kimi = opts.kimi === true;
  const agentPlugins = opts.agentPlugins === true
    || installed.runtime === "agent-plugins"
    || process.env.MUSTER_RUNTIME === "agent-plugins";
  const agentPluginSkills = new Set(installed.skills || []);
  const agentPluginMcpServers = new Set(installed.mcpServers || []);
  // Cowork has no agent or skill loader by default: its host can invoke
  // registered MCP servers and can always execute a task inline, but a Claude
  // Code plugin merely being present on disk does not make that plugin's
  // agents/skills callable from Cowork -- UNLESS Cowork's own plugin loader
  // (shipped ~May 2026, bundling skills/hooks/subagents in the Claude Code
  // plugin format -- docs/research/claude-cowork.md section 3d) actually
  // loaded muster's plugin/ tree natively. That load is UNVERIFIED without a
  // live Cowork session, so it rides in as a DECLARED signal
  // (installed.nativePluginRide -- see readInstalledCowork's
  // MUSTER_COWORK_NATIVE_PLUGIN / opts.nativePluginRide), never an
  // auto-probe: false (the default) keeps today's MCP-only filtering; true
  // resolves agent/skill providers exactly as this function does for
  // Claude Code (the non-cowork path below), since a native load, if real,
  // loaded this same checkout's plugin/ tree. The MCP wrapper also exports
  // MUSTER_RUNTIME=cowork for nested CLI commands (notably `audit`) whose
  // installed inventory is resolved inside the child process.
  const cowork = installed.runtime === "cowork" || process.env.MUSTER_RUNTIME === "cowork";
  const coworkMcpOnly = cowork && !installed.nativePluginRide;
  // Work has no native agent/skill dispatch lane. Its deterministic MCP
  // inventory is supplied by readInstalledWork; even if a caller passes a
  // contaminated inventory, fail closed to installed MCP entries + inline.
  const work = installed.runtime === "work" || process.env.MUSTER_RUNTIME === "work";
  const mcpOnly = coworkMcpOnly || work;
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
      if (agentPlugins && entry) {
        const portable = entry.kind === "skill"
          ? agentPluginSkills.has(entry.id)
          : entry.kind === "mcp"
            ? agentPluginMcpServers.has(entry.id)
            : false;
        if (!portable) entry = null;
      }
      if (mcpOnly && entry?.kind !== "mcp") entry = null;
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
      if (e.kind === "external" && e.recommended && !isInstalled(e, installed) && e.rank > chosenRank
          && !work && (!coworkMcpOnly || providerType(e) === "mcp")) {
        recommendations.push(`install ${e.id} for ${role} — better than the ${chosen.id} fallback`);
      }
    }
    const model = modelForRole(role);
    // `model` is the CONCEPTUAL tier (scout|core|prime|apex), emitted on every
    // lane. `claudeModel`/`claudeProfile` are the CLAUDE adapter's concrete
    // dispatch values, so they ride only the lanes whose host actually
    // dispatches Claude models: the default lane and Cowork. Work has no Claude
    // model override at all, and a --codex/--kimi driver dispatches on its own
    // codexModel/kimiModel -- a Claude model sitting beside those is noise it
    // could act on (audit S3, P2: the guard here used to be `!work` alone, so
    // both Claude fields leaked into the codex and kimi lane output).
    roles[role] = { chosen, chain, recommendations, model };
    // claudeProfile: the Claude lane's sibling of the codex/kimi profile
    // emissions -- the SAME manifest-driven resolution (claudeProfileForAgentId),
    // carrying {model} plus the Workflow-lane `workflowEffort` when the chosen
    // agent's profile declares a semantic effort (src/claude.js). This is what
    // makes orchestrator SKILL.md's native Workflow dispatch ("effort = the
    // member's workflowEffort") read a field that EXISTS in capabilities.json
    // instead of re-deriving it. Agent-backed roles only; the key is absent for
    // inline/skill/mcp chosen exactly as codexModel/kimiModel are, and
    // src/claude.js's lane scoping is honored: the field is a pre-dispatch
    // resolution surface, never agent frontmatter or an Agent-tool call.
    if (!work && !codex && !kimi && !agentPlugins) {
      const claudeProfile = chosen.kind === "agent" ? claudeProfileForAgentId(chosen.id) : null;
      // PRECEDENCE (audit S3, P1): when the chosen agent HAS a manifest profile,
      // that profile is the authoritative dispatch pin, so claudeModel IS
      // claudeProfile.model -- same principle as the Codex lane's committed
      // profile pins. Deriving claudeModel from the ROLE's tier while
      // claudeProfile came from the AGENT's manifest made the two contradict
      // each other on live roles (implement: sonnet beside a profile saying
      // opus), leaving a driver two different Claude models for one member. The
      // role-tier derivation survives only as the fallback for a role with no
      // agent-backed profile. Both paths pass through model.js's emission layer
      // (apex opt-in + MUSTER_MAX_TIER): modelForRole for the fallback,
      // emissionTier inside claudeProfileForConfig for the profile.
      roles[role].claudeModel = claudeProfile ? claudeProfile.model : claudeModelForTier(model).model;
      if (claudeProfile) roles[role].claudeProfile = claudeProfile;
    }
    if (codex && chosen.kind === "agent") {
      const codexModel = codexProfileForAgentId(chosen.id);
      if (codexModel) roles[role].codexModel = codexModel;
    }
    if (kimi && chosen.kind === "agent") {
      const kimiModel = kimiProfileForAgentId(chosen.id);
      if (kimiModel) roles[role].kimiModel = kimiModel;
    }
  }

  // Skills inventory: every currently-installed skill (name from
  // installed.skills, description parsed from its SKILL.md frontmatter) plus
  // every catalog builtin not already covered by an installed skill of the
  // same id — installed wins on a name collision, matching the roles ladder's
  // installed-beats-builtin precedence.
  const skills = [];
  if (mcpOnly) return { roles, installedRaw: installed, skills };
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
    if (agentPlugins && !agentPluginSkills.has(e.id)) continue;
    seen.add(e.id);
    skills.push({ id: e.id, source: "builtin", description: e.description || "" });
  }

  return { roles, installedRaw: installed, skills };
}
