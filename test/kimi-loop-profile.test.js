// Kimi loop/background profile prose consistency (wave 2, docs-pin/no-emission).
// Wave 1 decided DOCS-PIN, NO EMISSION: the chosen [loop_control]/[background]
// profile for unattended `kimi -p "/goal …"` runs is documented in
// docs/research/kimi-code-cli.md §11.10, named in plugin/commands/go.md's Kimi
// run-loop block, and src/kimi-install.js carries a comment-only non-emission
// rationale. These tests pin that prose so the three surfaces cannot drift
// apart (e.g. go.md naming a value §11.10 never probed, or the src-side
// rationale silently dropping a knob).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

// --- (a) docs/research/kimi-code-cli.md §11.10 pins every chosen value ------

test("§11.10 exists and names each chosen loop/background value with its citation", async () => {
  const text = await readFile(new URL("../docs/research/kimi-code-cli.md", import.meta.url), "utf8");
  const match = text.match(/^### 11\.10 [^\n]*\n([\s\S]*?)(?=\n## )/m);
  assert.ok(match, "docs/research/kimi-code-cli.md must carry a '### 11.10' section");
  const section = match[1];
  // each knob, with the binary-probed default/semantics it was pinned to
  assert.match(section, /loop_control\.max_steps_per_turn/, "§11.10 must name max_steps_per_turn");
  assert.match(section, /LOOP_MAX_STEPS_EXCEEDED/, "§11.10 must keep the v0.29.1 max-steps abort error as a dated historical note");
  // the 0.30.0 re-probe (2026-07-29) of the step-cap failure mode
  assert.match(section, /re-probed on 0\.30\.0 \(2026-07-29\)/, "§11.10 must date the 0.30.0 step-cap re-probe");
  assert.match(section, /loop\.max_steps_exceeded/, "§11.10 must cite the 0.30.0 turn-level max-steps error");
  assert.match(section, /status:"paused"[\s\S]*?Paused after interruption/, "§11.10 must record the goal's persisted paused state");
  assert.match(section, /exits \*\*1\*\* \(not 6\)/, "§11.10 must pin the exit-1-not-6 print-mode outcome");
  assert.match(section, /genuinely resumable/, "§11.10 must record that the paused goal resumes to completion");
  assert.match(section, /KIMI_LOOP_MAX_STEPS_PER_TURN/, "§11.10 must cite the max-steps env override");
  assert.match(section, /loop_control\.max_retries_per_step/, "§11.10 must name max_retries_per_step");
  assert.match(section, /\?\? 10/, "§11.10 must cite the built-in 10 retry default");
  assert.match(section, /KIMI_LOOP_MAX_RETRIES_PER_STEP/, "§11.10 must cite the retries env override");
  assert.match(section, /loop_control\.reserved_context_size/, "§11.10 must name reserved_context_size");
  assert.match(section, /reservedContextSize = 5e4/, "§11.10 must cite the 50000 reserved-context default");
  assert.match(section, /background\.max_running_tasks/, "§11.10 must name max_running_tasks");
  assert.match(section, /Too many background tasks are already running\./, "§11.10 must cite the admission-cap dispatch error");
  assert.match(section, /KIMI_CODE_BACKGROUND_MAX_RUNNING_TASKS/, "§11.10 must cite the max-tasks env override");
  assert.match(section, /background\.print_background_mode/, "§11.10 must name print_background_mode");
  assert.match(section, /`steer` is the default when nothing is set/, "§11.10 must pin steer as the default print_background_mode");
  assert.match(section, /keep_alive_on_exit = true[\s\S]*?drain/, "§11.10 must flag the legacy keep_alive_on_exit -> drain hazard");
  // the docs-pin decision itself, with the no-emission rationale
  assert.match(section, /NOT emitted into config\.toml/, "§11.10 must state the no-emission decision");
  assert.match(section, /no project-level `config\.toml` override/, "§11.10 must cite user-global-only config as the reason");
});

// --- (b) plugin/commands/go.md's Kimi run-loop block names the profile -----

test("go.md's Kimi run-loop block names the chosen loop/background profile values", async () => {
  const go = await readFile(new URL("../plugin/commands/go.md", import.meta.url), "utf8");
  const match = go.match(/\*\*Kimi loop\/background profile[^\n]*\n([\s\S]*?)(?=\n\d+\. \*\*)/);
  assert.ok(match, "go.md must carry a '**Kimi loop/background profile' block in the Kimi run-loop step");
  const block = match[0];
  assert.match(block, /max_steps_per_turn` unset/, "go.md must pin max_steps_per_turn unset (no cap)");
  assert.match(block, /max_retries_per_step` unset \(built-in 10/, "go.md must pin max_retries_per_step unset (built-in 10)");
  assert.match(block, /reserved_context_size` unset\s*\(built-in 50000/, "go.md must pin reserved_context_size unset (built-in 50000)");
  assert.match(block, /max_running_tasks` unset/, "go.md must pin max_running_tasks unset (no cap)");
  assert.match(block, /print_background_mode` `steer`/, "go.md must pin print_background_mode steer");
  assert.match(block, /NOT written\s*\n\s*into the user's config\.toml/, "go.md must state the values are not emitted into config.toml");
  assert.match(block, /§11\.10/, "go.md must point at the §11.10 probe evidence");
  assert.match(block, /KIMI_LOOP_MAX_STEPS_PER_TURN/, "go.md must name the per-process env overrides for non-default runs");
  assert.match(block, /keep_alive_on_exit = true[\s\S]*?drain/, "go.md must warn about the legacy drain downgrade");
  assert.match(block, /defaults apply unless the user's\s*\n\s*config\.toml already sets those keys[\s\S]*?user-set `max_steps_per_turn` cap no longer aborts the\s*\n\s*goal/, "go.md must caveat that user-set keys override the defaults, with the corrected 0.30.0 max_steps_per_turn advisory");
  assert.match(block, /pauses the goal resumably[\s\S]*?exits 1[\s\S]*?harness FAULT/, "go.md must state the capped run now pauses resumably but exits 1 as a harness fault");
});

// --- (c) src/kimi-install.js's non-emission rationale comment --------------

test("src/kimi-install.js carries the comment-only non-emission rationale", async () => {
  const src = await readFile(new URL("../src/kimi-install.js", import.meta.url), "utf8");
  assert.match(src, /Why there is NO \[loop_control\]\/\[background\] emission/, "kimi-install.js must carry the non-emission rationale comment");
  assert.match(src, /all five cases[\s\S]*?keep_alive_on_exit/, "the rationale must state all five chosen values are binary defaults, with the keep_alive_on_exit caveat named");
  assert.match(src, /user-global config\.toml \(no project-level override exists\)/, "the rationale must cite user-global-only config");
  assert.match(src, /KIMI_LOOP_MAX_STEPS_PER_TURN/, "the rationale must name the env-override escape hatch");
  assert.match(src, /plugin\/commands\/go\.md step 6/, "the rationale must point at go.md step 6 as the pin site");
  assert.match(src, /kimi-code-cli\.md 11\.10/, "the rationale must point at the §11.10 probe evidence");
  // and no emission actually happens: no [loop_control]/[background] toml payload
  assert.doesNotMatch(src, /toml:\s*`\[loop_control\]/, "kimi-install.js must NOT emit a [loop_control] stanza");
  assert.doesNotMatch(src, /toml:\s*`\[background\]/, "kimi-install.js must NOT emit a [background] stanza");
});

// --- (d) chosen values pinned identically across §11.10 and go.md ----------
// The probe citations above pin each surface in isolation; this table pins the
// CHOSEN VALUE statements themselves on both surfaces, so a value drifting in
// one surface (e.g. go.md's 10 while §11.10 says 50000) fails here.

const CHOSEN_VALUE_PINS = [
  {
    name: "max_steps_per_turn unset (no cap)",
    docs: /`max_steps_per_turn` unset \(no cap/,
    go: /`max_steps_per_turn` unset \(no cap/,
  },
  {
    name: "max_retries_per_step unset (built-in 10)",
    docs: /`max_retries_per_step` unset \(10\b/,
    go: /`max_retries_per_step` unset \(built-in 10/,
  },
  {
    name: "reserved_context_size unset (built-in 50000)",
    docs: /`reserved_context_size` unset \(50000\b/,
    go: /`reserved_context_size` unset\s*\(built-in 50000/,
  },
  {
    name: "max_running_tasks unset (no cap)",
    docs: /`max_running_tasks` unset \(no cap/,
    go: /`max_running_tasks` unset \(no cap/,
  },
  {
    name: "print_background_mode steer (the default)",
    docs: /`print_background_mode` `steer` \(the default/,
    go: /`print_background_mode` `steer` \(the default/,
  },
];

test("the five chosen values are pinned consistently across §11.10 and go.md", async () => {
  const text = await readFile(new URL("../docs/research/kimi-code-cli.md", import.meta.url), "utf8");
  const sectionMatch = text.match(/^### 11\.10 [^\n]*\n([\s\S]*?)(?=\n## )/m);
  assert.ok(sectionMatch, "docs/research/kimi-code-cli.md must carry a '### 11.10' section");
  const go = await readFile(new URL("../plugin/commands/go.md", import.meta.url), "utf8");
  const blockMatch = go.match(/\*\*Kimi loop\/background profile[^\n]*\n([\s\S]*?)(?=\n\d+\. \*\*)/);
  assert.ok(blockMatch, "go.md must carry a '**Kimi loop/background profile' block in the Kimi run-loop step");
  for (const pin of CHOSEN_VALUE_PINS) {
    assert.match(sectionMatch[1], pin.docs, `§11.10 must pin the chosen value: ${pin.name}`);
    assert.match(blockMatch[0], pin.go, `go.md must pin the chosen value: ${pin.name}`);
  }
});
