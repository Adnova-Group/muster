// Kimi adapter + harness-neutral override shape.
//
// Pins docs/research/kimi-code-cli.md section 11's mapping and proves the neutral
// { tier, effort? } shape (model-policy.js) resolves correctly on BOTH the Kimi
// policy and a Codex-style policy from the SAME input -- the whole point of making
// per-agent overrides harness-neutral instead of naming concrete model strings.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  KIMI_MODEL_POLICY,
  kimiModelForTier,
  kimiModelForRole,
  kimiProfileForConfig,
} from "../src/kimi.js";
import { resolveNeutralProfile, assertNeutralProfile } from "../src/model-policy.js";

// A leaked MUSTER_MAX_TIER from the caller's shell would cap kimiModelForRole and
// silently break the role->tier assertions below. Clear it for this file (node
// --test isolates files in separate processes, so this never leaks outward).
delete process.env.MUSTER_MAX_TIER;

// --- Tier defaults: the section 11 table -----------------------------------

test("tier defaults resolve to the section-11 Kimi profiles", () => {
  assert.deepEqual(kimiModelForTier("haiku"), { model: "kimi-k2.6", thinking: "disabled" });
  assert.deepEqual(kimiModelForTier("sonnet"), { model: "kimi-k2.7-code", thinking: "enabled" });
  assert.deepEqual(kimiModelForTier("opus"), { model: "kimi-k3", effort: "high" });
  assert.deepEqual(kimiModelForTier("fable"), { model: "kimi-k3", effort: "max" });
});

test("unknown tier fails loud", () => {
  assert.throws(() => kimiModelForTier("luna-xhigh"), /unknown Muster model tier/);
});

// --- Semantic effort override on K3 tiers ----------------------------------

test("semantic effort overrides map onto K3's 3-rung ladder", () => {
  // workhorse and judgment both collapse to `high` (K3 has no `medium`); peak -> max.
  assert.deepEqual(kimiProfileForConfig({ tier: "opus", effort: "workhorse" }), { model: "kimi-k3", effort: "high" });
  assert.deepEqual(kimiProfileForConfig({ tier: "opus", effort: "judgment" }), { model: "kimi-k3", effort: "high" });
  assert.deepEqual(kimiProfileForConfig({ tier: "opus", effort: "peak" }), { model: "kimi-k3", effort: "max" });
});

test("effort override is a no-op on thinking-toggle tiers (no K3 effort knob)", () => {
  // sonnet=k2.7-code and haiku=k2.6 expose no reasoning dial -- the override is ignored.
  assert.deepEqual(kimiProfileForConfig({ tier: "sonnet", effort: "peak" }), { model: "kimi-k2.7-code", thinking: "enabled" });
  assert.deepEqual(kimiProfileForConfig({ tier: "haiku", effort: "judgment" }), { model: "kimi-k2.6", thinking: "disabled" });
});

test("no effort override returns the tier default unchanged", () => {
  assert.deepEqual(kimiProfileForConfig({ tier: "opus" }), { model: "kimi-k3", effort: "high" });
});

// --- Role resolution keeps model.js's Fable fallback + MUSTER_MAX_TIER ------

test("kimiModelForRole routes roles through the conceptual tiers", () => {
  const prev = process.env.MUSTER_ENABLE_FABLE;
  delete process.env.MUSTER_ENABLE_FABLE;
  try {
    // mechanical read-only roles -> haiku
    assert.deepEqual(kimiModelForRole("research"), { model: "kimi-k2.6", thinking: "disabled" });
    // default implementation roles -> sonnet
    assert.deepEqual(kimiModelForRole("code-review"), { model: "kimi-k2.7-code", thinking: "enabled" });
    // fable-set role with Fable DISABLED degrades to opus (kimi-k3/high)
    assert.deepEqual(kimiModelForRole("architecture-review"), { model: "kimi-k3", effort: "high" });
  } finally {
    if (prev === undefined) delete process.env.MUSTER_ENABLE_FABLE;
    else process.env.MUSTER_ENABLE_FABLE = prev;
  }
});

test("fable-set role with MUSTER_ENABLE_FABLE reaches the peak (kimi-k3/max)", () => {
  const prev = process.env.MUSTER_ENABLE_FABLE;
  process.env.MUSTER_ENABLE_FABLE = "1";
  try {
    assert.deepEqual(kimiModelForRole("architecture-review"), { model: "kimi-k3", effort: "max" });
    assert.deepEqual(kimiModelForRole("judge"), { model: "kimi-k3", effort: "max" });
  } finally {
    if (prev === undefined) delete process.env.MUSTER_ENABLE_FABLE;
    else process.env.MUSTER_ENABLE_FABLE = prev;
  }
});

// --- Neutral shape validation ----------------------------------------------

test("neutral profile validation fails loud on bad tier/effort", () => {
  assert.throws(() => assertNeutralProfile({ tier: "sol" }), /unknown neutral tier/);
  assert.throws(() => assertNeutralProfile({ tier: "opus", effort: "xhigh" }), /unknown neutral effort/);
  assert.throws(() => assertNeutralProfile({ tier: "opus", effort: "medium" }), /unknown neutral effort/);
  // "medium"/"xhigh" are harness effort strings, NOT neutral efforts -- that is the point.
});

test("resolveNeutralProfile fails loud on a malformed harness policy", () => {
  assert.throws(() => resolveNeutralProfile({ tier: "opus" }, null), /must be an object with/);
  assert.throws(() => resolveNeutralProfile({ tier: "opus" }, { tiers: {} }), /must be an object with/); // no applyEffort
  assert.throws(() => resolveNeutralProfile({ tier: "opus" }, { applyEffort() {} }), /must be an object with/); // no tiers
});

// --- Harness neutrality: ONE neutral input, two harness policies ------------

// A Codex-style policy mirroring src/codex.js's CODEX_MODEL_POLICY numbers, built
// here so this test proves the shape is shared without importing/mutating codex.js.
const CODEX_STYLE_POLICY = {
  tiers: {
    haiku: { model: "gpt-5.6-terra", reasoning: "high" },
    sonnet: { model: "gpt-5.6-luna", reasoning: "xhigh" },
    opus: { model: "gpt-5.6-sol", reasoning: "high" },
    fable: { model: "gpt-5.6-sol", reasoning: "high" },
  },
  applyEffort(base, semantic) {
    const map = { workhorse: "medium", judgment: "high", peak: "xhigh" };
    return { ...base, reasoning: map[semantic] ?? base.reasoning };
  },
};

test("the same neutral { tier, effort } resolves on both Kimi and Codex", () => {
  const builder = { tier: "opus", effort: "workhorse" }; // muster-builder / muster-runner
  assert.deepEqual(resolveNeutralProfile(builder, KIMI_MODEL_POLICY), { model: "kimi-k3", effort: "high" });
  assert.deepEqual(resolveNeutralProfile(builder, CODEX_STYLE_POLICY), { model: "gpt-5.6-sol", reasoning: "medium" });
});

// The three real manifest override intents, re-expressed neutrally, preserve the
// current Codex output AND newly resolve on Kimi -- the migration is lossless.
test("real manifest overrides survive the neutral rewrite (Codex output preserved)", () => {
  const cases = [
    // agent, neutral profile, expected Codex, expected Kimi
    ["muster-builder", { tier: "opus", effort: "workhorse" }, { model: "gpt-5.6-sol", reasoning: "medium" }, { model: "kimi-k3", effort: "high" }],
    ["muster-reviewer", { tier: "opus", effort: "judgment" }, { model: "gpt-5.6-sol", reasoning: "high" }, { model: "kimi-k3", effort: "high" }],
    ["wsh-security-auditor", { tier: "opus", effort: "peak" }, { model: "gpt-5.6-sol", reasoning: "xhigh" }, { model: "kimi-k3", effort: "max" }],
    // luna-xhigh collapses to plain sonnet: Codex's sonnet policy IS luna/xhigh.
    ["muster-surgeon", { tier: "sonnet" }, { model: "gpt-5.6-luna", reasoning: "xhigh" }, { model: "kimi-k2.7-code", thinking: "enabled" }],
    ["muster-investigator", { tier: "haiku" }, { model: "gpt-5.6-terra", reasoning: "high" }, { model: "kimi-k2.6", thinking: "disabled" }],
  ];
  for (const [agent, neutral, expectedCodex, expectedKimi] of cases) {
    assert.deepEqual(resolveNeutralProfile(neutral, CODEX_STYLE_POLICY), expectedCodex, `${agent} on Codex`);
    assert.deepEqual(resolveNeutralProfile(neutral, KIMI_MODEL_POLICY), expectedKimi, `${agent} on Kimi`);
  }
});
