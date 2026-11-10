// The plan-checker's muster calibration (live e2e 2026-11-10). The checker is adapted from
// gsd-core with byte-exact verbatim regions, so muster's calibration must live OUTSIDE them;
// these tests pin that it exists there and says what the gate depends on.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const read = (p) => readFile(new URL(`../plugin/agents/${p}`, import.meta.url), "utf8");
// Text outside every <!-- verbatim ... --> ... <!-- /verbatim --> region.
const outsideVerbatim = (s) => s.replace(/<!-- verbatim:[^>]*-->[\s\S]*?<!-- \/verbatim -->/g, "");

test("checker: downstream defences and the blocker-only gate are muster text, outside verbatim regions", async () => {
  const own = outsideVerbatim(await read("muster-plan-checker.md"));
  assert.match(own, /<downstream_defences>[\s\S]*muster-test-writer[\s\S]*muster-reviewer[\s\S]*muster-integration-checker[\s\S]*muster-verifier[\s\S]*merge-wave[\s\S]*<\/downstream_defences>/);
  assert.match(own, /The executor never authors a tdd task's tests\./);
  assert.match(own, /\*\*Only a BLOCKER holds the gate\.\*\* A WARNING never blocks, never forces a revision and never counts toward the stall rule/);
});

test("checker: a malicious-implementer hole is a warning unless it names a concrete input AND why nothing downstream catches it", async () => {
  const own = outsideVerbatim(await read("muster-plan-checker.md"));
  assert.match(own, /a hole is a WARNING at most, unless the summary names BOTH:\n1\. a concrete, plausible input/);
  assert.match(own, /2\. why no stage in `<downstream_defences>` would catch it/);
  assert.match(own, /"any finite set of tests or gates can be beaten by hard-coding the asserted values"/);
  assert.match(own, /"the executor authors the test file that judges it" on a `tdd="true"` task/);
  assert.doesNotMatch(own, /BLOCKER when the outcome could go undelivered with every gate green/, "the old unconditional blocker rule is gone");
});

test("checker: tool-output framing tags are not file content; stray tags are plan-lint's call", async () => {
  const own = outsideVerbatim(await read("muster-plan-checker.md"));
  assert.match(own, /framing tags \(`<output>`, `<\/output>`, `<persisted-output>`, …\) that are not in the file\. Never report a tag plan-lint does not report/);
});

test("planner and checker: independent tasks share the tracer's wave; no sequencing-only depends_on", async () => {
  const planner = outsideVerbatim(await read("muster-planner.md"));
  assert.match(planner, /\*\*Waves follow real dependencies, not the tracer\.\*\*/);
  assert.match(planner, /Never add a `depends_on` only to sequence after the tracer\./);
  assert.match(planner, /set `tracer: false` and put them all in wave 1/);
  assert.doesNotMatch(planner, /every other task sits in a later wave/);
  const checker = outsideVerbatim(await read("muster-plan-checker.md"));
  assert.match(checker, /never ask for a `depends_on` that only sequences/);
});
