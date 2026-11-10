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

// Revival stage 2b: `muster preflight` runs the assess gap-check (its `clear`/`unclear` fields),
// and the commands ask the interview questions in one AskUserQuestion that writes CONTEXT.md.
test("plan.md runs the gap-check + interview before the planner", async () => {
  const plan = await readFile(new URL("../plugin/commands/plan.md", import.meta.url), "utf8");
  assert.match(plan, /M preflight/, "plan must run preflight (scope + assess in one call)");
  assert.match(plan, /`clear` is false[\s\S]{0,200}AskUserQuestion/, "plan must interview on a gap");
  assert.match(plan, /CONTEXT\.md/, "interview answers must land in CONTEXT.md");
  assert.ok(plan.indexOf("AskUserQuestion built from `unclear`") < plan.indexOf('Workflow({name:"muster:make-plan"'), "the interview must come before planning");
});

test("go.md triggers the interview on a gap, but never blocks when unattended", async () => {
  const go = await readFile(new URL("../plugin/commands/go.md", import.meta.url), "utf8");
  assert.match(go, /M preflight/, "go must run the gap-check via preflight");
  assert.match(go, /`clear` is false and a human is present[\s\S]{0,200}AskUserQuestion/, "go must interview attended gaps");
  assert.match(go, /Unattended: write the gaps as assumptions/, "unattended gap must be recorded, not block");
});

test("the interview skill uses AskUserQuestion and holds a hard approval gate", async () => {
  const skill = await readFile(new URL("../plugin/skills/interview/SKILL.md", import.meta.url), "utf8");
  assert.match(skill, /AskUserQuestion/, "interview must use the AskUserQuestion selection UI");
  assert.match(skill, /HARD GATE|hard gate|approv/i, "interview must gate routing on approval");
  assert.match(skill, /success ?criteria/i, "interview must gather success criteria");
});
