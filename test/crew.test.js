import { test } from "node:test";
import assert from "node:assert/strict";
import { modelFor, chosen, collectRecommendations, makeStage } from "../src/crew.js";
import { modelForRole } from "../src/model.js";

// Ensure tier assertions are stable regardless of caller environment.
delete process.env.MUSTER_MAX_TIER;

// ---------------------------------------------------------------------------
// modelFor
// ---------------------------------------------------------------------------

test("modelFor: returns caps.roles[role].model when present", () => {
  const caps = { roles: { implement: { model: "opus", chosen: { id: "x", source: "builtin" }, recommendations: [] } } };
  assert.equal(modelFor(caps, "implement"), "opus");
});

test("modelFor: falls back to modelForRole when caps has no entry for the role", () => {
  assert.equal(modelFor({}, "architecture-review"), modelForRole("architecture-review"));
  // top tier degrades fable->opus by default (fable disabled platform-wide).
  assert.equal(modelFor({}, "architecture-review"), "opus");
});

test("modelFor: falls back when caps is null", () => {
  assert.equal(modelFor(null, "implement"), modelForRole("implement"));
});

test("modelFor: falls back when caps.roles is absent", () => {
  assert.equal(modelFor({}, "implement"), modelForRole("implement"));
});

test("modelFor: falls back when the role is missing from caps.roles", () => {
  const caps = { roles: { other: { model: "opus" } } };
  assert.equal(modelFor(caps, "code-review"), modelForRole("code-review"));
});

// ---------------------------------------------------------------------------
// chosen
// ---------------------------------------------------------------------------

test("chosen: returns caps.roles[role].chosen when present", () => {
  const caps = { roles: { implement: { chosen: { id: "my-provider", source: "installed" }, model: "sonnet", recommendations: [] } } };
  assert.deepEqual(chosen(caps, "implement"), { id: "my-provider", source: "installed" });
});

test("chosen: returns inline fallback when caps is null", () => {
  assert.deepEqual(chosen(null, "implement"), { id: "inline", source: "inline" });
});

test("chosen: returns inline fallback when role is missing from caps", () => {
  assert.deepEqual(chosen({}, "implement"), { id: "inline", source: "inline" });
});

test("chosen: returns inline fallback when caps.roles is absent", () => {
  assert.deepEqual(chosen({ roles: null }, "implement"), { id: "inline", source: "inline" });
});

// ---------------------------------------------------------------------------
// collectRecommendations
// ---------------------------------------------------------------------------

test("collectRecommendations: returns deduped union across multiple roles", () => {
  const caps = {
    roles: {
      "code-review": { recommendations: ["install serena", "install context7"], model: "sonnet", chosen: { id: "x", source: "builtin" } },
      "architecture-review": { recommendations: ["install serena", "install arch-tool"], model: "fable", chosen: { id: "y", source: "builtin" } }
    }
  };
  const recs = collectRecommendations(caps, ["code-review", "architecture-review"]);
  // "install serena" appears in both — must appear only once.
  assert.equal(recs.filter(r => r === "install serena").length, 1, "deduplicated");
  assert.ok(recs.includes("install context7"));
  assert.ok(recs.includes("install arch-tool"));
  assert.equal(recs.length, 3);
});

test("collectRecommendations: empty when no role has recommendations", () => {
  const caps = {
    roles: {
      implement: { recommendations: [], model: "sonnet", chosen: { id: "x", source: "builtin" } }
    }
  };
  assert.deepEqual(collectRecommendations(caps, ["implement"]), []);
});

test("collectRecommendations: tolerates null caps without throwing", () => {
  assert.doesNotThrow(() => collectRecommendations(null, ["implement"]));
  assert.deepEqual(collectRecommendations(null, ["implement"]), []);
});

test("collectRecommendations: tolerates missing role in caps.roles", () => {
  const caps = { roles: {} };
  assert.deepEqual(collectRecommendations(caps, ["implement", "code-review"]), []);
});

test("collectRecommendations: preserves first-seen order (not insertion order of roles map)", () => {
  const caps = {
    roles: {
      "code-review": { recommendations: ["rec-b", "rec-a"], model: "sonnet", chosen: { id: "x", source: "builtin" } },
      "implement":   { recommendations: ["rec-c", "rec-a"], model: "sonnet", chosen: { id: "y", source: "builtin" } }
    }
  };
  const recs = collectRecommendations(caps, ["code-review", "implement"]);
  // rec-a from code-review is seen first; rec-a from implement is a dup.
  assert.deepEqual(recs, ["rec-b", "rec-a", "rec-c"]);
});

// ---------------------------------------------------------------------------
// makeStage
// ---------------------------------------------------------------------------

test("makeStage: produces a valid crew-member object with stage/provider/source/model", () => {
  const caps = {
    roles: {
      implement: { chosen: { id: "sp-impl", source: "builtin" }, model: "sonnet", recommendations: [] }
    }
  };
  const stage = makeStage(caps, "evidence-text");
  const member = stage("implement", "needed for the fix");
  assert.equal(member.stage, "implement");
  assert.equal(member.provider, "sp-impl");
  assert.equal(member.source, "builtin");
  assert.equal(member.model, "sonnet");
  assert.equal(member.rationale, "needed for the fix");
  assert.equal(member.evidence, "evidence-text");
  assert.equal(member.fallback, "inline");
});

test("makeStage: uses inline fallback when caps has no entry for the role", () => {
  const stage = makeStage({}, "e");
  const member = stage("security-review", "r");
  assert.equal(member.provider, "inline");
  assert.equal(member.source, "inline");
  assert.equal(member.model, modelForRole("security-review"));
});

test("makeStage: caps model override flows through to the crew member", () => {
  const caps = {
    roles: {
      implement: { chosen: { id: "x", source: "installed" }, model: "opus", recommendations: [] }
    }
  };
  const stage = makeStage(caps, "e");
  const member = stage("implement", "r");
  assert.equal(member.model, "opus");
});

test("makeStage: null caps does not throw", () => {
  assert.doesNotThrow(() => {
    const stage = makeStage(null, "e");
    stage("implement", "r");
  });
});
