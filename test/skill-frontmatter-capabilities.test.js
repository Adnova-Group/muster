// test/skill-frontmatter-capabilities.test.js — skill-frontmatter-capabilities item.
//
// Claude Code's SKILL.md/command frontmatter supports capability keys beyond name+description
// (docs/research/claude-code-cli.md:170,217): allowed-tools/disallowed-tools (a per-skill
// permission scope active while the skill runs), argument-hint (usage-string surfaced to the
// user), and disable-model-invocation (keeps a side-effectful verb out of implicit
// model-judged routing). This item applies them conservatively, evidence-first:
//
// - disallowed-tools (Write|Edit|NotebookEdit): only plugin/skills/router/SKILL.md, whose
//   documented contract is "Emit ONLY the Crew Manifest JSON" as response text -- the
//   invoking command (go.md/plan.md step 3) is the one that writes .muster/manifest.json,
//   confirmed by grepping router's own prose for any Write/Edit-shaped step (there is none).
//   review-gate/advisor/tournament were also candidates per the item brief but each has a
//   documented, load-bearing write of its own (review-gate: ".muster/verdicts.json" step 5 +
//   the mutant-kill gate's mutate-then-revert; advisor: STATE appends at steps 1/5; tournament:
//   ".muster/candidates.json"/".muster/fusion-map.json" step 2 + a STATE append at step 6) --
//   denying Write/Edit/NotebookEdit on any of them would break their own documented workflow,
//   so each is deliberately skipped (see the PR body for the one-line rationale per skill).
// - argument-hint: every plugin/commands/*.md, extracted verbatim from the "Usage: ..." string
//   already embedded in that file's own frontmatter description (never invented).
// - disable-model-invocation: audit.md (whole-repo TDD-fix-everything blast radius on a bare
//   invocation) and runner.md (its own prose frames it as cron/Routine-fired, never a
//   conversational trigger) -- judged per-command, not applied to the hands-off/approve-first
//   pipeline verbs (go/go-backlog/plan/plan-backlog/diagnose/capture) muster's border model
//   deliberately keeps model-invocable so a natural-language invitation still routes to them.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";

const root = new URL("../", import.meta.url);
const read = (p) => readFile(new URL(p, root), "utf8");

function frontmatter(text) {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  assert.ok(m, "file must open with a --- frontmatter block");
  return m[1];
}

// ── disallowed-tools: read-only enforcement, evidence-first ────────────────────────────────

test("router/SKILL.md denies Write/Edit/NotebookEdit -- its documented contract never writes a file itself", async () => {
  const fm = frontmatter(await read("plugin/skills/router/SKILL.md"));
  const m = fm.match(/^disallowed-tools:\s*(.+)$/m);
  assert.ok(m, "router/SKILL.md must carry a disallowed-tools key");
  const denied = m[1].split(",").map((s) => s.trim());
  assert.deepEqual(denied, ["Write", "Edit", "NotebookEdit"]);
});

test("review-gate/advisor/tournament keep Write/Edit -- each has a documented write of its own, verified not guessed", async () => {
  for (const skill of ["review-gate", "advisor", "tournament"]) {
    const fm = frontmatter(await read(`plugin/skills/${skill}/SKILL.md`));
    assert.doesNotMatch(
      fm,
      /^disallowed-tools:/m,
      `${skill}/SKILL.md must NOT deny Write/Edit -- its documented workflow writes .muster/ artifacts and/or STATE`,
    );
  }
});

// ── argument-hint: every command, extracted from its own Usage string ──────────────────────

const EXPECTED_ARGUMENT_HINTS = {
  audit: "[path or empty = whole repo] | backlog [path]",
  autopilot: "<outcome>",
  capture: "[hint]",
  diagnose: "<symptom | paste failing test/CI output>",
  "go-backlog": "<backlog ref>",
  go: "<outcome>",
  "plan-backlog": "<backlog ref | raw intent>",
  plan: "<outcome text | backlog text>",
  run: "<outcome | backlog ref>",
  runner: "[backlog path | issues:<label>]",
  sprint: "<backlog ref>",
};

test("every plugin/commands/*.md file carries argument-hint, matching the Usage string already in its description", async () => {
  const names = (await readdir(new URL("plugin/commands", root)))
    .filter((f) => f.endsWith(".md"))
    .map((f) => f.replace(/\.md$/, ""));
  assert.deepEqual(names.sort(), Object.keys(EXPECTED_ARGUMENT_HINTS).sort(), "command file set drifted from this test's coverage");
  for (const name of names) {
    const text = await read(`plugin/commands/${name}.md`);
    const fm = frontmatter(text);
    const hintMatch = fm.match(/^argument-hint:\s*"([^"]*)"$/m);
    assert.ok(hintMatch, `${name}.md must carry an argument-hint key`);
    assert.equal(hintMatch[1], EXPECTED_ARGUMENT_HINTS[name], `${name}.md's argument-hint must match its own Usage string`);
    // Every " | "-joined fragment of the hint must be a LITERAL substring somewhere after
    // "Usage:" in the description -- proves each piece was extracted, never invented, even
    // for a compound multi-form hint like audit's (two separate Usage sentences, recombined).
    const usageIdx = text.indexOf("Usage:");
    assert.ok(usageIdx >= 0, `${name}.md's description must carry a "Usage:" string`);
    const usageText = text.slice(usageIdx);
    for (const fragment of hintMatch[1].split(" | ")) {
      assert.ok(
        usageText.includes(fragment),
        `${name}.md's argument-hint fragment "${fragment}" must be a literal substring of its own Usage string, not invented`,
      );
    }
  }
});

// ── disable-model-invocation: judged per-command, documented in the PR body ────────────────

test("disable-model-invocation applies only to audit.md and runner.md (side-effectful verbs judged unsafe for implicit routing)", async () => {
  const disabled = new Set(["audit", "runner"]);
  const names = (await readdir(new URL("plugin/commands", root)))
    .filter((f) => f.endsWith(".md"))
    .map((f) => f.replace(/\.md$/, ""));
  for (const name of names) {
    const fm = frontmatter(await read(`plugin/commands/${name}.md`));
    if (disabled.has(name)) {
      assert.match(fm, /^disable-model-invocation:\s*true$/m, `${name}.md must carry disable-model-invocation: true`);
    } else {
      assert.doesNotMatch(fm, /^disable-model-invocation:/m, `${name}.md must stay model-invocable (border model keeps routable verbs invocable)`);
    }
  }
});
