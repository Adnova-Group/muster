// speed-tuning item, criterion 3: repo-wide subagent brief/return discipline lint. Scans
// every plugin/agents/*.md, plugin/commands/*.md file, and every *.md file directly under a
// plugin/skills/<name>/ directory for the `<!-- muster-brief-template:start/end -->` and
// `<!-- muster-return-template:start/end -->` marker pairs (src/brief-lint.js) and asserts every
// marked span is within this item's stated budget (<=2000 tokens per brief template, <=1000
// tokens per return-contract template). A file with no markers contributes nothing to the scan --
// this is not a requirement that every prose file carry one, only that whichever ones DO stay in
// budget. test/brief-lint-coverage.test.js (brief-lint-coverage item) is the companion guard that
// every REAL dispatch-brief/return-contract template in this same corpus actually carries a
// marker in the first place.
import { test } from "node:test";
import assert from "node:assert/strict";
import { lintBriefReturnCaps } from "../src/brief-lint.js";
import { proseFiles, readProseFiles } from "../test-support/brief-lint-corpus.js";

test("every marked brief/return-contract template in plugin/agents, plugin/commands, and plugin/skills stays within budget", async () => {
  const paths = await proseFiles();
  assert.ok(paths.length >= 20, `sanity: expected ~20+ prose files in scope, found ${paths.length}`);
  const filesByPath = await readProseFiles();

  const { findings, briefCount, returnCount } = lintBriefReturnCaps(filesByPath);
  assert.deepEqual(
    findings,
    [],
    `expected no brief/return-contract template over budget, found: ${JSON.stringify(findings, null, 2)}`
  );
  assert.ok(
    briefCount >= 4,
    "expected at least four marked brief templates in the corpus (muster-runner.md, review-gate/SKILL.md, review-gate/fast-path-brief.md, tournament/SKILL.md's synthesizer prompt)"
  );
  assert.ok(
    returnCount >= 12,
    "expected at least twelve marked return-contract templates in the corpus (muster-runner.md, orchestrator/SKILL.md, every muster-{builder,strategist,investigator,improver,surgeon,reviewer}.md, advisor/SKILL.md, go.md, audit.md, tournament/SKILL.md's judge shape)"
  );
});
