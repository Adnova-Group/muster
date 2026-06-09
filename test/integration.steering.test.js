import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { classifySteer } from "../src/steer.js";

// Steering domain: channel messages map to discrete actions, and the orchestrator
// skill actually wires that classifier in with the right per-action semantics.

test("the documented steering actions classify end-to-end", () => {
  assert.equal(classifySteer("approved, continue").action, "approve");
  assert.equal(classifySteer("stop the run").action, "stop");
  assert.equal(classifySteer("what's the status?").action, "status");
  assert.equal(classifySteer("do the billing task instead").action, "retarget");
  assert.equal(classifySteer("hi there").action, "unknown");
});

test("the orchestrator skill wires channel steering through classifySteer", async () => {
  const text = await readFile(new URL("../plugin/skills/orchestrator/SKILL.md", import.meta.url), "utf8");
  assert.match(text, /classifySteer/, "orchestrator must classify channel events via classifySteer");
  // the canonical invocation is the CLI form; src/steer.js may appear as an implementation note
  assert.match(text, /muster steer/, "orchestrator must reference the CLI steer subcommand");
  assert.match(text, /<channel/, "orchestrator must handle <channel> events");
  // every action the classifier can return must have a documented orchestrator behavior
  for (const action of ["approve", "stop", "status", "retarget", "unknown"]) {
    assert.match(text, new RegExp(`\\b${action}\\b`), `orchestrator must document the "${action}" action`);
  }
});

test("steering never silently re-scopes the run (iron rule)", async () => {
  const text = await readFile(new URL("../plugin/skills/orchestrator/SKILL.md", import.meta.url), "utf8");
  // retarget is logged as a follow-up, not applied; the manifest stays the single source
  assert.match(text, /re-scope|rescope|single source/i, "orchestrator must forbid silent re-scoping via channel");
});
