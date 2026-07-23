import { modelForRole } from "./model.js";
import { resolveNeutralProfile } from "./model-policy.js";

// Kimi is an adapter target, not a second tier resolver -- same posture as codex.js.
// Keep the conceptual Claude-like tiers in model.js; translate only when emitting
// Kimi config. Evidence: docs/research/kimi-code-cli.md section 11 (2026-07-23,
// Moonshot platform docs + AA/DeepSWE/vendor benchmarks).
//
// The two constraints Kimi imposes that Codex/Claude do not:
// - Reasoning EFFORT exists on K3 ONLY, and is 3 rungs: low | high | max (K3 is
//   always-thinking; API default max, Kimi Code default high). K2.7-Code and K2.6
//   expose NO effort field -- thinking is binary (K2.7-Code always-on; K2.6
//   toggleable). So a semantic effort override only bites on the two K3 tiers; on
//   sonnet/haiku it is a documented no-op.
// - muster's medium/xhigh efforts are not native. Kimi's own ladder collapses them
//   (medium -> high, xhigh -> max), so workhorse and judgment both land on high.
//
// Per-lane rationale:
// - haiku  = kimi-k2.6, thinking off: cheap read-only locator/research on the
//   general model Moonshot recommends for non-coding, deliberately a different
//   family than the coding builders (mirrors Codex's terra locator lane). K2.5 is
//   cheaper but sunsets 2026-08-31, so it is not a build target.
// - sonnet = kimi-k2.7-code, thinking on: the dedicated coding workhorse (beats
//   k2.6 +11..31% on every coding+agentic benchmark, ~1/3 K3's price, faster).
//   No effort knob -- always-thinking.
// - opus   = kimi-k3, effort high: the judgment lane. K3 is frontier and the only
//   Kimi model that holds quality to 1M context (BrowseComp 90.4 @ 1M), required
//   for judgment over large diffs. high = Kimi Code's own default judgment effort.
// - fable  = kimi-k3, effort max: same model, max reserved to the rare peak only --
//   the exact discipline Codex applies to xhigh. K3's effort knob gives a cleaner
//   opus/fable split than Codex (where both are sol/high).
//
// A tier entry carries EITHER `effort` (a K3 reasoning level) OR `thinking` (the
// on/off toggle for the effort-less models). Model ids are the platform API ids
// (kimi-k3, kimi-k2.7-code, kimi-k2.6); in a Kimi Code config they are referenced
// through [models.<alias>] entries (k3, kimi-for-coding, ...).
const KIMI_TIERS = Object.freeze({
  haiku: Object.freeze({ model: "kimi-k2.6", thinking: "disabled" }),
  sonnet: Object.freeze({ model: "kimi-k2.7-code", thinking: "enabled" }),
  opus: Object.freeze({ model: "kimi-k3", effort: "high" }),
  fable: Object.freeze({ model: "kimi-k3", effort: "max" }),
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
  // effort knob (K3). On a `thinking`-toggle model (k2.7-code/k2.6) it is
  // intentionally a no-op: Kimi gives no way to dial reasoning there.
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
// disabled), so a fable-set role with Fable off resolves to the opus (kimi-k3/high)
// profile, and with MUSTER_ENABLE_FABLE to the fable (kimi-k3/max) profile.
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
