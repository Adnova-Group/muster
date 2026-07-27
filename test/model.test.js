import { test } from "node:test";
import assert from "node:assert/strict";
import { modelForRole, fallbackModelFor, capTier, floorAtCore, normalizeTier, LEGACY_TIER_ALIASES } from "../src/model.js";
import { bareCapabilities } from "./test-support/capabilities-helpers.js";

test("mechanical roles -> scout", () => {
  assert.equal(modelForRole("code-navigation"), "scout");
  assert.equal(modelForRole("docs-research"), "scout");
  assert.equal(modelForRole("research"), "scout");
});

// "judge" is a conceptual non-enum role (tournament skill dispatches the judge);
// "architecture-review" is the canonical ROLES member. These are the two spots
// where peak judgment would pay for apex's 2x cost. But the apex tier can be
// disabled platform-wide (its Claude mapping, Fable, has been), so it degrades to
// prime BY DEFAULT (deterministic — the choke must never depend on the
// orchestrator catching a dispatch rejection). Opt back in with
// MUSTER_ENABLE_APEX (or the legacy MUSTER_ENABLE_FABLE) once available.
test("heavy-judgment roles -> prime by default (apex degraded)", () => {
  const prev = process.env.MUSTER_ENABLE_APEX, prevLegacy = process.env.MUSTER_ENABLE_FABLE;
  delete process.env.MUSTER_ENABLE_APEX;
  delete process.env.MUSTER_ENABLE_FABLE;
  try {
    assert.equal(modelForRole("judge"), "prime");
    assert.equal(modelForRole("architecture-review"), "prime");
  } finally {
    if (prev !== undefined) process.env.MUSTER_ENABLE_APEX = prev;
    if (prevLegacy !== undefined) process.env.MUSTER_ENABLE_FABLE = prevLegacy;
  }
});

test("heavy-judgment roles -> apex when MUSTER_ENABLE_APEX is set", () => {
  const prev = process.env.MUSTER_ENABLE_APEX;
  process.env.MUSTER_ENABLE_APEX = "1";
  try {
    assert.equal(modelForRole("judge"), "apex");
    assert.equal(modelForRole("architecture-review"), "apex");
  } finally {
    if (prev === undefined) delete process.env.MUSTER_ENABLE_APEX;
    else process.env.MUSTER_ENABLE_APEX = prev;
  }
});

// The pre-rename env name keeps working: user environments set it long before the
// semantic-tier rename and must not silently lose their opt-in.
test("legacy MUSTER_ENABLE_FABLE still enables the apex tier", () => {
  const prev = process.env.MUSTER_ENABLE_APEX, prevLegacy = process.env.MUSTER_ENABLE_FABLE;
  delete process.env.MUSTER_ENABLE_APEX;
  process.env.MUSTER_ENABLE_FABLE = "1";
  try {
    assert.equal(modelForRole("judge"), "apex");
  } finally {
    if (prev !== undefined) process.env.MUSTER_ENABLE_APEX = prev;
    if (prevLegacy === undefined) delete process.env.MUSTER_ENABLE_FABLE;
    else process.env.MUSTER_ENABLE_FABLE = prevLegacy;
  }
});

// An MCPB boolean user_config substitutes as the STRING "false", which a naive
// truthy check would wrongly treat as enabled. "0"/"false" must mean disabled.
test("MUSTER_ENABLE_APEX='false' or '0' keeps apex degraded (string-as-env safety)", () => {
  const prev = process.env.MUSTER_ENABLE_APEX, prevLegacy = process.env.MUSTER_ENABLE_FABLE;
  delete process.env.MUSTER_ENABLE_FABLE;
  try {
    for (const falsey of ["false", "0", ""]) {
      process.env.MUSTER_ENABLE_APEX = falsey;
      assert.equal(modelForRole("architecture-review"), "prime", `"${falsey}" must not enable apex`);
    }
  } finally {
    if (prev === undefined) delete process.env.MUSTER_ENABLE_APEX;
    else process.env.MUSTER_ENABLE_APEX = prev;
    if (prevLegacy !== undefined) process.env.MUSTER_ENABLE_FABLE = prevLegacy;
  }
});

// Apex may be unavailable on a given plan. Dispatch must degrade to prime —
// never fail the task, never silently inherit. Legacy names normalize first.
test("apex degrades to prime when unavailable; other tiers have no fallback", () => {
  assert.equal(fallbackModelFor("apex"), "prime");
  assert.equal(fallbackModelFor("prime"), "prime");
  assert.equal(fallbackModelFor("core"), "core");
  assert.equal(fallbackModelFor("scout"), "scout");
  // legacy vocabulary normalizes, then degrades identically
  assert.equal(fallbackModelFor("fable"), "prime");
  assert.equal(fallbackModelFor("opus"), "prime");
});

test("default role -> core", () => {
  assert.equal(modelForRole("implement"), "core");
  assert.equal(modelForRole("code-review"), "core");
  assert.equal(modelForRole("author"), "core");
});

// --- normalizeTier & LEGACY_TIER_ALIASES ---

test("normalizeTier maps every legacy name and passes canonical/unknown through", () => {
  assert.deepEqual(LEGACY_TIER_ALIASES, { haiku: "scout", sonnet: "core", opus: "prime", fable: "apex" });
  for (const [legacy, canonical] of Object.entries(LEGACY_TIER_ALIASES)) {
    assert.equal(normalizeTier(legacy), canonical);
    assert.equal(normalizeTier(canonical), canonical);
  }
  assert.equal(normalizeTier("bogus"), "bogus");
});

// --- MODEL_TIER_ORDER & maxTier ---

import { MODEL_TIER_ORDER, maxTier } from "../src/model.js";

test("MODEL_TIER_ORDER is ascending: scout < core < prime < apex", () => {
  assert.deepEqual(MODEL_TIER_ORDER, ["scout", "core", "prime", "apex"]);
});

test("maxTier picks apex over core and scout", () => {
  assert.equal(maxTier(["scout", "core", "apex"]), "apex");
});

test("maxTier accepts legacy names and returns canonical", () => {
  assert.equal(maxTier(["haiku", "sonnet", "fable"]), "apex");
  assert.equal(maxTier(["haiku", "core"]), "core");
});

test("maxTier ignores unknown names, returns known max", () => {
  assert.equal(maxTier(["unknown-role", "core"]), "core");
});

test("maxTier returns undefined for empty list", () => {
  assert.equal(maxTier([]), undefined);
});

test("maxTier returns undefined when all inputs are unknown", () => {
  assert.equal(maxTier(["unknown", "also-unknown"]), undefined);
});

// --- capTier ---

test("capTier(apex, prime) returns prime (cap is below apex, so apex is capped)", () => {
  assert.equal(capTier("apex", "prime"), "prime");
});

test("capTier(core, prime) returns core (core is already below cap)", () => {
  assert.equal(capTier("core", "prime"), "core");
});

test("capTier accepts legacy names for both tier and cap, emits canonical", () => {
  assert.equal(capTier("fable", "opus"), "prime");
  assert.equal(capTier("sonnet", "opus"), "core");
});

test("capTier(apex, bogus) returns apex (invalid cap is ignored, fail-open)", () => {
  assert.equal(capTier("apex", "bogus"), "apex");
});

test("capTier(apex, undefined) returns apex (no cap set)", () => {
  assert.equal(capTier("apex", undefined), "apex");
});

// Integration: modelForRole respects MUSTER_MAX_TIER when set — including a
// LEGACY value already sitting in a user's environment.
test("modelForRole honors MUSTER_MAX_TIER=prime: apex roles cap to prime, core roles unchanged", () => {
  const prev = process.env.MUSTER_MAX_TIER;
  process.env.MUSTER_MAX_TIER = "prime";
  try {
    assert.equal(modelForRole("architecture-review"), "prime");
    assert.equal(modelForRole("implement"), "core");
  } finally {
    if (prev === undefined) delete process.env.MUSTER_MAX_TIER;
    else process.env.MUSTER_MAX_TIER = prev;
  }
});

test("modelForRole honors a LEGACY MUSTER_MAX_TIER=sonnet: apex caps to core", () => {
  const prev = process.env.MUSTER_MAX_TIER;
  process.env.MUSTER_MAX_TIER = "sonnet";
  try {
    assert.equal(modelForRole("architecture-review"), "core");
  } finally {
    if (prev === undefined) delete process.env.MUSTER_MAX_TIER;
    else process.env.MUSTER_MAX_TIER = prev;
  }
});

test("resolveCapabilities tags every role with a model", async () => {
  const { resolveCapabilities } = await import("../src/capabilities.js");
  const caps = resolveCapabilities([], { plugins: [], skills: [], mcpServers: [] });
  assert.equal(caps.roles["code-navigation"].model, "scout");
  assert.equal(caps.roles["implement"].model, "core");
  assert.equal(caps.roles["author"].model, "core");
});

// --- capabilities-level MUSTER_MAX_TIER cap test ---------------------------
// Uses the real catalog so the test exercises the full resolveCapabilities +
// modelForRole + capTier pipeline with a live tier cap applied.

test("MUSTER_MAX_TIER=core: resolveCapabilities caps architecture-review to core", async () => {
  const { loadCatalog } = await import("../src/catalog.js");
  const { resolveCapabilities } = await import("../src/capabilities.js");
  const prev = process.env.MUSTER_MAX_TIER;
  process.env.MUSTER_MAX_TIER = "core";
  try {
    const catalog = await loadCatalog(new URL("../catalog/", import.meta.url));
    const caps = resolveCapabilities(catalog, bareCapabilities());
    assert.equal(caps.roles["architecture-review"].model, "core",
      "architecture-review should be capped from apex to core when MUSTER_MAX_TIER=core");
  } finally {
    if (prev === undefined) delete process.env.MUSTER_MAX_TIER;
    else process.env.MUSTER_MAX_TIER = prev;
  }
});

test("no cap, apex disabled (default): resolveCapabilities degrades architecture-review to prime", async () => {
  const { loadCatalog } = await import("../src/catalog.js");
  const { resolveCapabilities } = await import("../src/capabilities.js");
  const prevCap = process.env.MUSTER_MAX_TIER;
  const prevApex = process.env.MUSTER_ENABLE_APEX, prevLegacy = process.env.MUSTER_ENABLE_FABLE;
  delete process.env.MUSTER_MAX_TIER;
  delete process.env.MUSTER_ENABLE_APEX;
  delete process.env.MUSTER_ENABLE_FABLE;
  try {
    const catalog = await loadCatalog(new URL("../catalog/", import.meta.url));
    const caps = resolveCapabilities(catalog, bareCapabilities());
    assert.equal(caps.roles["architecture-review"].model, "prime",
      "architecture-review should degrade apex->prime by default so dispatch never chokes");
  } finally {
    if (prevCap === undefined) delete process.env.MUSTER_MAX_TIER; else process.env.MUSTER_MAX_TIER = prevCap;
    if (prevApex !== undefined) process.env.MUSTER_ENABLE_APEX = prevApex;
    if (prevLegacy !== undefined) process.env.MUSTER_ENABLE_FABLE = prevLegacy;
  }
});

test("MUSTER_ENABLE_APEX set, no cap: resolveCapabilities resolves architecture-review to apex", async () => {
  const { loadCatalog } = await import("../src/catalog.js");
  const { resolveCapabilities } = await import("../src/capabilities.js");
  const prevCap = process.env.MUSTER_MAX_TIER;
  const prevApex = process.env.MUSTER_ENABLE_APEX;
  delete process.env.MUSTER_MAX_TIER;
  process.env.MUSTER_ENABLE_APEX = "1";
  try {
    const catalog = await loadCatalog(new URL("../catalog/", import.meta.url));
    const caps = resolveCapabilities(catalog, bareCapabilities());
    assert.equal(caps.roles["architecture-review"].model, "apex",
      "architecture-review should resolve to apex when opted in and no cap is set");
  } finally {
    if (prevCap === undefined) delete process.env.MUSTER_MAX_TIER; else process.env.MUSTER_MAX_TIER = prevCap;
    if (prevApex === undefined) delete process.env.MUSTER_ENABLE_APEX;
    else process.env.MUSTER_ENABLE_APEX = prevApex;
  }
});

// --- floorAtCore ---

test("floorAtCore: scout is below core, floors to core", () => {
  assert.equal(floorAtCore("scout"), "core");
});

test("floorAtCore: core is at floor, returns core unchanged", () => {
  assert.equal(floorAtCore("core"), "core");
});

test("floorAtCore: apex is above core, passes through unchanged", () => {
  assert.equal(floorAtCore("apex"), "apex");
});

test("floorAtCore: undefined tier defaults to core", () => {
  assert.equal(floorAtCore(undefined), "core");
});

test("floorAtCore: legacy names normalize (haiku floors to core, opus passes as prime)", () => {
  assert.equal(floorAtCore("haiku"), "core");
  assert.equal(floorAtCore("opus"), "prime");
});
