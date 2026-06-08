import { test } from "node:test";
import assert from "node:assert/strict";
import { assessOutcome } from "../src/interview.js";

// WHY: a thin two-word imperative gives the router nothing measurable to plan against —
// it must be flagged both for length and for the absence of any success criterion.
test("thin outcome 'fix it' is not clear and flags length + missing criteria", () => {
  const r = assessOutcome("fix it");
  assert.equal(r.clear, false, "two meaningful words with no metric cannot be clear");
  assert.ok(r.signals.includes("too-short"), "fewer than 6 meaningful words must flag too-short");
  assert.ok(
    r.signals.includes("no-success-criteria"),
    "no number or criteria keyword must flag no-success-criteria",
  );
});

// WHY: a bare vague verb with a hand-wavy qualifier is the canonical case the interview
// exists to catch — it must additionally fire vague-only on top of the other two signals.
test("bare/vague 'make it better' flags vague-only", () => {
  const r = assessOutcome("make it better");
  assert.equal(r.clear, false, "a bare vague instruction cannot be clear");
  assert.ok(r.signals.includes("vague-only"), "vague verb + short + no criteria must flag vague-only");
});

// WHY: a fully specified outcome carries a number, a domain keyword, and enough length —
// the heuristic must NOT send a routable outcome to a needless interview.
test("rich outcome with number + latency keyword + length is clear", () => {
  const r = assessOutcome("reduce checkout API p95 latency to under 300ms for mobile users");
  assert.equal(r.clear, true, "a quantified, keyworded, long-enough outcome must be clear");
  assert.deepEqual(r.signals, [], "a clear outcome must carry no signals");
});

// WHY: an explicit criterion word ('metric') plus a number must satisfy the criteria check
// even for a longer prose outcome — guards against over-flagging well-formed requests.
test("specified outcome with explicit criterion word is clear", () => {
  const r = assessOutcome(
    "add CSV export to the reports page with a success metric of 95% of exports completing under 5 seconds",
  );
  assert.equal(r.clear, true, "an outcome stating a measurable success metric must be clear");
});

// WHY: empty and non-string input is degenerate — the router must get a definite not-clear
// answer rather than a crash, so the interview can ask for an outcome at all.
test("empty string is not clear and flags empty", () => {
  const r = assessOutcome("");
  assert.equal(r.clear, false, "an empty outcome cannot be clear");
  assert.ok(r.signals.includes("empty"), "empty input must flag empty");
});

test("non-string input is not clear and flags empty", () => {
  const r = assessOutcome(null);
  assert.equal(r.clear, false, "null is not a routable outcome");
  assert.ok(r.signals.includes("empty"), "non-string input must flag empty");
});
