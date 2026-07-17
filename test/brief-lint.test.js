import { test } from "node:test";
import assert from "node:assert/strict";
import {
  extractMarkedSections,
  lintBriefReturnCaps,
  findUnmarkedDispatchSignals,
  DISPATCH_SIGNAL_PATTERNS,
  BRIEF_TEMPLATE_MAX_TOKENS,
  RETURN_CONTRACT_MAX_TOKENS,
} from "../src/brief-lint.js";

// speed-tuning item, criterion 3: subagent brief/return discipline lint. Pure marker-
// extraction + budget-check logic only -- test/prompt-lint-briefs.test.js runs the SAME
// module over the real repo's marked prose.

test("BRIEF_TEMPLATE_MAX_TOKENS / RETURN_CONTRACT_MAX_TOKENS are this item's stated budgets", () => {
  assert.equal(BRIEF_TEMPLATE_MAX_TOKENS, 2000);
  assert.equal(RETURN_CONTRACT_MAX_TOKENS, 1000);
});

test("extractMarkedSections: returns the content strictly between a marker pair, excluding the markers themselves", () => {
  const text = "before\n<!-- muster-brief-template:start -->\nTHE BRIEF\n<!-- muster-brief-template:end -->\nafter";
  const sections = extractMarkedSections(text, "brief");
  assert.deepEqual(sections, ["\nTHE BRIEF\n"]);
});

test("extractMarkedSections: finds every marker pair in a file, in order", () => {
  const text = [
    "<!-- muster-return-template:start -->A<!-- muster-return-template:end -->",
    "noise",
    "<!-- muster-return-template:start -->B<!-- muster-return-template:end -->",
  ].join("\n");
  assert.deepEqual(extractMarkedSections(text, "return"), ["A", "B"]);
});

test("extractMarkedSections: an empty file (no markers) returns an empty array", () => {
  assert.deepEqual(extractMarkedSections("no markers here", "brief"), []);
  assert.deepEqual(extractMarkedSections("no markers here", "return"), []);
});

test("extractMarkedSections: throws on an unterminated marker instead of scanning to EOF", () => {
  const text = "<!-- muster-brief-template:start -->\nnever closed";
  assert.throws(() => extractMarkedSections(text, "brief"), /unterminated brief marker/i);
});

test("extractMarkedSections: rejects an unknown kind", () => {
  assert.throws(() => extractMarkedSections("x", "nope"), /unknown kind "nope"/i);
});

test("lintBriefReturnCaps: no findings when every marked span is within budget", () => {
  const files = {
    "a.md": `<!-- muster-brief-template:start -->${"x".repeat(100)}<!-- muster-brief-template:end -->`,
    "b.md": `<!-- muster-return-template:start -->${"y".repeat(100)}<!-- muster-return-template:end -->`,
  };
  const { findings, briefCount, returnCount } = lintBriefReturnCaps(files);
  assert.deepEqual(findings, []);
  assert.equal(briefCount, 1);
  assert.equal(returnCount, 1);
});

test("lintBriefReturnCaps: flags a brief template over 2000 tokens (8000 chars at 4 chars/token)", () => {
  const files = { "over.md": `<!-- muster-brief-template:start -->${"x".repeat(8001)}<!-- muster-brief-template:end -->` };
  const { findings } = lintBriefReturnCaps(files);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].kind, "brief");
  assert.equal(findings[0].path, "over.md");
  assert.ok(findings[0].tokens > BRIEF_TEMPLATE_MAX_TOKENS);
});

test("lintBriefReturnCaps: flags a return-contract template over 1000 tokens (4000 chars at 4 chars/token)", () => {
  const files = { "over.md": `<!-- muster-return-template:start -->${"y".repeat(4001)}<!-- muster-return-template:end -->` };
  const { findings } = lintBriefReturnCaps(files);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].kind, "return");
  assert.ok(findings[0].tokens > RETURN_CONTRACT_MAX_TOKENS);
});

test("lintBriefReturnCaps: a span exactly at the budget does not flag (boundary is inclusive)", () => {
  const files = { "exact.md": `<!-- muster-return-template:start -->${"y".repeat(4000)}<!-- muster-return-template:end -->` };
  const { findings } = lintBriefReturnCaps(files);
  assert.deepEqual(findings, []);
});

test("lintBriefReturnCaps: scans multiple files and aggregates counts across all of them", () => {
  const files = {
    "one.md": `<!-- muster-brief-template:start -->short<!-- muster-brief-template:end -->`,
    "two.md": `<!-- muster-brief-template:start -->short<!-- muster-brief-template:end --><!-- muster-return-template:start -->short<!-- muster-return-template:end -->`,
  };
  const { findings, briefCount, returnCount } = lintBriefReturnCaps(files);
  assert.deepEqual(findings, []);
  assert.equal(briefCount, 2);
  assert.equal(returnCount, 1);
});

// brief-lint-coverage item: the coverage half. A marked-span budget check only ever looks at
// spans an author already wrapped; findUnmarkedDispatchSignals is the mutant-kill-proof half --
// it finds real dispatch-brief/return-contract SIGNALS (a fixed, named regex list; see
// src/brief-lint.js's own comment for the "why fixed, not fuzzy" rationale) that sit OUTSIDE any
// marked span, i.e. exactly what a forgotten marker (new template, or one stripped from an old
// one) looks like. test/brief-lint-coverage.test.js runs this SAME function over the real repo.

test("findUnmarkedDispatchSignals: a signal with no marker anywhere in the file is reported", () => {
  const files = { "agent.md": "## Report back\n- files touched\n- test result" };
  assert.deepEqual(findUnmarkedDispatchSignals(files), [{ path: "agent.md", signal: "report-back-heading" }]);
});

test("findUnmarkedDispatchSignals: the SAME signal wrapped in a return-template marker is not reported", () => {
  const files = {
    "agent.md": "## Report back\n<!-- muster-return-template:start -->\n- files touched\n<!-- muster-return-template:end -->",
  };
  assert.deepEqual(findUnmarkedDispatchSignals(files), []);
});

test("findUnmarkedDispatchSignals: a signal wrapped in the WRONG marker kind still counts as covered (kind mismatch is not this lint's concern)", () => {
  const files = {
    "agent.md": "## Verdict\n<!-- muster-brief-template:start -->\nEnd with VERDICT: PASS or CHANGES_REQUESTED.\n<!-- muster-brief-template:end -->",
  };
  assert.deepEqual(findUnmarkedDispatchSignals(files), []);
});

test("findUnmarkedDispatchSignals: a file with no matching signal at all reports nothing", () => {
  assert.deepEqual(findUnmarkedDispatchSignals({ "plain.md": "nothing to see here" }), []);
});

test("findUnmarkedDispatchSignals: reports one entry per unmarked signal, scanning multiple files", () => {
  const files = {
    "a.md": "## Report back\nunmarked",
    "b.md": "## Verdict\nunmarked",
    "c.md": "## Report back\n<!-- muster-return-template:start -->marked<!-- muster-return-template:end -->",
  };
  const unmarked = findUnmarkedDispatchSignals(files);
  assert.deepEqual(unmarked.map((u) => u.path).sort(), ["a.md", "b.md"]);
});

test("findUnmarkedDispatchSignals: accepts a caller-supplied patterns override (e.g. a synthetic single-pattern test)", () => {
  const files = { "x.md": "SPECIAL SIGNAL here, unmarked" };
  const patterns = [{ name: "custom", re: /SPECIAL SIGNAL/ }];
  assert.deepEqual(findUnmarkedDispatchSignals(files, { patterns }), [{ path: "x.md", signal: "custom" }]);
  assert.deepEqual(findUnmarkedDispatchSignals(files, { patterns: [] }), []);
});

// Review finding (fix loop 1): a `sectionOwned` heading immediately followed by a trivially
// small marked span, with the section's REAL content left unmarked afterward, used to read as
// "covered" -- the heading-adjacency check alone never verified the marker actually reached the
// end of the section it names. Closed by requiring the section's non-whitespace content (heading
// to next `## ` heading or EOF) to be fully accounted for by marker span(s), not just grazed.
test("findUnmarkedDispatchSignals: a tiny marked span does not cover a huge UNMARKED tail left in the same sectionOwned section (review finding)", () => {
  const bloat = "x".repeat(20000); // ~5000 tokens -- 5x the return-contract budget, and it must never silently pass
  const files = {
    "gamed.md": `## Report back\n<!-- muster-return-template:start -->ok<!-- muster-return-template:end -->\n${bloat}\n`,
  };
  assert.deepEqual(findUnmarkedDispatchSignals(files), [{ path: "gamed.md", signal: "report-back-heading" }]);
  // The budget check alone (over just the marked span) would have missed this entirely --
  // confirms the two guards are catching different things, not duplicating one check.
  const { findings, returnCount } = lintBriefReturnCaps(files);
  assert.deepEqual(findings, []);
  assert.equal(returnCount, 1);
});

// A section legitimately holding MORE THAN ONE marker (muster-runner.md's "## Dispatch contract"
// heading owns both a brief-template span and a return-template span, separated by a blank
// line) must still read as fully covered -- the fix for the finding above must not regress this
// real, intentional shape into a false "unmarked" report.
test("findUnmarkedDispatchSignals: a sectionOwned heading covering MULTIPLE markers (brief then return) in sequence is fully covered", () => {
  const files = {
    "multi.md": [
      "## Dispatch contract",
      "",
      "<!-- muster-brief-template:start -->",
      "brief content",
      "<!-- muster-brief-template:end -->",
      "",
      "<!-- muster-return-template:start -->",
      "return content",
      "<!-- muster-return-template:end -->",
    ].join("\n"),
  };
  assert.deepEqual(findUnmarkedDispatchSignals(files), []);
});

// Review finding (fix loop 1): `re.exec(text)` on a non-global regex only ever returns the FIRST
// match -- a repeated signal (e.g. two "## Report back" sections, one marked, one added later
// unmarked) would have the second occurrence silently invisible. Closed by scanning every match.
test("findUnmarkedDispatchSignals: a REPEATED signal is checked independently per occurrence -- a marked first one does not hide an unmarked second one (review finding)", () => {
  const files = {
    "twice.md": [
      "## Report back",
      "<!-- muster-return-template:start -->",
      "- marked one",
      "<!-- muster-return-template:end -->",
      "",
      "## Iron rules",
      "some other section",
      "",
      "## Report back",
      "- a second, unmarked Report back section added later",
    ].join("\n"),
  };
  assert.deepEqual(findUnmarkedDispatchSignals(files), [{ path: "twice.md", signal: "report-back-heading" }]);
});

test("DISPATCH_SIGNAL_PATTERNS: exposes at least the headings/phrases this item catalogued as real dispatch sites", () => {
  const names = DISPATCH_SIGNAL_PATTERNS.map((p) => p.name);
  for (const expected of [
    "dispatch-contract-heading",
    "report-back-heading",
    "verdict-heading",
    "return-contract-heading",
    "request-response-shapes-heading",
    "go-spec-gate-return-contract",
    "audit-sweep-return-contract",
    "review-gate-full-brief-identity",
    "review-gate-fast-path-brief-identity",
    "tournament-synthesizer-prompt",
    "tournament-judge-scoring-shape",
  ]) {
    assert.ok(names.includes(expected), `expected DISPATCH_SIGNAL_PATTERNS to include "${expected}"`);
  }
});
