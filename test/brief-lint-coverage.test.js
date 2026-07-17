// brief-lint-coverage item: closes the gap the original speed-tuning lint left open. Marking a
// brief/return-contract template was always OPT-IN (an author wraps it in
// `<!-- muster-brief-template:... -->` / `<!-- muster-return-template:... -->`, then
// lintBriefReturnCaps budget-checks only what got wrapped) -- nothing caught a real dispatch site
// that never got wrapped in the first place, or a marker accidentally stripped from one that
// used to be. This is that missing half: `findUnmarkedDispatchSignals` (src/brief-lint.js) scans
// for a fixed, named list of regex SIGNALS -- each one a heading or literal phrase that, by
// inspection of every dispatch site currently in plugin/agents, plugin/commands, and
// plugin/skills, reliably identifies real per-dispatch brief/return-contract prose -- and flags
// any match sitting outside a marked span.
//
// Two halves, both required:
//   1. The REAL repo must have zero unmarked signal matches (below) -- every dispatch site this
//      lint already knows how to recognize is, in fact, marked and therefore budget-checked.
//   2. A SYNTHETIC fixture proves the detector isn't vacuous: an unmarked "## Report back"
//      section -- the exact shape a new muster-*.md agent copy-pasting the established
//      convention, but forgetting the marker, would produce -- must fail (test/brief-lint.test.js
//      carries this as a unit-level mutant-kill proof against a minimal fixture; this file proves
//      the same detector against the real corpus).
import { test } from "node:test";
import assert from "node:assert/strict";
import { findUnmarkedDispatchSignals, DISPATCH_SIGNAL_PATTERNS, lintBriefReturnCaps } from "../src/brief-lint.js";
import { proseFiles, readProseFiles } from "../test-support/brief-lint-corpus.js";

test("every recognized dispatch-brief/return-contract signal in the real corpus is marked (coverage, not just budget)", async () => {
  const paths = await proseFiles();
  assert.ok(paths.length >= 20, `sanity: expected ~20+ prose files in scope, found ${paths.length}`);
  const filesByPath = await readProseFiles();

  const unmarked = findUnmarkedDispatchSignals(filesByPath);
  assert.deepEqual(
    unmarked,
    [],
    `expected every known dispatch-brief/return-contract signal to sit inside a marked span, found unmarked: ${JSON.stringify(unmarked, null, 2)}`
  );

  // A real dispatch site is only meaningfully "covered" if it is BOTH recognized (this test) AND
  // budget-checked (test/prompt-scan-brief-lint.test.js) -- the two guards must be looking at
  // matching, non-trivial content, not each independently passing on an empty corpus.
  const { briefCount, returnCount } = lintBriefReturnCaps(filesByPath);
  assert.ok(briefCount > 0 && returnCount > 0, "expected non-trivial marked content behind the signal sweep");
});

test("DISPATCH_SIGNAL_PATTERNS actually matches something in the real corpus per pattern (no dead/stale signal)", async () => {
  const filesByPath = await readProseFiles();
  const combinedText = Object.values(filesByPath).join("\n");
  const deadPatterns = DISPATCH_SIGNAL_PATTERNS.filter(({ re }) => !re.test(combinedText)).map((p) => p.name);
  assert.deepEqual(deadPatterns, [], `expected every DISPATCH_SIGNAL_PATTERNS entry to match at least one real file, dead: ${deadPatterns}`);
});

test("mutant proof: a NEW unmarked dispatch site (a copy-pasted '## Report back' section with no marker) fails coverage", () => {
  const fixture = {
    "plugin/agents/muster-hypothetical-new-agent.md": [
      "---",
      "name: muster-hypothetical-new-agent",
      "---",
      "You are a hypothetical new muster agent, dispatched like any other.",
      "",
      "## Report back",
      "- Files touched, one line each.",
      "- Test command run + result.",
    ].join("\n"),
  };
  const unmarked = findUnmarkedDispatchSignals(fixture);
  assert.deepEqual(unmarked, [{ path: "plugin/agents/muster-hypothetical-new-agent.md", signal: "report-back-heading" }]);
});

test("mutant-fixed proof: the SAME fixture, once wrapped in the return-template marker, clears coverage", () => {
  const fixture = {
    "plugin/agents/muster-hypothetical-new-agent.md": [
      "---",
      "name: muster-hypothetical-new-agent",
      "---",
      "You are a hypothetical new muster agent, dispatched like any other.",
      "",
      "## Report back",
      "<!-- muster-return-template:start -->",
      "- Files touched, one line each.",
      "- Test command run + result.",
      "<!-- muster-return-template:end -->",
    ].join("\n"),
  };
  assert.deepEqual(findUnmarkedDispatchSignals(fixture), []);
});

test("a marker stripped from a previously-covered file (regression) is caught the same way as a never-marked one", () => {
  const withMarker = [
    "## Verdict",
    "<!-- muster-return-template:start -->",
    "End with exactly one line: `VERDICT: PASS` or `VERDICT: CHANGES_REQUESTED`.",
    "<!-- muster-return-template:end -->",
  ].join("\n");
  const markerStripped = ["## Verdict", "End with exactly one line: `VERDICT: PASS` or `VERDICT: CHANGES_REQUESTED`."].join("\n");

  assert.deepEqual(findUnmarkedDispatchSignals({ "fixture.md": withMarker }), []);
  assert.deepEqual(findUnmarkedDispatchSignals({ "fixture.md": markerStripped }), [{ path: "fixture.md", signal: "verdict-heading" }]);
});
