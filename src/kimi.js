import { readFileSync } from "node:fs";
import { modelForRole } from "./model.js";
import { resolveNeutralProfile } from "./model-policy.js";

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
// - haiku  = kimi-for-coding-highspeed: the FAST variant for read-only
//   locate/gather. On the managed coding plan there is no CHEAPER model (the
//   research's k2.6 locator lane does not exist here), only this faster one --
//   same price/params as kimi-for-coding, ~2x throughput, always-thinking (no way
//   to disable on this plan). If a live model-probe at install time finds a
//   cheaper general alias (k2.6/k2.5), remap haiku to it then.
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
  haiku: Object.freeze({ model: "kimi-code/kimi-for-coding-highspeed", thinking: "enabled" }),
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

// Lazy + cached read of the shared harness-neutral agent manifest -- the SAME
// codex/agents.manifest.json codex.js reads. Its { tier, effort? } entries carry
// no concrete model strings, so both adapters consume one file (the payoff of the
// neutral-shape migration). Read via fs (not a JSON import) to stay off Node's
// experimental-JSON-modules warning, mirroring codex.js's codexAgentProfiles.
// NOTE: Phase D of the Kimi leg moves this to a harness-neutral path + a shared
// reader; until then kimi reads the codex-namespaced path directly.
let agentProfilesCache;
function kimiAgentProfiles() {
  if (!agentProfilesCache) {
    const raw = readFileSync(new URL("../codex/agents.manifest.json", import.meta.url), "utf8");
    agentProfilesCache = Object.freeze(JSON.parse(raw).agents);
  }
  return agentProfilesCache;
}

// Resolve an agent id (a `capabilities --kimi` chosen.id == a manifest agent key)
// to its concrete Kimi profile {model, effort|thinking}. Returns null for a
// non-agent provider (skill/mcp/inline) with no manifest entry. Mirrors
// codexProfileForAgentId -- the Kimi driver reads the resolved model pre-dispatch.
export function kimiProfileForAgentId(id) {
  const config = kimiAgentProfiles()[id];
  return config ? kimiProfileForConfig(config) : null;
}
