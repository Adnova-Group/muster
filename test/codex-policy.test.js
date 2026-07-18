// Split from the former test/codex.test.js monolith: Codex model-tiering
// policy (CODEX_MODEL_POLICY, per-role/per-tier resolution, sandbox and
// xhigh-reservation invariants).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { CODEX_COUNTS, CODEX_MODEL_POLICY, codexModelForRole, codexModelForTier } from "../src/codex.js";
import { repoRoot, selectedPlugin } from "../test-support/codex-helpers.js";

test("Codex policy preserves the conceptual Fable fallback without routine max effort", () => {
  assert.deepEqual(CODEX_MODEL_POLICY, {
    // 2026-07-18 retier: haiku (read-only locator lane) rides terra/high --
    // long-context safe, +9.6pts over luna/high for +$0.35/task.
    haiku: { model: "gpt-5.6-terra", reasoning: "high" },
    sonnet: { model: "gpt-5.6-luna", reasoning: "xhigh" },
    opus: { model: "gpt-5.6-sol", reasoning: "high" },
    fable: { model: "gpt-5.6-sol", reasoning: "high" },
    "luna-xhigh": { model: "gpt-5.6-luna", reasoning: "xhigh" }
  });
  assert.deepEqual(codexModelForTier("haiku"), CODEX_MODEL_POLICY.haiku);
  assert.deepEqual(codexModelForTier("fable"), codexModelForTier("opus"), "Fable adapts to the user's Sol/high preference");
  assert.ok(Object.values(CODEX_MODEL_POLICY).every(policy => policy.reasoning !== "max"), "no conceptual default uses max effort");
  assert.throws(() => codexModelForTier("unknown"), /unknown Muster model tier/);
});
test("Codex role profiles use the evidence-backed lanes and preserve sandbox policy", async () => {
  const mapping = JSON.parse(await readFile(join(repoRoot, "codex", "agents.manifest.json"), "utf8"));
  // 2026-07-18 evidence-receipted retier (DeepSWE v1.1 + sol effort research;
  // per-role rationale in the codex-tier-remap-receipts PR): investigator ->
  // terra/high (long-context-safe locator); security -> sol/xhigh (the one
  // rational xhigh lane); docs-architect -> sol/medium (long-form human-read);
  // test-automator + content quartet -> luna/xhigh budget lane (bounded work,
  // separate luna quota allowance, model diversity on verifier-adjacent work).
  const expected = {
    "muster-investigator": { tier: "haiku", model: "gpt-5.6-terra", reasoning: "high", readOnly: true },
    "muster-surgeon": { tier: "luna-xhigh", model: "gpt-5.6-luna", reasoning: "xhigh", readOnly: false },
    "wsh-api-documenter": { tier: "luna-xhigh", model: "gpt-5.6-luna", reasoning: "xhigh", readOnly: false },
    "wsh-tutorial-engineer": { tier: "luna-xhigh", model: "gpt-5.6-luna", reasoning: "xhigh", readOnly: false },
    "wsh-test-automator": { tier: "luna-xhigh", model: "gpt-5.6-luna", reasoning: "xhigh", readOnly: false },
    "muster-reviewer": { tier: "sonnet", model: "gpt-5.6-sol", reasoning: "high", readOnly: true },
    "wsh-code-reviewer": { tier: "sonnet", model: "gpt-5.6-sol", reasoning: "high", readOnly: true },
    "wsh-business-analyst": { tier: "sonnet", model: "gpt-5.6-luna", reasoning: "xhigh", readOnly: false },
    "wsh-content-marketer": { tier: "sonnet", model: "gpt-5.6-luna", reasoning: "xhigh", readOnly: false },
    "wsh-customer-support": { tier: "sonnet", model: "gpt-5.6-luna", reasoning: "xhigh", readOnly: false },
    "wsh-data-scientist": { tier: "sonnet", model: "gpt-5.6-luna", reasoning: "xhigh", readOnly: false },
    "muster-builder": { tier: "opus", model: "gpt-5.6-sol", reasoning: "medium", readOnly: false },
    "muster-runner": { tier: "opus", model: "gpt-5.6-sol", reasoning: "medium", readOnly: false },
    "wsh-debugger": { tier: "opus", model: "gpt-5.6-sol", reasoning: "medium", readOnly: false },
    "wsh-devops-troubleshooter": { tier: "opus", model: "gpt-5.6-sol", reasoning: "medium", readOnly: false },
    "wsh-frontend-developer": { tier: "opus", model: "gpt-5.6-sol", reasoning: "medium", readOnly: false },
    "wsh-legacy-modernizer": { tier: "opus", model: "gpt-5.6-sol", reasoning: "medium", readOnly: false },
    "wsh-data-engineer": { tier: "opus", model: "gpt-5.6-sol", reasoning: "medium", readOnly: false },
    "wsh-database-optimizer": { tier: "opus", model: "gpt-5.6-sol", reasoning: "medium", readOnly: false },
    "wsh-ml-engineer": { tier: "opus", model: "gpt-5.6-sol", reasoning: "medium", readOnly: false },
    "wsh-prompt-engineer": { tier: "opus", model: "gpt-5.6-sol", reasoning: "medium", readOnly: false },
    "wsh-docs-architect": { tier: "opus", model: "gpt-5.6-sol", reasoning: "medium", readOnly: false },
    "muster-improver": { tier: "fable", model: "gpt-5.6-sol", reasoning: "high", readOnly: true },
    "muster-strategist": { tier: "fable", model: "gpt-5.6-sol", reasoning: "high", readOnly: true },
    "wsh-backend-architect": { tier: "opus", model: "gpt-5.6-sol", reasoning: "high", readOnly: false },
    "wsh-cloud-architect": { tier: "opus", model: "gpt-5.6-sol", reasoning: "high", readOnly: false },
    "wsh-security-auditor": { tier: "opus", model: "gpt-5.6-sol", reasoning: "xhigh", readOnly: true }
  };
  assert.equal(Object.keys(mapping.agents).length, Object.keys(expected).length, "all 27 Codex roles are classified");
  for (const [id, policy] of Object.entries(expected)) {
    const config = mapping.agents[id];
    assert.equal(config.tier, policy.tier, `${id} must retain its model tier`);
    assert.equal(config.reasoning ?? CODEX_MODEL_POLICY[config.tier].reasoning, policy.reasoning, `${id} reasoning policy`);
    assert.equal(config.model ?? CODEX_MODEL_POLICY[config.tier].model, policy.model, `${id} model policy`);
    assert.equal(Boolean(config.readOnly), policy.readOnly, `${id} read-only policy`);
    const profile = await readFile(join(selectedPlugin.profilesRoot, `${id}.toml`), "utf8");
    assert.match(profile, new RegExp(`model = ${JSON.stringify(policy.model)}`), `${id} model`);
    assert.match(profile, new RegExp(`model_reasoning_effort = ${JSON.stringify(policy.reasoning)}`), `${id} reasoning`);
    assert.match(profile, new RegExp(`sandbox_mode = ${JSON.stringify(policy.readOnly ? "read-only" : "workspace-write")}`), `${id} sandbox`);
  }
  assert.ok(Object.values(mapping.agents).every(config => (config.reasoning ?? CODEX_MODEL_POLICY[config.tier].reasoning) !== "max"), "no role uses routine max effort");
});
test("Codex effort/model reservations: xhigh only on the Luna budget lane plus the single Sol security lane; Terra only for the locator", async () => {
  // 2026-07-18 retier invariants: above sol/high the marginal quality per
  // credit collapses (+1.3pts for +36% burn at xhigh), so sol-xhigh is
  // reserved for exactly one rare, high-consequence role (security audit);
  // luna carries xhigh as its only productive effort (its budget lane); terra
  // exists solely as the long-context-safe locator lane (haiku tier).
  const lunaXhighAgents = [
    "muster-surgeon", "wsh-api-documenter", "wsh-tutorial-engineer", "wsh-test-automator",
    "wsh-business-analyst", "wsh-content-marketer", "wsh-customer-support", "wsh-data-scientist"
  ];
  const profileNames = await readdir(selectedPlugin.profilesRoot);
  const tomlNames = profileNames.filter(name => name.endsWith(".toml"));
  assert.equal(tomlNames.length, CODEX_COUNTS.agents);
  const xhighLunaProfiles = [], xhighSolProfiles = [], terraProfiles = [];
  for (const name of tomlNames) {
    const text = await readFile(join(selectedPlugin.profilesRoot, name), "utf8");
    if (/gpt-5\.6-terra/.test(text)) terraProfiles.push(name.replace(/\.toml$/, ""));
    if (/model_reasoning_effort = "xhigh"/.test(text)) {
      if (/model = "gpt-5\.6-luna"/.test(text)) xhighLunaProfiles.push(name.replace(/\.toml$/, ""));
      else if (/model = "gpt-5\.6-sol"/.test(text)) xhighSolProfiles.push(name.replace(/\.toml$/, ""));
      else assert.fail(`${name} carries xhigh on a model outside the Luna budget lane and the Sol security lane`);
    }
  }
  assert.deepEqual(terraProfiles, ["muster-investigator"], "Terra is reserved for the read-only locator lane");
  assert.deepEqual(xhighLunaProfiles.sort(), [...lunaXhighAgents].sort(), "Luna xhigh is exactly the budget lane");
  assert.deepEqual(xhighSolProfiles, ["wsh-security-auditor"], "Sol xhigh is reserved for the security audit lane alone");
  const strategistProfile = await readFile(join(selectedPlugin.profilesRoot, "muster-strategist.toml"), "utf8");
  assert.match(strategistProfile, /model = "gpt-5\.6-sol"/, "muster-strategist stays on Sol");
  assert.match(strategistProfile, /model_reasoning_effort = "high"/, "muster-strategist stays at high effort, not xhigh");
});
test("Codex adapter preserves shared cap and Fable fallback resolution", () => {
  const oldCap = process.env.MUSTER_MAX_TIER, oldFable = process.env.MUSTER_ENABLE_FABLE;
  try {
    delete process.env.MUSTER_ENABLE_FABLE;
    delete process.env.MUSTER_MAX_TIER;
    assert.deepEqual(codexModelForRole("architecture-review"), CODEX_MODEL_POLICY.opus);
    process.env.MUSTER_ENABLE_FABLE = "true";
    assert.deepEqual(codexModelForRole("architecture-review"), CODEX_MODEL_POLICY.fable);
    process.env.MUSTER_MAX_TIER = "sonnet";
    assert.deepEqual(codexModelForRole("architecture-review"), CODEX_MODEL_POLICY.sonnet);
  } finally {
    if (oldCap === undefined) delete process.env.MUSTER_MAX_TIER; else process.env.MUSTER_MAX_TIER = oldCap;
    if (oldFable === undefined) delete process.env.MUSTER_ENABLE_FABLE; else process.env.MUSTER_ENABLE_FABLE = oldFable;
  }
});
