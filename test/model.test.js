import { test } from "node:test";
import assert from "node:assert/strict";
import { modelForRole, fallbackModelFor, capTier } from "../src/model.js";

test("mechanical roles -> haiku", () => {
  assert.equal(modelForRole("code-navigation"), "haiku");
  assert.equal(modelForRole("docs-research"), "haiku");
  assert.equal(modelForRole("research"), "haiku");
});

// "judge" is a conceptual non-enum role (tournament skill dispatches the judge);
// "architecture-review" is the canonical ROLES member. These are the two spots
// where peak judgment would pay for fable's 2x cost. But fable can be disabled
// platform-wide, so it degrades to opus BY DEFAULT (deterministic — the choke must
// never depend on the orchestrator catching a dispatch rejection). Opt back in with
// MUSTER_ENABLE_FABLE once fable is available again.
test("heavy-judgment roles -> opus by default (fable degraded)", () => {
  const prev = process.env.MUSTER_ENABLE_FABLE;
  delete process.env.MUSTER_ENABLE_FABLE;
  try {
    assert.equal(modelForRole("judge"), "opus");
    assert.equal(modelForRole("architecture-review"), "opus");
  } finally {
    if (prev !== undefined) process.env.MUSTER_ENABLE_FABLE = prev;
  }
});

test("heavy-judgment roles -> fable when MUSTER_ENABLE_FABLE is set", () => {
  const prev = process.env.MUSTER_ENABLE_FABLE;
  process.env.MUSTER_ENABLE_FABLE = "1";
  try {
    assert.equal(modelForRole("judge"), "fable");
    assert.equal(modelForRole("architecture-review"), "fable");
  } finally {
    if (prev === undefined) delete process.env.MUSTER_ENABLE_FABLE;
    else process.env.MUSTER_ENABLE_FABLE = prev;
  }
});

// An MCPB boolean user_config substitutes as the STRING "false", which a naive
// truthy check would wrongly treat as enabled. "0"/"false" must mean disabled.
test("MUSTER_ENABLE_FABLE='false' or '0' keeps fable degraded (string-as-env safety)", () => {
  const prev = process.env.MUSTER_ENABLE_FABLE;
  try {
    for (const falsey of ["false", "0", ""]) {
      process.env.MUSTER_ENABLE_FABLE = falsey;
      assert.equal(modelForRole("architecture-review"), "opus", `"${falsey}" must not enable fable`);
    }
  } finally {
    if (prev === undefined) delete process.env.MUSTER_ENABLE_FABLE;
    else process.env.MUSTER_ENABLE_FABLE = prev;
  }
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

// --- capTier ---

test("capTier(fable, opus) returns opus (cap is below fable, so fable is capped)", () => {
  assert.equal(capTier("fable", "opus"), "opus");
});

test("capTier(sonnet, opus) returns sonnet (sonnet is already below cap)", () => {
  assert.equal(capTier("sonnet", "opus"), "sonnet");
});

test("capTier(fable, bogus) returns fable (invalid cap is ignored, fail-open)", () => {
  assert.equal(capTier("fable", "bogus"), "fable");
});

test("capTier(fable, undefined) returns fable (no cap set)", () => {
  assert.equal(capTier("fable", undefined), "fable");
});

// Integration: modelForRole respects MUSTER_MAX_TIER when set.
test("modelForRole honors MUSTER_MAX_TIER=opus: fable roles cap to opus, sonnet roles unchanged", () => {
  const prev = process.env.MUSTER_MAX_TIER;
  process.env.MUSTER_MAX_TIER = "opus";
  try {
    assert.equal(modelForRole("architecture-review"), "opus");
    assert.equal(modelForRole("implement"), "sonnet");
  } finally {
    if (prev === undefined) delete process.env.MUSTER_MAX_TIER;
    else process.env.MUSTER_MAX_TIER = prev;
  }
});

test("modelForRole honors MUSTER_MAX_TIER=sonnet: fable caps to sonnet", () => {
  const prev = process.env.MUSTER_MAX_TIER;
  process.env.MUSTER_MAX_TIER = "sonnet";
  try {
    assert.equal(modelForRole("architecture-review"), "sonnet");
  } finally {
    if (prev === undefined) delete process.env.MUSTER_MAX_TIER;
    else process.env.MUSTER_MAX_TIER = prev;
  }
});

test("resolveCapabilities tags every role with a model", async () => {
  const { resolveCapabilities } = await import("../src/capabilities.js");
  const caps = resolveCapabilities([], { plugins: [], skills: [], mcpServers: [] });
  assert.equal(caps.roles["code-navigation"].model, "haiku");
  assert.equal(caps.roles["implement"].model, "sonnet");
  assert.equal(caps.roles["author"].model, "sonnet");
});

// --- capabilities-level MUSTER_MAX_TIER cap test ---------------------------
// Uses the real catalog so the test exercises the full resolveCapabilities +
// modelForRole + capTier pipeline with a live tier cap applied.

test("MUSTER_MAX_TIER=sonnet: resolveCapabilities caps architecture-review to sonnet", async () => {
  const { loadCatalog } = await import("../src/catalog.js");
  const { resolveCapabilities } = await import("../src/capabilities.js");
  const prev = process.env.MUSTER_MAX_TIER;
  process.env.MUSTER_MAX_TIER = "sonnet";
  try {
    const catalog = await loadCatalog(new URL("../catalog/", import.meta.url));
    const caps = resolveCapabilities(catalog, { plugins: [], skills: [], mcpServers: [], agents: [] });
    assert.equal(caps.roles["architecture-review"].model, "sonnet",
      "architecture-review should be capped from fable to sonnet when MUSTER_MAX_TIER=sonnet");
  } finally {
    if (prev === undefined) delete process.env.MUSTER_MAX_TIER;
    else process.env.MUSTER_MAX_TIER = prev;
  }
});

test("no cap, fable disabled (default): resolveCapabilities degrades architecture-review to opus", async () => {
  const { loadCatalog } = await import("../src/catalog.js");
  const { resolveCapabilities } = await import("../src/capabilities.js");
  const prevCap = process.env.MUSTER_MAX_TIER;
  const prevFable = process.env.MUSTER_ENABLE_FABLE;
  delete process.env.MUSTER_MAX_TIER;
  delete process.env.MUSTER_ENABLE_FABLE;
  try {
    const catalog = await loadCatalog(new URL("../catalog/", import.meta.url));
    const caps = resolveCapabilities(catalog, { plugins: [], skills: [], mcpServers: [], agents: [] });
    assert.equal(caps.roles["architecture-review"].model, "opus",
      "architecture-review should degrade fable->opus by default so dispatch never chokes");
  } finally {
    if (prevCap === undefined) delete process.env.MUSTER_MAX_TIER; else process.env.MUSTER_MAX_TIER = prevCap;
    if (prevFable === undefined) delete process.env.MUSTER_ENABLE_FABLE; else process.env.MUSTER_ENABLE_FABLE = prevFable;
  }
});

test("MUSTER_ENABLE_FABLE set, no cap: resolveCapabilities resolves architecture-review to fable", async () => {
  const { loadCatalog } = await import("../src/catalog.js");
  const { resolveCapabilities } = await import("../src/capabilities.js");
  const prevCap = process.env.MUSTER_MAX_TIER;
  const prevFable = process.env.MUSTER_ENABLE_FABLE;
  delete process.env.MUSTER_MAX_TIER;
  process.env.MUSTER_ENABLE_FABLE = "1";
  try {
    const catalog = await loadCatalog(new URL("../catalog/", import.meta.url));
    const caps = resolveCapabilities(catalog, { plugins: [], skills: [], mcpServers: [], agents: [] });
    assert.equal(caps.roles["architecture-review"].model, "fable",
      "architecture-review should resolve to fable when opted in and no cap is set");
  } finally {
    if (prevCap === undefined) delete process.env.MUSTER_MAX_TIER; else process.env.MUSTER_MAX_TIER = prevCap;
    if (prevFable === undefined) delete process.env.MUSTER_ENABLE_FABLE; else process.env.MUSTER_ENABLE_FABLE = prevFable;
  }
});
