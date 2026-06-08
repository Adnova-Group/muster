import { test } from "node:test";
import assert from "node:assert/strict";
import { modelForRole } from "../src/model.js";

test("mechanical roles -> haiku", () => {
  assert.equal(modelForRole("code-navigation"), "haiku");
  assert.equal(modelForRole("docs-research"), "haiku");
  assert.equal(modelForRole("research"), "haiku");
});

test("heavy-judgment roles -> opus", () => {
  assert.equal(modelForRole("judge"), "opus");
  assert.equal(modelForRole("strategist"), "opus");
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
