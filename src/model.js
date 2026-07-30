// Pick the cheapest model tier that fits a role's work (quota-aware, atomic-style).
//
// Tiers are muster's OWN conceptual capability ladder — harness-neutral, like the
// semantic efforts (workhorse|judgment|peak in model-policy.js). Each harness
// adapter maps a tier to its concrete model: Claude (claude.js) → haiku/sonnet/
// opus/fable, Codex (codex.js) → gpt-5.6-terra/luna/sol, Kimi (kimi.js) →
// kimi-for-coding/k3. The ladder:
//   scout — cheap/mechanical recon: locating, gathering, read-only mapping.
//   core  — the bounded default: implementation, review, authoring, scoring.
//   prime — frontier judgment that gates other work.
//   apex  — rare peak above prime (tournament judge, architecture review) — the
//           only spots worth its 2x cost; degrades to prime by default.
//
// HISTORY: through 2026-07-26 the tiers were NAMED after Claude model families
// (haiku|sonnet|opus|fable) — the Claude adapter was an identity assumption
// rather than an adapter. The legacy names remain accepted EVERYWHERE tier input
// enters (manifests, MUSTER_MAX_TIER, adapter lookups) via LEGACY_TIER_ALIASES,
// and live on as the CLAUDE adapter's concrete values — a Claude word now, not a
// muster word, exactly like "gpt-5.6-terra" is a Codex word.
import { isTruthyFlag } from "./env-util.js";

const SCOUT = new Set(["code-navigation", "docs-research", "research"]);
// "judge" is an intentional conceptual role OUTSIDE the resolved ROLES enum
// (roles.js): the tournament skill (plugin/skills/tournament/SKILL.md) dispatches
// a judge agent to score candidates. "architecture-review" is a canonical ROLES
// member. "improve" is the retrospective self-improvement role (muster-improver):
// peak-judgment, runs rarely (post-run), edits to muster's own skills/rules are
// high-stakes — worth the top tier alongside architecture review.
// "advisor" is also an intentional conceptual role outside ROLES: dispatched by the
// advisor escalate-up pattern (muster_advise) for hard architectural decisions —
// peak-judgment like judge, intentionally out of the ROLES enum.
const APEX = new Set(["judge", "architecture-review", "improve", "advisor"]);

// Ascending capability order. prime is included because it is a valid dispatch
// tier via fallbackModelFor (apex degrades to prime) even though modelForRole
// never emits it directly. Declared before capTier/modelForRole to avoid TDZ.
export const MODEL_TIER_ORDER = ["scout", "core", "prime", "apex"];

// The pre-rename tier vocabulary, accepted for backward compatibility at every
// input boundary: existing Crew Manifests, agents.manifest.json entries authored
// against the old names, MUSTER_MAX_TIER values in user environments, and
// third-party callers. Normalization is one-way (legacy → canonical); nothing
// emits the legacy names except the Claude adapter, where they are concrete
// model values rather than tiers.
export const LEGACY_TIER_ALIASES = Object.freeze({
  haiku: "scout",
  sonnet: "core",
  opus: "prime",
  fable: "apex",
});

// Canonicalize a tier name: legacy aliases map to their canonical tier, canonical
// names pass through, anything unknown passes through unchanged (callers that
// validate do so against MODEL_TIER_ORDER after normalizing; fail-open callers
// like capTier just ignore unknowns).
export function normalizeTier(tier) {
  return LEGACY_TIER_ALIASES[tier] ?? tier;
}

// Caps a resolved tier to a maximum. Both the tier and the cap accept legacy
// names. If cap is a valid tier and tier sits strictly above it, returns cap
// (canonical); otherwise returns the (canonical) tier unchanged. An invalid or
// unset cap is a no-op (fail-open so a misconfigured env never breaks dispatch).
export function capTier(tier, cap = process.env.MUSTER_MAX_TIER) {
  const canonicalTier = normalizeTier(tier);
  if (!cap) return canonicalTier;
  const capIdx = MODEL_TIER_ORDER.indexOf(normalizeTier(cap));
  if (capIdx === -1) return canonicalTier; // invalid cap name — ignore
  const tierIdx = MODEL_TIER_ORDER.indexOf(canonicalTier);
  if (tierIdx === -1) return canonicalTier; // unknown tier — ignore
  return tierIdx > capIdx ? MODEL_TIER_ORDER[capIdx] : canonicalTier;
}

// The apex tier can be disabled platform-wide (Anthropic has done so for Fable,
// its Claude mapping), and a dispatch on a disabled tier is rejected — which
// historically choked the run because the only fallback was a prose instruction
// the orchestrator had to catch. So apex degrades to prime deterministically and
// BY DEFAULT, here at the emission layer: capabilities/crew/signals never emit
// apex, so the orchestrator never dispatches it. Opt back in with
// MUSTER_ENABLE_APEX (legacy env MUSTER_ENABLE_FABLE still honored) once the
// tier is available again.
function apexEnabled() {
  // Robust against MCPB boolean user_config, which substitutes as the string
  // "false"/"true": only "1"/"true"-ish values enable; "0"/"false"/"" do not
  // (isTruthyFlag in src/env-util.js -- shared with the --native-plugin ride's
  // parse in src/cli.js).
  return isTruthyFlag(process.env.MUSTER_ENABLE_APEX ?? process.env.MUSTER_ENABLE_FABLE);
}

// The emission layer in one function: a DECLARED tier (a role's tier, or an
// agent's tier from catalog/agents.manifest.json) → the tier that may actually
// be emitted for dispatch, after the apex opt-in check and MUSTER_MAX_TIER.
// modelForRole is this applied to a role's declared tier; the harness adapters
// apply it to a manifest-declared agent tier (see claudeProfileForConfig), so a
// per-agent override cannot smuggle a platform-disabled or over-cap tier into a
// dispatch pin that the role path would have degraded.
export function emissionTier(tier) {
  const canonical = normalizeTier(tier);
  return capTier(canonical === "apex" && !apexEnabled() ? fallbackModelFor("apex") : canonical);
}

export function modelForRole(role) {
  if (SCOUT.has(role)) return emissionTier("scout");
  if (APEX.has(role)) return emissionTier("apex");
  return emissionTier("core");
}

// Apex degrades per this map — never fail the task over a model tier, and never
// silently inherit the orchestrator's model. Tiers without an entry are their own
// fallback. Wired into modelForRole (above) and used by the orchestrator's
// dispatch-retry path when an opted-in apex dispatch is still rejected.
const FALLBACK = { apex: "prime" };

export function fallbackModelFor(model) {
  const canonical = normalizeTier(model);
  return FALLBACK[canonical] || canonical;
}

// Floors a resolved tier at core. An agent never pins below core — scout-tier
// (mechanical) roles ride the orchestrator's override instead. Returns core if
// tier is undefined or below core in MODEL_TIER_ORDER.
const CORE_IDX = MODEL_TIER_ORDER.indexOf("core");
export function floorAtCore(tier) {
  if (tier === undefined) return MODEL_TIER_ORDER[CORE_IDX];
  const canonical = normalizeTier(tier);
  return MODEL_TIER_ORDER.indexOf(canonical) >= CORE_IDX ? canonical : MODEL_TIER_ORDER[CORE_IDX];
}

// Returns the highest-capability tier from a list of tier names (legacy names
// accepted), according to MODEL_TIER_ORDER. Unknown names are silently ignored.
// Returns undefined when the list is empty or contains no known tiers.
export function maxTier(models) {
  let best = -1;
  for (const m of models) {
    const idx = MODEL_TIER_ORDER.indexOf(normalizeTier(m));
    if (idx > best) best = idx;
  }
  return best === -1 ? undefined : MODEL_TIER_ORDER[best];
}
