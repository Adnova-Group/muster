import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { assessOutcome } from "../src/interview.js";

// Interview domain: the deterministic gap-check end-to-end, and the command/skill wiring
// that turns a thin outcome into an interview (attended) or a recorded gap (unattended).

test("assessOutcome gates the interview: thin -> not clear, rich -> clear", () => {
  assert.equal(assessOutcome("fix it").clear, false);
  assert.ok(assessOutcome("fix it").signals.includes("too-short"));
  assert.equal(assessOutcome("reduce checkout API p95 latency to under 300ms for mobile users").clear, true);
});

test("plan.md runs the gap-check + interview as its front half, before routing", async () => {
  // plan.md is the canonical home; the run.md alias was retired in 0.7.0.
  const plan = await readFile(new URL("../plugin/commands/plan.md", import.meta.url), "utf8");
  assert.match(plan, /muster assess/, "plan must run the assess gap-check");
  assert.match(plan, /\binterview\b/, "plan must invoke the interview skill");
  // the assess/interview must precede the router invocation (anchor on the invocation,
  // not the bare word "router" which also appears in the frontmatter description)
  assert.ok(plan.indexOf("muster assess") < plan.indexOf("the **router** skill"), "assess must come before routing");
});

test("go.md triggers the interview on a gap, but never blocks when unattended", async () => {
  // go.md is the canonical hands-off runner; the autopilot.md alias was retired
  // in 0.7.0.
  const go = await readFile(new URL("../plugin/commands/go.md", import.meta.url), "utf8");
  assert.match(go, /muster assess/, "go must run the gap-check");
  assert.match(go, /\binterview\b/, "go must reference the interview for attended gaps");
  // unattended path records the gap rather than interviewing
  assert.match(go, /Unattended|Routine/, "go must keep the unattended subsection");
  assert.match(go, /run report|STATE/, "unattended gap must be recorded, not block");
});

test("the interview skill uses AskUserQuestion and holds a hard approval gate", async () => {
  const skill = await readFile(new URL("../plugin/skills/interview/SKILL.md", import.meta.url), "utf8");
  assert.match(skill, /AskUserQuestion/, "interview must use the AskUserQuestion selection UI");
  assert.match(skill, /HARD GATE|hard gate|approv/i, "interview must gate routing on approval");
  assert.match(skill, /success ?criteria/i, "interview must gather success criteria");
});
