// F14 (docs/research/2026-11-claude-code-findings.md): `omitClaudeMd` (Claude Code 2.1.271)
// lets "custom and plugin subagents run without user, project and local CLAUDE.md files;
// managed policy files still load". It is set only on workflow seats whose brief carries
// everything they need. Agents that write project code or judge it against project
// conventions keep CLAUDE.md.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";

const dir = new URL("../plugin/agents/", import.meta.url);

const BRIEF_ONLY = [
  "muster-plan-checker",
  "muster-verifier",
  "muster-integration-checker",
  "wsh-team-debugger",
  "book-writer",
  "book-continuity-checker",
  "book-developmental-editor",
  "book-line-editor",
  "book-beta-reader",
];
// Write or judge project code, or answer free-form questions from the main thread.
const KEEPS_CLAUDE_MD = ["muster-executor", "muster-planner", "muster-reviewer", "muster-test-writer", "muster-surgeon", "muster-investigator", "muster-strategist", "muster-improver"];

const frontmatter = (src) => src.slice(4, src.indexOf("\n---", 4));

test("brief-only workflow seats set omitClaudeMd: true in their frontmatter", async () => {
  for (const name of BRIEF_ONLY) {
    const fm = frontmatter(await readFile(new URL(`${name}.md`, dir), "utf8"));
    assert.match(fm, /^omitClaudeMd: true$/m, `${name} should skip CLAUDE.md`);
  }
});

test("agents that need project conventions keep CLAUDE.md; nothing else sets omitClaudeMd", async () => {
  for (const name of KEEPS_CLAUDE_MD) {
    const fm = frontmatter(await readFile(new URL(`${name}.md`, dir), "utf8"));
    assert.doesNotMatch(fm, /omitClaudeMd/, `${name} must keep CLAUDE.md`);
  }
  for (const file of (await readdir(dir)).filter((f) => f.endsWith(".md"))) {
    const fm = frontmatter(await readFile(new URL(file, dir), "utf8"));
    if (/omitClaudeMd/.test(fm)) assert.ok(BRIEF_ONLY.includes(file.replace(/\.md$/, "")), `${file} sets omitClaudeMd but is not in the reviewed brief-only list`);
  }
});
