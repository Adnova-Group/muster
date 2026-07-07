import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, access } from "node:fs/promises";
import { scoreHumanness } from "../src/humanizer-score.js";

// docs/anti-patterns.md: a versioned ledger of caught failure classes (symptom, root
// cause, the guard that now exists), referenced by the orchestrator's brief-construction
// prose and cited by muster-improver as an input. See backlog {id: anti-pattern-ledger}.

const root = new URL("../", import.meta.url);
const read = (p) => readFile(new URL(p, root), "utf8");
const exists = (p) => access(new URL(p, root)).then(() => true, () => false);

const LEDGER = "docs/anti-patterns.md";

// Splits the ledger on its numbered "## N. Title" headings and returns one record per
// entry: { n, title, body } where body runs to the next heading (or EOF).
function parseEntries(text) {
  const headingRe = /^## (\d+)\. (.+)$/gm;
  const headings = [...text.matchAll(headingRe)];
  return headings.map((h, i) => ({
    n: Number(h[1]),
    title: h[2].trim(),
    body: text.slice(h.index, i + 1 < headings.length ? headings[i + 1].index : text.length),
  }));
}

test("docs/anti-patterns.md exists and carries a version marker", async () => {
  assert.equal(await exists(LEDGER), true, `${LEDGER} must exist`);
  const text = await read(LEDGER);
  assert.match(text, /^\*\*Version:\*\* \d+/m, "ledger must state a numeric version near the top");
});

test("docs/anti-patterns.md has at least 8 sequentially numbered entries, each with symptom, root cause, and guard", async () => {
  const entries = parseEntries(await read(LEDGER));
  assert.ok(entries.length >= 8, `expected >= 8 entries, found ${entries.length}`);
  entries.forEach((e, i) => assert.equal(e.n, i + 1, `entry ${i} must be numbered ${i + 1}, found ${e.n}`));
  for (const e of entries) {
    assert.match(e.body, /\*\*Symptom:\*\*/, `entry ${e.n} (${e.title}) missing a Symptom label`);
    assert.match(e.body, /\*\*Root cause:\*\*/, `entry ${e.n} (${e.title}) missing a Root cause label`);
    assert.match(e.body, /\*\*Guard:\*\*/, `entry ${e.n} (${e.title}) missing a Guard label`);
  }
});

test("docs/anti-patterns.md: every entry's Guard cites at least one real repo file, and every cited file exists", async () => {
  const entries = parseEntries(await read(LEDGER));
  const repoPrefixes = ["src/", "test/", "eval/", "plugin/"];
  let totalChecked = 0;
  for (const e of entries) {
    const guardMatch = e.body.match(/\*\*Guard:\*\*([\s\S]*?)(?:\n\n|$)/);
    assert.ok(guardMatch, `entry ${e.n} (${e.title}) has no parseable Guard paragraph`);
    const cited = [...guardMatch[1].matchAll(/`([\w./-]+)`/g)]
      .map((m) => m[1])
      .filter((p) => repoPrefixes.some((pre) => p.startsWith(pre)));
    assert.ok(cited.length > 0, `entry ${e.n} (${e.title}) Guard must cite at least one repo file path`);
    for (const p of cited) {
      totalChecked += 1;
      assert.equal(await exists(p), true, `entry ${e.n} (${e.title}) Guard cites "${p}", which does not exist on disk`);
    }
  }
  assert.ok(totalChecked >= 8, `expected at least 8 guard file citations checked, found ${totalChecked}`);
});

test("plugin/skills/orchestrator/SKILL.md references the anti-pattern ledger in its brief-construction prose", async () => {
  const text = await read("plugin/skills/orchestrator/SKILL.md");
  assert.match(text, /docs\/anti-patterns\.md/, "orchestrator SKILL.md must reference docs/anti-patterns.md");
  // Scoped: the reference must sit in brief-construction prose, not anywhere incidental --
  // pinned to the "Required skills (brief binding)" section where every other per-task
  // brief addition (REQUIRED SKILLS, Surface line) already lives.
  const section = text.match(/^## Required skills \(brief binding\)\n([\s\S]*?)(?=\n## )/m);
  assert.ok(section, "orchestrator SKILL.md must carry a '## Required skills (brief binding)' section");
  assert.match(section[1], /docs\/anti-patterns\.md/, "the ledger reference must live in the brief-binding section");
});

test("plugin/agents/muster-improver.md cites the anti-pattern ledger as an input", async () => {
  const text = await read("plugin/agents/muster-improver.md");
  assert.match(text, /docs\/anti-patterns\.md/, "muster-improver.md must reference docs/anti-patterns.md as an input");
});

test("docs/anti-patterns.md carries no em-dashes (humanizer rule)", async () => {
  const text = await read(LEDGER);
  assert.ok(!text.includes("—"), "ledger must be em-dash free");
});

test("docs/anti-patterns.md scores clean on every humanizer AI-tell category", async () => {
  const result = scoreHumanness(await read(LEDGER));
  assert.deepEqual(result.findings, [], `AI tells detected: ${JSON.stringify(result.findings)}`);
});
