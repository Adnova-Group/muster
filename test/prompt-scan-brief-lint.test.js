// speed-tuning item, criterion 3: repo-wide subagent brief/return discipline lint. Scans
// every plugin/agents/*.md, plugin/skills/*/SKILL.md, and plugin/commands/*.md file for the
// `<!-- muster-brief-template:start/end -->` and `<!-- muster-return-template:start/end -->`
// marker pairs (src/brief-lint.js) and asserts every marked span is within this item's
// stated budget (<=2000 tokens per brief template, <=1000 tokens per return-contract
// template). A file with no markers contributes nothing to the scan -- this is not a
// requirement that every prose file carry one, only that whichever ones DO stay in budget.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { lintBriefReturnCaps } from "../src/brief-lint.js";

const root = new URL("../", import.meta.url);
const read = (p) => readFile(new URL(p, root), "utf8");
const exists = (p) => read(p).then(() => true, () => false);

async function proseFiles() {
  const files = [];
  for (const f of await readdir(new URL("plugin/agents/", root))) {
    if (f.endsWith(".md")) files.push(`plugin/agents/${f}`);
  }
  for (const f of await readdir(new URL("plugin/commands/", root))) {
    if (f.endsWith(".md")) files.push(`plugin/commands/${f}`);
  }
  for (const dir of await readdir(new URL("plugin/skills/", root))) {
    const p = `plugin/skills/${dir}/SKILL.md`;
    if (await exists(p)) files.push(p);
  }
  return files;
}

test("every marked brief/return-contract template in plugin/agents, plugin/commands, and plugin/skills stays within budget", async () => {
  const paths = await proseFiles();
  assert.ok(paths.length >= 20, `sanity: expected ~20+ prose files in scope, found ${paths.length}`);
  const filesByPath = {};
  for (const p of paths) filesByPath[p] = await read(p);

  const { findings, briefCount, returnCount } = lintBriefReturnCaps(filesByPath);
  assert.deepEqual(
    findings,
    [],
    `expected no brief/return-contract template over budget, found: ${JSON.stringify(findings, null, 2)}`
  );
  assert.ok(briefCount >= 1, "expected at least one marked brief template in the corpus (e.g. muster-runner.md's Dispatch contract)");
  assert.ok(returnCount >= 2, "expected at least two marked return-contract templates in the corpus (muster-runner.md + orchestrator/SKILL.md)");
});
