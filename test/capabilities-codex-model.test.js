// capabilities-codex-exact-model: `capabilities --codex` reports the conceptual
// Claude tier (roles[role].model) but a driver dispatching on Codex needs the
// EXACT resolved profile — which gpt-5.6 model + reasoning effort a role's
// chosen agent lands on — without waiting for the post-run codex-conformance
// audit. The resolution is deterministic and already computed: the committed
// .codex/agents/<id>.toml pins (codex-release.js profileToml) are its authority.
// These tests pin the coherence: on the --codex lane ONLY, each agent-backed
// role carries codexModel: {model, effort} equal to that agent's committed TOML.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { resolveCapabilities } from "../src/capabilities.js";
import { loadCatalog } from "../src/catalog.js";
import { adaptCatalogForCodex } from "../src/codex-catalog.js";

// Local repoRoot (not test-support/codex-helpers.js, whose import eagerly
// resolves the BUILT plugin) so this coherence test reads the committed source
// TOMLs without requiring a prior plugin build.
const repoRoot = new URL("../", import.meta.url).pathname;

// Hermetic inventory: agent-kind roles are unaffected by the Codex native-skill
// upstreaming in adaptCatalogForCodex (that only re-ranks builtin *skills*), so
// a fixed empty inventory resolves the same agent chosen for each role as the
// live one — but deterministically and without reading ~/.codex.
const installed = { skills: [], plugins: [], mcpServers: [] };

async function codexCaps() {
  const catalog = await loadCatalog(new URL("../catalog/", import.meta.url));
  return resolveCapabilities(adaptCatalogForCodex(catalog, installed), installed, undefined, { codex: true });
}

function committedTomlPin(agentId) {
  const text = readFileSync(join(repoRoot, ".codex", "agents", `${agentId}.toml`), "utf8");
  return {
    model: text.match(/^model = "(.+)"$/m)?.[1],
    effort: text.match(/^model_reasoning_effort = "(.+)"$/m)?.[1]
  };
}

test("capabilities --codex: named agents carry codexModel {model, effort} coherent across tiers", async () => {
  const { roles } = await codexCaps();
  const roleByAgent = (id) => Object.values(roles).find(r => r.chosen.kind === "agent" && r.chosen.id === id);

  // Four deliberately different tier lanes (see codex/agents.manifest.json):
  // sol/xhigh (the one rare high-consequence lane), sol/medium (workhorse),
  // luna/xhigh (bounded budget lane), terra/high (long-context-safe locator).
  const named = {
    "wsh-security-auditor": { model: "gpt-5.6-sol", effort: "xhigh" },
    "muster-builder": { model: "gpt-5.6-sol", effort: "medium" },
    "wsh-test-automator": { model: "gpt-5.6-luna", effort: "xhigh" },
    "muster-investigator": { model: "gpt-5.6-terra", effort: "high" }
  };
  for (const [agentId, expected] of Object.entries(named)) {
    const role = roleByAgent(agentId);
    assert.ok(role, `no --codex role resolves to the ${agentId} agent`);
    assert.deepEqual(role.codexModel, expected, `${agentId} codexModel is the wrong lane`);
    // Coherence: the field is not a hand-written literal — it must equal the
    // committed profile TOML the Codex runtime actually dispatches on.
    assert.deepEqual(role.codexModel, committedTomlPin(agentId), `${agentId} codexModel diverged from its committed .codex/agents TOML`);
  }
});

test("capabilities --codex: EVERY agent-backed role's codexModel matches its committed TOML pin", async () => {
  const { roles } = await codexCaps();
  const agentRoles = Object.values(roles).filter(r => r.chosen.kind === "agent");
  assert.ok(agentRoles.length >= 4, "expected several agent-backed roles on the Codex lane");
  for (const r of agentRoles) {
    assert.ok(r.codexModel && typeof r.codexModel.model === "string" && typeof r.codexModel.effort === "string",
      `${r.chosen.id} is missing a resolved codexModel {model, effort}`);
    assert.deepEqual(r.codexModel, committedTomlPin(r.chosen.id),
      `${r.chosen.id} codexModel does not match its committed .codex/agents TOML`);
  }
});

test("non-codex lane output shape is unchanged: no codexModel field", async () => {
  const catalog = await loadCatalog(new URL("../catalog/", import.meta.url));
  const { roles } = resolveCapabilities(catalog, installed);
  for (const [name, r] of Object.entries(roles)) {
    assert.equal("codexModel" in r, false, `non-codex role ${name} leaked a codexModel field`);
  }
});

test("non-agent Codex providers (skill/mcp/inline) carry no codexModel — there is no profile TOML to dispatch", async () => {
  const { roles } = await codexCaps();
  for (const [name, r] of Object.entries(roles)) {
    if (r.chosen.kind !== "agent") {
      assert.equal("codexModel" in r, false, `${name} (${r.chosen.kind}) fabricated a codexModel with no backing profile`);
    }
  }
});
