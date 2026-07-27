// The packaged harness-neutral agent manifest (catalog/agents.manifest.json) is
// read once and cached by src/agent-manifest.js; every adapter (Codex, Kimi,
// Claude) resolves the SAME file through its own policy. Pin: it parses, is
// frozen, caches, and every entry is a valid neutral { tier, effort? } profile
// naming no concrete harness model.
import { test } from "node:test";
import assert from "node:assert/strict";
import { agentProfiles, readAgentManifest } from "../src/agent-manifest.js";
import { assertNeutralProfile } from "../src/model-policy.js";

test("packaged agents.manifest.json parses and caches a frozen document", () => {
  const manifest = readAgentManifest();
  assert.equal(manifest.format, 1);
  assert.equal(typeof manifest.description, "string");
  assert.ok(manifest.agents && typeof manifest.agents === "object");
  assert.ok(Object.isFrozen(manifest), "the cached manifest must be frozen");
  assert.equal(readAgentManifest(), manifest, "read once, cached -- same object across calls");
});

test("every manifest entry is a valid neutral { tier, effort? } profile", () => {
  const profiles = agentProfiles();
  assert.ok(Object.keys(profiles).length > 0, "the packaged manifest must classify at least one agent");
  for (const [id, config] of Object.entries(profiles)) {
    assert.doesNotThrow(() => assertNeutralProfile(config), `${id} must satisfy the neutral profile shape`);
    assert.equal(config.model, undefined, `${id} must not name a concrete harness model`);
  }
});

test("agentProfiles returns the manifest's agents map", () => {
  assert.equal(agentProfiles(), readAgentManifest().agents);
});
