import { test } from "node:test";
import assert from "node:assert/strict";
import { modelForRole, fallbackModelFor } from "../src/model.js";

test("mechanical roles -> haiku", () => {
  assert.equal(modelForRole("code-navigation"), "haiku");
  assert.equal(modelForRole("docs-research"), "haiku");
  assert.equal(modelForRole("research"), "haiku");
});

test("heavy-judgment roles -> fable (top tier)", () => {
  // "judge" is a conceptual non-enum role (tournament skill dispatches the judge);
  // "architecture-review" is the canonical ROLES member. These are the two spots
  // where peak judgment pays for fable's 2x cost; everything else stays cheaper.
  assert.equal(modelForRole("judge"), "fable");
  assert.equal(modelForRole("architecture-review"), "fable");
});

// Fable may be unavailable on a given plan (e.g. requires extra usage credits).
// Dispatch must degrade to opus — never fail the task, never silently inherit.
test("fable degrades to opus when unavailable; other tiers have no fallback", () => {
  assert.equal(fallbackModelFor("fable"), "opus");
  assert.equal(fallbackModelFor("opus"), "opus");
  assert.equal(fallbackModelFor("sonnet"), "sonnet");
  assert.equal(fallbackModelFor("haiku"), "haiku");
});

test("default role -> sonnet", () => {
  assert.equal(modelForRole("implement"), "sonnet");
  assert.equal(modelForRole("code-review"), "sonnet");
  assert.equal(modelForRole("author"), "sonnet");
});

// --- MODEL_TIER_ORDER & maxTier ---

import { MODEL_TIER_ORDER, maxTier } from "../src/model.js";

test("MODEL_TIER_ORDER is ascending: haiku < sonnet < opus < fable", () => {
  assert.deepEqual(MODEL_TIER_ORDER, ["haiku", "sonnet", "opus", "fable"]);
});

test("maxTier picks fable over sonnet and haiku", () => {
  assert.equal(maxTier(["haiku", "sonnet", "fable"]), "fable");
});

test("maxTier picks sonnet when no higher tier present", () => {
  assert.equal(maxTier(["haiku", "sonnet"]), "sonnet");
});

test("maxTier ignores unknown names, returns known max", () => {
  assert.equal(maxTier(["unknown-role", "sonnet"]), "sonnet");
});

test("maxTier returns undefined for empty list", () => {
  assert.equal(maxTier([]), undefined);
});

test("maxTier returns undefined when all inputs are unknown", () => {
  assert.equal(maxTier(["unknown", "also-unknown"]), undefined);
});

test("resolveCapabilities tags every role with a model", async () => {
  const { resolveCapabilities } = await import("../src/capabilities.js");
  const caps = resolveCapabilities([], { plugins: [], skills: [], mcpServers: [] });
  assert.equal(caps.roles["code-navigation"].model, "haiku");
  assert.equal(caps.roles["implement"].model, "sonnet");
  assert.equal(caps.roles["author"].model, "sonnet");
});
