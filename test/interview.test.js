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

// WHY: "by at least 40%" is a real measurable phrasing — a comparative quantifier followed by
// a multi-digit number, and a bare percentage, must both clear the no-success-criteria signal.
test("percentage outcome with comparative quantifier is clear", () => {
  const r = assessOutcome("cut duplicated error-handling lines by at least 40%");
  assert.equal(r.clear, true, "'by at least 40%' is a measurable target and must be clear");
  assert.deepEqual(r.signals, [], "a clear outcome must carry no signals");
});

// WHY: "N consecutive" is a real measurable phrasing (repeat-count over runs) that the narrow
// keyword/single-digit heuristic previously missed entirely.
test("consecutive-run outcome is clear", () => {
  const r = assessOutcome("zero dropped events across 3 consecutive load-test runs");
  assert.equal(r.clear, true, "'3 consecutive' is a measurable target and must be clear");
  assert.deepEqual(r.signals, [], "a clear outcome must carry no signals");
});

// WHY: gate-proven false-pass — a bare measurable keyword ("improve") padded with vague
// intensifiers ("significantly") and no actual number/percent/comparative must NOT clear the
// no-success-criteria signal. A keyword alone is not a metric; it must co-occur with a real
// measurable (digit or comparative) to count.
test("bare measurable keyword with no metric does not clear no-success-criteria", () => {
  const r = assessOutcome("Improve user satisfaction ... significantly across all platforms...");
  assert.equal(r.clear, false, "'improve' with no number/percent/comparative cannot be clear");
  assert.ok(
    r.signals.includes("no-success-criteria"),
    "a bare keyword with no co-occurring measurable must flag no-success-criteria",
  );
});

// WHY: a digit that is part of an identifier or filename (not a standalone measurable number)
// must NOT be mistaken for success criteria — pins the negative case against over-matching.
test("digit inside a filename/identifier does not count as a measurable and stays not clear", () => {
  const r1 = assessOutcome("fix the bug in file2.js");
  assert.equal(r1.clear, false, "a digit embedded in a filename is not a measurable criterion");
  assert.ok(r1.signals.includes("no-success-criteria"), "file2.js must still flag no-success-criteria");

  const r2 = assessOutcome("update config2");
  assert.equal(r2.clear, false, "a digit embedded in an identifier is not a measurable criterion");
  assert.ok(r2.signals.includes("no-success-criteria"), "config2 must still flag no-success-criteria");
});
