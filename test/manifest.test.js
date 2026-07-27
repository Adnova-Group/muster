import { test } from "node:test";
import assert from "node:assert/strict";
import { validateManifest } from "../src/manifest.js";

const valid = {
  outcome: "Add rate limiting",
  successCriteria: ["429 past N req/min", "tests green"],
  crew: [{ stage: "navigate", provider: "grep", source: "builtin", model: "sonnet",
           rationale: "no LSP", evidence: "no serena", fallback: "inline" }],
  recommendations: ["install serena"],
  degradations: ["nav fell to builtin"],
  plan: [{ task: "middleware", mode: "single" }]
};

test("accepts a well-formed manifest", () => {
  assert.deepEqual(validateManifest(valid), { ok: true, errors: [] });
});

test("rejects missing outcome / empty success criteria", () => {
  const r = validateManifest({ ...valid, outcome: "", successCriteria: [] });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some(e => /outcome/.test(e)));
  assert.ok(r.errors.some(e => /successCriteria/.test(e)));
});

test("rejects bad source and bad plan mode", () => {
  const r = validateManifest({
    ...valid,
    crew: [{ ...valid.crew[0], source: "magic" }],
    plan: [{ task: "x", mode: "parallel" }]
  });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some(e => /source/.test(e)));
  assert.ok(r.errors.some(e => /mode/.test(e)));
});

test("returns structured errors for null crew and plan entries", () => {
  const r = validateManifest({ ...valid, crew: [null], plan: [null] });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some(e => /crew\[0\].*object/.test(e)), JSON.stringify(r.errors));
  assert.ok(r.errors.some(e => /plan\[0\].*object/.test(e)), JSON.stringify(r.errors));
});

test("returns one structured error for non-array deps without traversing it", () => {
  const r = validateManifest({ ...valid, plan: [{ id: "build", task: "build", mode: "single", deps: "prep" }] });
  assert.equal(r.ok, false);
  assert.deepEqual(r.errors.filter(e => /plan\[0\]\.deps/.test(e)), ["plan[0].deps: must be an array"]);
});

// A non-inline crew member dispatches to a specific provider on a specific model.
// If the resolved model isn't bound to the member, dispatch silently inherits the
// orchestrator's model (Opus). The manifest must carry it, or validation fails loud.
test("rejects a non-inline crew member with no model", () => {
  const noModel = { stage: "implement", provider: "muster-builder", source: "builtin",
                    rationale: "r", evidence: "e", fallback: "inline" };
  const r = validateManifest({ ...valid, crew: [noModel] });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some(e => /model/.test(e)), `expected a model error, got ${JSON.stringify(r.errors)}`);
});

test("rejects an unknown model tier", () => {
  const badModel = { stage: "implement", provider: "x", source: "builtin", model: "gpt-4",
                     rationale: "r", evidence: "e", fallback: "inline" };
  const r = validateManifest({ ...valid, crew: [badModel] });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some(e => /model/.test(e)));
});

test("accepts fable as a model tier (top tier, ready for routing)", () => {
  const fableMember = { stage: "judge", provider: "x", source: "builtin", model: "fable",
                        rationale: "r", evidence: "e", fallback: "inline" };
  const r = validateManifest({ ...valid, crew: [fableMember] });
  assert.deepEqual(r, { ok: true, errors: [] });
});

// --- Neutral { tier, effort? } crew model profile (the post-rename shape) ----
// crew[].model also accepts the same neutral profile agents declare in
// catalog/agents.manifest.json: { tier, effort? }. The effort vocabulary is the
// SEMANTIC ladder workhorse|judgment|peak -- harness effort strings like "high"
// are NOT legal here (that is the point of the neutral shape).
test("accepts a neutral {tier} crew model profile", () => {
  const member = { stage: "implement", provider: "x", source: "builtin", model: { tier: "prime" },
                   rationale: "r", evidence: "e", fallback: "inline" };
  assert.deepEqual(validateManifest({ ...valid, crew: [member] }), { ok: true, errors: [] });
});

for (const effort of ["workhorse", "judgment", "peak"]) {
  test(`accepts a neutral profile with semantic effort "${effort}"`, () => {
    const member = { stage: "implement", provider: "x", source: "builtin",
                     model: { tier: "prime", effort }, rationale: "r", evidence: "e", fallback: "inline" };
    assert.deepEqual(validateManifest({ ...valid, crew: [member] }), { ok: true, errors: [] });
  });
}

test("rejects a neutral profile with an unknown tier", () => {
  const member = { stage: "implement", provider: "x", source: "builtin", model: { tier: "gpt-4" },
                   rationale: "r", evidence: "e", fallback: "inline" };
  const r = validateManifest({ ...valid, crew: [member] });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some(e => /crew\[0\]\.model\.tier/.test(e) && /scout/.test(e)),
    `expected a tier-naming error, got ${JSON.stringify(r.errors)}`);
});

test("rejects a neutral profile carrying a harness effort string (not a semantic effort)", () => {
  const member = { stage: "implement", provider: "x", source: "builtin",
                   model: { tier: "prime", effort: "high" }, rationale: "r", evidence: "e", fallback: "inline" };
  const r = validateManifest({ ...valid, crew: [member] });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some(e => /crew\[0\]\.model\.effort/.test(e) && /workhorse/.test(e)),
    `expected an effort-naming error, got ${JSON.stringify(r.errors)}`);
});

test("rejects a neutral profile with extra keys", () => {
  const member = { stage: "implement", provider: "x", source: "builtin",
                   model: { tier: "prime", reasoning: "high" }, rationale: "r", evidence: "e", fallback: "inline" };
  const r = validateManifest({ ...valid, crew: [member] });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some(e => /crew\[0\]\.model: unknown keys reasoning/.test(e)),
    `expected an unknown-keys error, got ${JSON.stringify(r.errors)}`);
});

test("inline crew member is exempt from the model requirement", () => {
  const inlineMember = { stage: "x", provider: "inline", source: "inline",
                         rationale: "r", evidence: "e", fallback: "inline" };
  const r = validateManifest({ ...valid, crew: [inlineMember] });
  assert.deepEqual(r, { ok: true, errors: [] });
});

test("mergeDisposition is absent by default and that's valid", () => {
  assert.deepEqual(validateManifest(valid), { ok: true, errors: [] });
});

for (const d of ["merge-local", "merge-push", "pr", "keep", "ask"]) {
  test(`mergeDisposition accepts "${d}"`, () => {
    const r = validateManifest({ ...valid, mergeDisposition: d });
    assert.deepEqual(r, { ok: true, errors: [] });
  });
}

test("mergeDisposition rejects an unknown value", () => {
  const r = validateManifest({ ...valid, mergeDisposition: "squash" });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some(e => /mergeDisposition/.test(e) && /merge-local/.test(e) && /ask/.test(e)),
    `expected enum-naming error, got ${JSON.stringify(r.errors)}`);
});

test("mergeDisposition rejects wrong casing", () => {
  const r = validateManifest({ ...valid, mergeDisposition: "PR" });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some(e => /mergeDisposition/.test(e)));
});

test("validateManifest does not inject a default mergeDisposition", () => {
  const m = { ...valid };
  validateManifest(m);
  assert.equal(Object.prototype.hasOwnProperty.call(m, "mergeDisposition"), false);
});

// Per-task `skills` and `surface` are both optional. A manifest that omits them
// entirely (the `valid` fixture above) must keep validating -- backward compat
// for every manifest authored before this schema addition.
test("plan tasks without skills/surface still validate (backward-compat)", () => {
  assert.deepEqual(validateManifest(valid), { ok: true, errors: [] });
});

test("accepts a plan task with well-formed skills and a valid surface", () => {
  const m = {
    ...valid,
    plan: [{
      task: "middleware",
      mode: "single",
      skills: [{ id: "supabase", rationale: "task touches supabase schema" }],
      surface: "integration"
    }]
  };
  assert.deepEqual(validateManifest(m), { ok: true, errors: [] });
});

for (const s of ["ui", "copy", "integration", "none"]) {
  test(`surface accepts "${s}"`, () => {
    const m = { ...valid, plan: [{ task: "middleware", mode: "single", surface: s }] };
    assert.deepEqual(validateManifest(m), { ok: true, errors: [] });
  });
}

test("rejects a malformed skills entry (missing rationale), naming the task", () => {
  const m = {
    ...valid,
    plan: [{
      id: "t3",
      task: "middleware",
      mode: "single",
      skills: [{ id: "supabase" }]
    }]
  };
  const r = validateManifest(m);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some(e => /t3/.test(e) && /rationale/.test(e)),
    `expected an error naming the task id and the missing-rationale defect, got ${JSON.stringify(r.errors)}`);
});

test("rejects a skills entry with an empty id", () => {
  const m = {
    ...valid,
    plan: [{
      id: "t3",
      task: "middleware",
      mode: "single",
      skills: [{ id: "  ", rationale: "r" }]
    }]
  };
  const r = validateManifest(m);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some(e => /t3/.test(e) && /id/.test(e)),
    `expected an error naming the task id and the id defect, got ${JSON.stringify(r.errors)}`);
});

test("rejects a non-array skills field", () => {
  const m = { ...valid, plan: [{ id: "t3", task: "middleware", mode: "single", skills: "supabase" }] };
  const r = validateManifest(m);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some(e => /t3/.test(e) && /skills/.test(e)));
});

test("rejects a bad surface value, naming the task", () => {
  const m = { ...valid, plan: [{ id: "t3", task: "middleware", mode: "single", surface: "backend" }] };
  const r = validateManifest(m);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some(e => /t3/.test(e) && /surface/.test(e) && /ui/.test(e) && /none/.test(e)),
    `expected an enum-naming surface error scoped to the task, got ${JSON.stringify(r.errors)}`);
});
