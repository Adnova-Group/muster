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

test("run.md runs the gap-check + interview as its front half, before routing", async () => {
  const run = await readFile(new URL("../plugin/commands/run.md", import.meta.url), "utf8");
  assert.match(run, /muster assess/, "run must run the assess gap-check");
  assert.match(run, /\binterview\b/, "run must invoke the interview skill");
  // the assess/interview must precede the router invocation (anchor on the invocation,
  // not the bare word "router" which also appears in the frontmatter description)
  assert.ok(run.indexOf("muster assess") < run.indexOf("the **router** skill"), "assess must come before routing");
});

test("autopilot triggers the interview on a gap, but never blocks when unattended", async () => {
  const auto = await readFile(new URL("../plugin/commands/autopilot.md", import.meta.url), "utf8");
  assert.match(auto, /muster assess/, "autopilot must run the gap-check");
  assert.match(auto, /\binterview\b/, "autopilot must reference the interview for attended gaps");
  // unattended path records the gap rather than interviewing
  assert.match(auto, /Unattended|Routine/, "autopilot must keep the unattended subsection");
  assert.match(auto, /run report|STATE/, "unattended gap must be recorded, not block");
});

test("the interview skill uses AskUserQuestion and holds a hard approval gate", async () => {
  const skill = await readFile(new URL("../plugin/skills/interview/SKILL.md", import.meta.url), "utf8");
  assert.match(skill, /AskUserQuestion/, "interview must use the AskUserQuestion selection UI");
  assert.match(skill, /HARD GATE|hard gate|approv/i, "interview must gate routing on approval");
  assert.match(skill, /success ?criteria/i, "interview must gather success criteria");
});
