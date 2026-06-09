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

test("resolveCapabilities tags every role with a model", async () => {
  const { resolveCapabilities } = await import("../src/capabilities.js");
  const caps = resolveCapabilities([], { plugins: [], skills: [], mcpServers: [] });
  assert.equal(caps.roles["code-navigation"].model, "haiku");
  assert.equal(caps.roles["implement"].model, "sonnet");
  assert.equal(caps.roles["author"].model, "sonnet");
});
