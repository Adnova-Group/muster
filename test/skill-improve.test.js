// test/skill-improve.test.js -- guard for the improver-fork backlog item.
//
// plugin/skills/improve/SKILL.md is a `context: fork` skill (Claude Code 2.1.218+ runs
// `context: fork` skills in the background by default -- docs/research/claude-code-cli.md
// sec "Dispatch surface changes"): dispatching it costs nothing in the main session, since
// the fork inherits the conversation and mines the run it just watched off to the side.
// This guard pins the three load-bearing facts the item's own scope names: the frontmatter
// declares `context: fork` (and never opts out via `background: false`), the body states a
// propose-never-apply contract, and the body names the muster-improver agent as the
// fallback path on a harness without background fork skills.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const root = new URL("../", import.meta.url);
const read = (p) => readFile(new URL(p, root), "utf8");

function frontmatter(text) {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  assert.ok(m, "plugin/skills/improve/SKILL.md must open with a --- frontmatter block");
  return m[1];
}

test("plugin/skills/improve/SKILL.md declares context: fork, never opting out via background: false", async () => {
  const fm = frontmatter(await read("plugin/skills/improve/SKILL.md"));
  assert.match(fm, /^name:\s*improve$/m, "frontmatter must declare name: improve");
  assert.match(fm, /^context:\s*fork$/m, "frontmatter must declare context: fork (2.1.218 background-by-default)");
  assert.doesNotMatch(fm, /^background:\s*false$/m, "must not opt out of the 2.1.218 background-by-default behavior");
});

test("plugin/skills/improve/SKILL.md carries a propose-never-apply contract", async () => {
  const text = await read("plugin/skills/improve/SKILL.md");
  assert.match(text, /proposals only/i, "must state its output is proposals only");
  assert.match(text, /never apply an edit yourself/i, "must state it never applies an edit itself");
});

test("plugin/skills/improve/SKILL.md names the muster-improver agent as the fallback on a harness without background fork skills", async () => {
  const text = await read("plugin/skills/improve/SKILL.md");
  // \s+ (not a literal space) between words tolerates this repo's soft-wrapped markdown
  // prose (a line can break mid-sentence at ~80-90 cols without changing its meaning).
  assert.match(text, /harness\s+without\s+background\s+`context:\s+fork`\s+skills/i, "must name the fallback trigger");
  assert.match(text, /routes\s+to\s+the\s+`muster-improver`\s+agent\s+unchanged/i, "must name muster-improver as the fallback target");
});
