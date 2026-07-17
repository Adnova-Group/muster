// speed-tuning item, criterion 1: /muster:plan wires the SAME pre-router fast-path check
// go.md step 3 already carries (weight-reduction item) -- weight-reduction wired go.md
// only, leaving plan.md (the approve-first entry point) always paying the router skill's
// full crew-assembly pass even for a trivially small/single-task outcome. This is the
// lever that gives a bare `/muster:plan` on a 1-task outcome a shot at the <=15k-token
// budget (eval/perf/replay-plan-budget.mjs measures the real number).
//
// Mirrors test/hotpath-cli-resolution.test.js's prose-assertion style: this is a markdown
// file, not an importable module, so the wiring is asserted by scanning its text for the
// same load-bearing substrings go.md's own fast-path branch carries.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const root = new URL("../", import.meta.url);
const read = (p) => readFile(new URL(p, root), "utf8");

test("plan.md runs the fast-path score check before assembling the crew", async () => {
  const plan = await read("plugin/commands/plan.md");
  assert.match(plan, /\$MUSTER_CLI fast-path "\$ARGUMENTS"/, "plan.md must run the fast-path score check via $MUSTER_CLI");
  assert.match(plan, /scoreOutcomeForFastPath/, "plan.md must cite src/fast-path.js's scoreOutcomeForFastPath as the mechanism");
});

test("plan.md skips the router skill entirely when the fast-path check scores eligible", async () => {
  const plan = await read("plugin/commands/plan.md");
  assert.match(plan, /eligible:\s*true/, "plan.md must branch on eligible: true");
  assert.match(plan, /SKIP invoking\s+the router skill entirely/i, "plan.md must state the router skip explicitly, matching go.md's wording");
  assert.match(
    plan,
    /\$MUSTER_CLI fast-path "\$ARGUMENTS" --capabilities \.muster\/capabilities\.json/,
    "plan.md must build the fast-path manifest via the --capabilities flag, same as go.md"
  );
});

test("plan.md narrows the capabilities capture to --roles-only on the eligible branch (the fast-path manifest only ever reads implement/code-review)", async () => {
  const plan = await read("plugin/commands/plan.md");
  assert.match(
    plan,
    /\$MUSTER_CLI capabilities --roles-only/,
    "plan.md's eligible branch must request the compact --roles-only capabilities dump, not the full inventory"
  );
});

test("plan.md still invokes the router skill on the not-eligible branch, unchanged (criterion 5: no gate weakens for real multi-task work)", async () => {
  const plan = await read("plugin/commands/plan.md");
  assert.match(plan, /eligible:\s*false/, "plan.md must branch on eligible: false");
  assert.match(plan, /invoke the \*\*router\*\* skill/i, "plan.md must still invoke the router skill on the not-eligible branch");
});

test("plan.md's fast-path branch runs before the router-invocation step, not after (the router must never run for an eligible outcome)", async () => {
  const plan = await read("plugin/commands/plan.md");
  const fastPathIdx = plan.indexOf("$MUSTER_CLI fast-path \"$ARGUMENTS\"");
  const routerIdx = plan.search(/invoke the \*\*router\*\* skill/i);
  assert.ok(fastPathIdx >= 0, "plan.md must run the bare fast-path score check");
  assert.ok(routerIdx >= 0, "plan.md must still name the router-invocation step");
  assert.ok(fastPathIdx < routerIdx, "the fast-path score check must be recorded before the router-invocation step in reading order");
});
