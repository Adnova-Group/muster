import { modelForRole } from "./model.js";
import { resolveNeutralProfile } from "./model-policy.js";
import { agentProfiles } from "./agent-manifest.js";

// Kimi is an adapter target, not a second tier resolver -- same posture as codex.js.
// Keep the conceptual Claude-like tiers in model.js; translate only when emitting
// Kimi config. Evidence: docs/research/kimi-code-cli.md section 11 (2026-07-23,
// Moonshot platform docs + AA/DeepSWE/vendor benchmarks).
//
// Model ids are the Kimi Code config ALIASES a live install resolves (`kimi -m
// <alias>` / default_model), NOT raw platform API ids. Grounded in the actual
// managed Kimi Code plan (~/.kimi-code/config.toml, 2026-07-23): it serves three
// coding models -- kimi-code/k3, kimi-code/kimi-for-coding, and
// kimi-code/kimi-for-coding-highspeed -- and ALL THREE are always-thinking (the
// managed coding plan exposes no non-thinking or cheaper general model; k2.6/k2.5
// are Open-Platform general models on a different endpoint, not offered here).
//
// The two constraints Kimi imposes that Codex/Claude do not:
// - Reasoning EFFORT exists on K3 ONLY, and is 3 rungs: low | high | max (default
//   high on the managed plan). kimi-for-coding[-highspeed] expose NO effort field
//   -- always-thinking, no knob. So a semantic effort override only bites on the
//   two K3 tiers; on sonnet/haiku it is a documented no-op.
// - muster's medium/xhigh efforts are not native. Kimi's ladder collapses them
//   (medium -> high, xhigh -> max), so workhorse and judgment both land on high.
//
// Per-lane rationale (reconciled to what the managed plan actually installs):
// - haiku  = kimi-for-coding: the dedicated coding model, the SAME lane as sonnet.
//   The managed coding plan has no cheaper/general model (no k2.6/k2.5 -- the
//   research's cheap locator lane does not exist on this endpoint), so read-only
//   locate/gather rides the same model as the build workhorse. NEVER highspeed:
//   kimi-for-coding-highspeed is the IDENTICAL K2.7 model that merely burns ~3x
//   the plan usage to trade for latency -- pointing the "cheap" read-only lane at
//   a 3x-cost SKU of the same model would be exactly backwards, so muster never
//   spends quota there. haiku and sonnet therefore resolve identically on Kimi;
//   the tier split survives at model.js for routing/budget/degradation, mirroring
//   Codex's fable->opus collapse. Confirmed by a live GET /v1/models probe
//   (2026-07-24, HTTP 200): the plan serves EXACTLY {kimi-for-coding,
//   kimi-for-coding-highspeed, k3, k3-256k}, all supports_thinking_type "only" --
//   no cheaper family exists to remap to. `muster install kimi --probe` re-runs
//   that check (src/kimi-install.js probeKimiModels) and would flag a genuinely
//   cheaper alias IF the plan ever gains one.
// - sonnet = kimi-for-coding: the dedicated coding workhorse. Always-thinking.
// - opus   = k3, effort high: the judgment lane. K3 is frontier and holds quality
//   to 1M context (BrowseComp 90.4 @ 1M). high = the plan's default judgment effort.
// - fable  = k3, effort max: same model, max reserved to the rare peak only -- the
//   discipline Codex applies to xhigh. K3's effort knob gives a cleaner opus/fable
//   split than Codex (where both are sol/high).
//
// A tier entry carries EITHER `effort` (a K3 reasoning level) OR `thinking` (the
// always-on toggle for the effort-less coding models).
const KIMI_TIERS = Object.freeze({
  haiku: Object.freeze({ model: "kimi-code/kimi-for-coding", thinking: "enabled" }),
  sonnet: Object.freeze({ model: "kimi-code/kimi-for-coding", thinking: "enabled" }),
  opus: Object.freeze({ model: "kimi-code/k3", effort: "high" }),
  fable: Object.freeze({ model: "kimi-code/k3", effort: "max" }),
});

// Semantic effort -> Kimi K3 reasoning level. K3's native ladder is 3 rungs, so
// workhorse and judgment both resolve to `high` (K3 has no `medium`) and peak to
// `max` -- the same aliasing Kimi Code applies to third-party effort inputs.
const KIMI_EFFORT = Object.freeze({
  workhorse: "high",
  judgment: "high",
  peak: "max",
});

export const KIMI_MODEL_POLICY = Object.freeze({
  tiers: KIMI_TIERS,
  // A semantic effort override only applies where the resolved model exposes an
  // effort knob (K3). On an always-thinking model (kimi-for-coding[-highspeed])
  // it is intentionally a no-op: Kimi gives no way to dial reasoning there.
  applyEffort(base, semantic) {
    if (!("effort" in base)) return base;
    return { ...base, effort: KIMI_EFFORT[semantic] ?? base.effort };
  },
});

export function kimiModelForTier(tier) {
  const resolved = KIMI_MODEL_POLICY.tiers[tier];
  if (!resolved) throw new Error(`unknown Muster model tier: ${tier}`);
  return { ...resolved };
}

// --- The two-lane dispatch bind (model_preference) ---------------------------
//
// Kimi DOES support a per-agent model selector -- it is just not Claude Code's
// `model:` field (which Kimi explicitly ignores). An agent file carries
// `model_preference: primary | secondary`, where (docs, customization/agents):
// "`primary` selects the caller's main model, while `secondary` selects
// `[secondary_model] model`". `[secondary_model]` is "a second model pointer
// next to the primary `default_model`" in config.toml, carrying its own `model`
// and `default_effort`.
//
// So Kimi gives TWO models per launch, selectable per agent -- not the "one
// model per launch" the earlier research recorded. muster's four conceptual
// tiers fold onto those two lanes along the family line KIMI_TIERS already
// draws: the K3 judgment family and the K2.7 Coding execution family.
//
//   primary   = kimi-code/k3               <- opus + fable
//   secondary = kimi-code/kimi-for-coding  <- haiku + sonnet
//
// fable collapses into opus's lane (both k3, but effort is per-launch, not
// per-agent) -- the SAME degradation Codex already accepts, where fable and opus
// are both sol/high. Nothing new is lost.
//
// Two constraints on using this (both are the caller's job, not this map's):
//  1. It is EXPERIMENTAL and off by default -- `KIMI_CODE_EXPERIMENTAL_SECONDARY_MODEL=1`
//     under `kimi web`, or `KIMI_CODE_EXPERIMENTAL_FLAG=1` under `kimi -p`.
//     The interactive TUI "currently ignores this field".
//  2. The mapping is only CORRECT if config.toml's default_model/[secondary_model]
//     match KIMI_LANES below -- muster emits that block for the user rather than
//     mutating a shared config itself (see src/kimi-install.js).
//
// Omitting the field is NOT neutral: per the docs, when a secondary model is
// configured and an agent omits model_preference, "the configured secondary
// model remains the default" -- i.e. every un-annotated agent silently binds to
// the CHEAP lane, judgment agents included. That is precisely why the install
// stamps this field on every agent instead of copying files through untouched.
export const KIMI_LANES = Object.freeze({
  primary: "kimi-code/k3",
  secondary: "kimi-code/kimi-for-coding"
});

// Derived from KIMI_TIERS (never a parallel hand-maintained table): a tier's
// lane is whichever KIMI_LANES entry names the same model its tier resolves to.
// A tier whose model matches no lane fails loud rather than guessing a lane.
export function kimiModelPreferenceForTier(tier) {
  const { model } = kimiModelForTier(tier);
  const lane = Object.keys(KIMI_LANES).find(name => KIMI_LANES[name] === model);
  if (!lane) throw new Error(`Kimi tier ${tier} resolves to ${model}, which is not a configured lane`);
  return lane;
}

// Resolve an agent id (a manifest key) to its Kimi lane. Returns null for an id
// with no manifest entry -- the caller decides whether that is a skip or a fault.
export function kimiPreferenceForAgentId(id) {
  const config = agentProfiles()[id];
  return config ? kimiModelPreferenceForTier(config.tier) : null;
}

// --- The runtime lane bind (single source of truth) --------------------------
//
// The stamped model_preference lanes engage only when the secondary-model
// experiment is on for the PROCESS (docs/research/kimi-code-cli.md section 11.8):
//   KIMI_CODE_EXPERIMENTAL_FLAG=1   selects the v2 engine under `kimi -p`,
//                                   which is what makes model_preference bite
//   KIMI_SECONDARY_MODEL=<alias>    points the secondary lane at a model
// Both are per-process, so binding this way mutates nothing in the user's
// shared config.toml and leaves interactive sessions untouched (the TUI ignores
// model_preference anyway -- lanes bind under `kimi -p` / `kimi web` only).
//
// Both values are DERIVED here from the tier map, never re-stated by callers:
// the lane models are whatever the judgment (opus) and execution (sonnet)
// families resolve to, checked against KIMI_LANES so a hand edit that drifts
// the two apart fails loud instead of silently binding the wrong lane. Every
// Kimi spawn path shares this one derivation -- kimiGoalInvocation
// (src/kimi-dispatch.js) for the live `kimi -p` run loop, the install report
// (src/kimi-install.js), and `muster doctor` (src/doctor.js).
export function kimiLaneBinding() {
  const primary = kimiModelForTier("opus").model;    // the K3 judgment family
  const secondary = kimiModelForTier("sonnet").model; // the K2.7 Coding execution family
  if (KIMI_LANES.primary !== primary || KIMI_LANES.secondary !== secondary) {
    throw new Error(`KIMI_LANES drifted from KIMI_TIERS: lanes name ${KIMI_LANES.primary} / ${KIMI_LANES.secondary}, but the tiers resolve ${primary} / ${secondary}`);
  }
  const tiers = {};
  for (const tier of Object.keys(KIMI_TIERS)) tiers[tier] = kimiModelPreferenceForTier(tier);
  return {
    lanes: { primary, secondary },
    tiers,
    env: {
      KIMI_CODE_EXPERIMENTAL_FLAG: "1",
      KIMI_SECONDARY_MODEL: secondary
    }
  };
}

// Just the env pair, for spawn sites that need nothing else. Returns a fresh
// object each call -- a caller mutating it must not corrupt the next spawn.
export function kimiLaneEnv() {
  return { ...kimiLaneBinding().env };
}

// Adapter boundary for callers that resolve a role at runtime. modelForRole keeps
// MUSTER_MAX_TIER and Fable's deterministic fallback (fable -> opus when Fable is
// disabled), so a fable-set role with Fable off resolves to the opus (k3/high)
// profile, and with MUSTER_ENABLE_FABLE to the fable (k3/max) profile.
export function kimiModelForRole(role) {
  return kimiModelForTier(modelForRole(role));
}

// SINGLE SOURCE for the concrete Kimi profile a HARNESS-NEUTRAL agent config
// resolves to. Consumes { tier, effort? } (model-policy.js) -- no concrete model
// strings -- so the same manifest entry resolves on Codex, Kimi, and Claude alike.
// Mirrors codexProfileForConfig's role in the Codex adapter.
export function kimiProfileForConfig(config) {
  return resolveNeutralProfile(config, KIMI_MODEL_POLICY);
}

// Resolve an agent id (a `capabilities --kimi` chosen.id == a manifest agent key)
// to its concrete Kimi profile {model, effort|thinking}, from the SHARED
// harness-neutral manifest (agent-manifest.js reads catalog/agents.manifest.json
// -- the SAME file codex.js resolves). Returns null for a non-agent provider
// (skill/mcp/inline) with no manifest entry. Mirrors codexProfileForAgentId.
export function kimiProfileForAgentId(id) {
  const config = agentProfiles()[id];
  return config ? kimiProfileForConfig(config) : null;
}
