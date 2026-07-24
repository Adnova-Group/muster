// capabilities --kimi: the Kimi sibling of the --codex lane. Each agent-backed
// role carries kimiModel: {model, effort|thinking} -- the exact Kimi Code alias
// its chosen agent dispatches on, resolved from the SAME neutral manifest
// (kimiProfileForAgentId). Hermetic: resolveCapabilities is pure (catalog +
// manifest), no plugin build / staging dir needed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveCapabilities } from "../src/capabilities.js";
import { loadCatalog } from "../src/catalog.js";
import { kimiProfileForConfig, kimiProfileForAgentId } from "../src/kimi.js";

// Fixed empty inventory -> deterministic agent-kind resolution (installed
// providers can't displace builtins), independent of the calling environment.
const installed = { runtime: "kimi", skills: [], plugins: [], mcpServers: [], agents: [] };

async function kimiCaps() {
  const catalog = await loadCatalog(new URL("../catalog/", import.meta.url));
  return resolveCapabilities(catalog, installed, undefined, { kimi: true });
}

test("capabilities --kimi: every agent-backed role carries a kimiModel {model, effort|thinking}", async () => {
  const caps = await kimiCaps();
  let agentRoles = 0;
  for (const [role, r] of Object.entries(caps.roles)) {
    if (r.chosen.kind !== "agent") {
      assert.equal(r.kimiModel, undefined, `${role} is not agent-backed -> no kimiModel`);
      continue;
    }
    agentRoles++;
    assert.ok(r.kimiModel && typeof r.kimiModel.model === "string",
      `${role} (agent ${r.chosen.id}) must carry a kimiModel.model string`);
    // effort (K3 tiers) OR thinking (always-thinking coding models) -- exactly one.
    const hasEffort = typeof r.kimiModel.effort === "string";
    const hasThinking = typeof r.kimiModel.thinking === "string";
    assert.ok(hasEffort !== hasThinking, `${role}: kimiModel carries exactly one of effort/thinking`);
    // Single-sourced: the lane's kimiModel equals kimiProfileForAgentId directly.
    assert.deepEqual(r.kimiModel, kimiProfileForAgentId(r.chosen.id), `${role}: lane matches kimiProfileForAgentId`);
  }
  assert.ok(agentRoles > 0, "at least one role resolves to a builtin agent");
});

test("capabilities WITHOUT --kimi carries no kimiModel (opt-in only)", async () => {
  const catalog = await loadCatalog(new URL("../catalog/", import.meta.url));
  const caps = resolveCapabilities(catalog, installed, undefined);
  for (const r of Object.values(caps.roles)) assert.equal(r.kimiModel, undefined);
});

test("kimiProfileForAgentId resolves known agents to the reconciled aliases", () => {
  // muster-builder = {tier:opus, effort:workhorse} -> k3/high (workhorse->high on K3)
  assert.deepEqual(kimiProfileForAgentId("muster-builder"), { model: "kimi-code/k3", effort: "high" });
  // muster-surgeon = {tier:sonnet} -> the always-thinking coding workhorse
  assert.deepEqual(kimiProfileForAgentId("muster-surgeon"), { model: "kimi-code/kimi-for-coding", thinking: "enabled" });
  // wsh-security-auditor = {tier:opus, effort:peak} -> k3/max
  assert.deepEqual(kimiProfileForAgentId("wsh-security-auditor"), { model: "kimi-code/k3", effort: "max" });
  // muster-investigator = {tier:haiku} -> the fast locator variant
  assert.deepEqual(kimiProfileForAgentId("muster-investigator"), { model: "kimi-code/kimi-for-coding-highspeed", thinking: "enabled" });
});

test("kimiProfileForAgentId returns null for a non-agent id", () => {
  assert.equal(kimiProfileForAgentId("inline"), null);
  assert.equal(kimiProfileForAgentId("no-such-agent"), null);
});

test("kimiProfileForAgentId is single-sourced with kimiProfileForConfig", () => {
  // opus+judgment resolves identically whether via the agent id or the raw config.
  assert.deepEqual(kimiProfileForAgentId("muster-reviewer"), kimiProfileForConfig({ tier: "opus", effort: "judgment" }));
});
