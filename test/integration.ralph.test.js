import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { loopState } from "../src/loop.js";

// Ralph domain: the loop-until-done primitive drives orchestration, and the
// orchestration surfaces (orchestrator skill, autopilot command) actually wire it in.

test("the ralph loop drives orchestration until done or the cap escalates", () => {
  // iterate while there is work and budget left
  assert.equal(loopState({ iteration: 0, maxIterations: 25, done: false }).continue, true);
  // a satisfied gate ends the loop cleanly
  assert.deepEqual(loopState({ iteration: 4, done: true }), { continue: false, reason: "done" });
  // the cap escalates instead of looping forever
  assert.deepEqual(loopState({ iteration: 25, maxIterations: 25, done: false }), { continue: false, reason: "max-iterations" });
});

test("orchestration surfaces wire the ralph loop primitive by name", async () => {
  const surfaces = [
    new URL("../plugin/skills/orchestrator/SKILL.md", import.meta.url),
    new URL("../plugin/commands/autopilot.md", import.meta.url)
  ];
  for (const url of surfaces) {
    const text = await readFile(url, "utf8");
    assert.match(text, /loopState/, `${url.pathname} must reference loopState`);
    assert.match(text, /src\/loop\.js/, `${url.pathname} must point at src/loop.js`);
  }
});
