// Coverage for plugin/skills/review-gate/verdict.schema.json + src/verdict-schema.js
// (backlog item structured-output-binding). Two things are pinned:
//
// 1. Schema<->code coherence: every array this schema calls valid is accepted by
//    src/review.js's tallyReview without throwing, and tallies the way the shape
//    implies. This is a ONE-DIRECTIONAL pin -- tallyReview intentionally tolerates
//    several shapes OUTSIDE the schema (a defensive parsing fallback for a malformed
//    real-world emission, see src/review.js's own header comment), so the reverse
//    ("everything tallyReview accepts is schema-valid") is never asserted.
// 2. Malformed-emission regression: representative bad shapes -- the exact ones a
//    prose-instructed reviewer could plausibly emit -- fail validation at the schema
//    layer, before tallyReview (or any other consumer) ever sees them.
import { test } from "node:test";
import assert from "node:assert/strict";
import { tallyReview } from "../src/review.js";
import { loadVerdictSchema, validateAgainstSchema, VERDICT_SCHEMA_PATH } from "../src/verdict-schema.js";

test("the schema file exists, parses, and is an array schema with the two documented branches", async () => {
  const schema = await loadVerdictSchema();
  assert.equal(schema.type, "array");
  assert.equal(schema.items.oneOf.length, 2, "schema must define exactly the findings-entry and status-entry branches");
  assert.ok(VERDICT_SCHEMA_PATH.endsWith("plugin/skills/review-gate/verdict.schema.json"));
});

// ── 1. schema<->code coherence (schema-valid -> tallyReview accepts it) ──────────
const SCHEMA_VALID_CASES = [
  { name: "empty array", verdicts: [] },
  {
    name: "single reviewer, no findings",
    verdicts: [{ reviewer: "a", findings: [] }],
  },
  {
    name: "single reviewer, mixed severities",
    verdicts: [
      { reviewer: "a", findings: [
        { severity: "blocker", note: "real bug" },
        { severity: "risk", note: "watch this" },
        { severity: "nit", note: "style" }
      ] }
    ],
  },
  {
    name: "two reviewers, one clean one blocked",
    verdicts: [
      { reviewer: "code-review", findings: [{ severity: "nit", note: "n" }] },
      { reviewer: "security-review", findings: [{ severity: "blocker", note: "boom" }] }
    ],
  },
  {
    name: "exhausted status entry, no findings",
    verdicts: [{ reviewer: "b", status: "exhausted" }],
  },
  {
    name: "absent status entry, no findings",
    verdicts: [{ reviewer: "c", status: "absent" }],
  },
  {
    name: "mixed: one ordinary verdict alongside one exhausted entry",
    verdicts: [
      { reviewer: "a", findings: [{ severity: "risk", note: "r" }] },
      { reviewer: "b", status: "exhausted" }
    ],
  },
];

for (const { name, verdicts } of SCHEMA_VALID_CASES) {
  test(`coherence: schema-valid shape "${name}" validates ok AND tallyReview accepts it without throwing`, async () => {
    const schema = await loadVerdictSchema();
    const result = validateAgainstSchema(schema, verdicts);
    assert.deepEqual(result.errors, [], `expected schema-valid, got errors: ${JSON.stringify(result.errors)}`);
    assert.equal(result.ok, true);

    assert.doesNotThrow(() => tallyReview(verdicts));
    const tally = tallyReview(verdicts);
    // Sanity on the two status-bearing cases: a schema-valid status entry always
    // forces blocked:true with a named reason, per the exhaustion contract.
    if (verdicts.some((v) => v.status === "exhausted" || v.status === "absent")) {
      assert.equal(tally.blocked, true, `${name}: a schema-valid status entry must force blocked:true`);
      assert.ok(tally.blockedReasons.length > 0);
    }
  });
}

// ── 2. malformed-emission regression (schema-invalid -> fails at the schema layer) ─
const SCHEMA_INVALID_CASES = [
  {
    name: "finding missing severity",
    verdicts: [{ reviewer: "a", findings: [{ note: "no severity given" }] }],
  },
  {
    name: "finding missing note",
    verdicts: [{ reviewer: "a", findings: [{ severity: "blocker" }] }],
  },
  {
    name: "wrong severity enum (a hallucinated severity)",
    verdicts: [{ reviewer: "x", findings: [{ severity: "critical", note: "not a recognized severity" }] }],
  },
  {
    // The exact dogfood shape review.js's own tests reproduce (PR #82's incident):
    // a killed reviewer's entry stuffed with spoofed findings alongside its status.
    // tallyReview defensively discards the findings; the SCHEMA still calls this
    // malformed, because a well-formed emission never mixes the two branches.
    name: "spoofed severity on an exhausted entry (status + findings together)",
    verdicts: [{ reviewer: "b", status: "exhausted", findings: [
      { severity: "blocker", note: "synthetic blocker fed alongside exhaustion" }
    ] }],
  },
  {
    name: "wrong status enum (not exhausted/absent)",
    verdicts: [{ reviewer: "c", status: "on-vacation" }],
  },
  {
    name: "entry with neither findings nor status",
    verdicts: [{ reviewer: "d" }],
  },
  {
    name: "status entry missing the reviewer name",
    verdicts: [{ status: "exhausted" }],
  },
  {
    name: "findings entry missing the reviewer name",
    verdicts: [{ findings: [{ severity: "nit", note: "n" }] }],
  },
  {
    name: "top level is not an array",
    verdicts: { reviewer: "a", findings: [] },
  },
];

for (const { name, verdicts } of SCHEMA_INVALID_CASES) {
  test(`malformed emission: "${name}" fails validation at the schema layer`, async () => {
    const schema = await loadVerdictSchema();
    const result = validateAgainstSchema(schema, verdicts);
    assert.equal(result.ok, false, `expected schema-invalid for "${name}"`);
    assert.ok(result.errors.length > 0);
  });
}

// tallyReview's OWN defensive tolerance is a separate, already-covered contract
// (test/review.test.js pins it directly against the dogfood incident); this file
// only asserts the schema layer catches the malformed shape BEFORE that tolerance
// is ever exercised -- confirmed here for the two dogfood-shaped cases so the
// schema<->code relationship (schema is the stricter, code is the defensive floor)
// is provable from one file, not just narrated.
test("the dogfood spoofed-severity shape is schema-invalid even though tallyReview tolerates it at runtime", async () => {
  const verdicts = [{ reviewer: "b", status: "exhausted", findings: [
    { severity: "blocker", note: "synthetic blocker fed by the orchestrator, not a real finding" }
  ] }];
  const schema = await loadVerdictSchema();
  assert.equal(validateAgainstSchema(schema, verdicts).ok, false);

  const tally = tallyReview(verdicts);
  assert.equal(tally.blocked, true);
  assert.deepEqual(tally.counts, { blocker: 0, risk: 0, nit: 0 }, "tallyReview must still discard the spoofed finding");
});
