import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

// Unattended domain: when fired by a Routine there is no human, so go's finish
// step must be non-interactive with safe defaults, and the README must tell operators how.

test("go.md documents an unattended Routine mode with safe finish defaults", async () => {
  // go.md is the canonical hands-off runner now (autopilot.md is a legacy alias stub —
  // see the alias-shape/alias-guidance checks in test/mode-evals.test.js).
  const text = await readFile(new URL("../plugin/commands/go.md", import.meta.url), "utf8");
  assert.match(text, /unattended/i, "go must document unattended mode");
  assert.match(text, /routine/i, "go must tie unattended mode to Routines");
  assert.match(text, /\bPR\b|pull request/i, "unattended default must be opening a PR");
  // autonomy stops at the reviewable artifact: never auto-merge / push to base
  assert.match(text, /never[^.]*(auto-?merge|push)/i, "go must forbid auto-merge/push in unattended mode");
  // escalations surface via the run report, not an interactive prompt
  assert.match(text, /escalat/i, "go must say how escalations surface unattended");
});

test("public docs explain driving muster remotely over Claude Code's native transport", async () => {
  // the remote-driving deep-dive lives in the architecture doc (the public README stays lean)
  const text = await readFile(new URL("../docs/architecture.md", import.meta.url), "utf8");
  for (const feature of ["Routine", "Channel", "Remote Control"]) {
    assert.match(text, new RegExp(feature, "i"), `architecture doc must mention ${feature}`);
  }
  assert.match(text, /Claude Code's own features|not a transport [Mm]uster ships|rides|native/i, "must state muster uses CC's transport, not its own");
});
