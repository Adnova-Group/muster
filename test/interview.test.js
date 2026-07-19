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
// WHY (backlog item codex-assess-criteria-detect, 2026-07-18 Codex dogfood): a real code
// outcome carrying detailed acceptance behavior as PROSE clauses -- not a "Success
// criteria:"-labeled list, not a bare metric -- was flagged no-success-criteria because it
// tripped neither CRITERIA_QUANTIFIED (no digits) nor CRITERIA_KEYWORD (no metric/measure/
// success/criteria/kpi/target/goal/increase/decrease/reduce/improve/conversion/rate/latency/
// throughput word). The outcome text below is the exact dogfood fixture reconstructed from
// the run transcript. It must now be recognized as carrying real criteria via the "fail
// loud" phrase and the labeled verified: true/false field.
const DOGFOOD_RECEIPT_VERIFICATION_OUTCOME =
  "buildBaseShaReceipt in src/wave-dispatch.js validates SHA format but never verifies the SHA " +
  "actually resolves to a real commit. Add real verification: the receipt builder accepts an " +
  "injected verifier that checks the SHA against the repo, receipts record verified: true/false " +
  "plus the verification mechanism, and callers that depend on the receipt fail loud when " +
  "verification is available but fails. TDD; keep the existing fail-loud behavior for malformed SHAs.";

test("dogfood fixture: prose-form code-outcome criteria (fail loud + labeled field) clears no-success-criteria", () => {
  const r = assessOutcome(DOGFOOD_RECEIPT_VERIFICATION_OUTCOME);
  assert.ok(
    !r.signals.includes("no-success-criteria"),
    `prose criteria (fail loud / verified: true/false) must clear no-success-criteria, got signals: ${JSON.stringify(r.signals)}`,
  );
  assert.equal(r.clear, true, "a long, detailed, prose-criteria outcome must be clear");
});

// WHY: realistic variants of the same prose-criteria grammar, not just the one dogfood
// fixture -- an explicit obligation ("must"/"should") and a "fail loud" phrase on their own,
// each without any digit or CRITERIA_KEYWORD word, must independently clear the signal.
test("prose criteria: an explicit obligation ('must'/'should' + verb) clears no-success-criteria on its own", () => {
  const r = assessOutcome(
    "the parser must reject a malformed header and the caller should log the rejection reason before returning",
  );
  assert.ok(!r.signals.includes("no-success-criteria"), "must/should + verb is a concrete acceptance obligation");
});

test("prose criteria: 'fail loud'/'fail-loud' alone clears no-success-criteria", () => {
  const r1 = assessOutcome("the importer should fail loud on a corrupt row instead of silently skipping it");
  assert.ok(!r1.signals.includes("no-success-criteria"), "'fail loud' is a concrete, distinctive acceptance phrase");
  const r2 = assessOutcome("keep the existing fail-loud behavior for a missing config file");
  assert.ok(!r2.signals.includes("no-success-criteria"), "hyphenated 'fail-loud' must also clear the signal");
});

test("prose criteria: a labeled field:value pair (verified: true/false) clears no-success-criteria", () => {
  const r = assessOutcome(
    "the health check response carries a labeled status: ok field so downstream callers can branch on it directly",
  );
  assert.ok(!r.signals.includes("no-success-criteria"), "a structured field:value pair is concrete acceptance data");
});

// WHY: negative control -- a bare colon with no boolean/quoted value after it (ordinary prose
// punctuation, not a labeled field) must NOT be mistaken for structured criteria.
test("prose criteria: an ordinary prose colon with no boolean/quoted value does not clear no-success-criteria", () => {
  const r = assessOutcome("the plan is simple: build a small internal tool for the support team");
  assert.ok(r.signals.includes("no-success-criteria"), "a plain narrative colon must not be read as a labeled field");
});

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

test("Codex assessment accepts spelled-out measurable counts without changing the default heuristic", () => {
  const text = "add task priorities with at least five focused tests and zero failures";
  assert.equal(assessOutcome(text).clear, false, "the default Claude-facing heuristic remains digit-based");
  assert.deepEqual(assessOutcome(text, { codex: true }), { clear: true, signals: [] });
  assert.deepEqual(assessOutcome("deliver zero regressions across supported workflows", { codex: true }), { clear: true, signals: [] });
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

// WHY: CRITERIA_KEYWORD + MEASURABLE_NEARBY is a SEPARATE clearing path from
// CRITERIA_QUANTIFIED — a keyword ("improve"/"conversion"/"rate") co-occurring with a bare
// comparative word ("above", with no number after it) must clear no-success-criteria on its
// own. This outcome carries no digit at all, so CRITERIA_QUANTIFIED (every one of whose
// alternatives requires a \d) structurally cannot be what clears it — pins that the
// keyword+nearby path is independently sufficient, not just a redundant restatement of the
// quantified path.
test("keyword + nearby comparative word (no digit) alone drives clear:true, not via CRITERIA_QUANTIFIED", () => {
  const text = "improve conversion rate above baseline across product lines";
  assert.doesNotMatch(text, /\d/, "fixture must carry no digit, so CRITERIA_QUANTIFIED cannot be what matched");
  const r = assessOutcome(text);
  assert.equal(r.clear, true, "keyword('improve'/'conversion'/'rate') + nearby comparative('above') must clear on their own");
  assert.deepEqual(r.signals, [], "a clear outcome must carry no signals");
});

// WHY: vague-only is deliberately rescued by ANY concrete token (quote/digit/proper-noun) so
// a short, criteria-less, bare-vague-verb outcome that still names something specific isn't
// double-penalized as "vague-only" on top of "too-short"/"no-success-criteria". This is the
// positive rescue case — SPECIFIC must actually suppress vague-only, not just exist unused.
test("a vague verb with a concrete quoted token rescues vague-only (too-short/no-success-criteria still apply)", () => {
  const r = assessOutcome("fix the 'Login' button");
  assert.equal(r.clear, false, "still too-short with no stated success criteria");
  assert.ok(r.signals.includes("too-short"), "3 meaningful words must still flag too-short");
  assert.ok(r.signals.includes("no-success-criteria"), "no metric/keyword must still flag no-success-criteria");
  assert.ok(!r.signals.includes("vague-only"), "a quoted span ('Login') is a concrete token that must rescue vague-only");
});
