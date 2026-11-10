#!/usr/bin/env node
// Regenerates the builtin tables in website/reference/skills.md from catalog/ and each builtin's
// stamped `upstream:` frontmatter (src/skills.js generateSkillsBlock). Run it after adding,
// removing or re-cataloguing a builtin; test/skills-page.test.js fails while the page drifts.
//
//   node scripts/gen-skills-page.mjs           rewrite the generated block
//   node scripts/gen-skills-page.mjs --check   exit 1 when the page is stale
import { fileURLToPath } from "node:url";
import { SKILLS_PAGE_PATH, builtinInventory, readSkillsPage, stampSkillsPage, writeSkillsPage } from "../src/skills.js";

const root = fileURLToPath(new URL("../", import.meta.url));
const current = await readSkillsPage(root);
const next = stampSkillsPage(current, builtinInventory());
if (next === null) {
  process.stderr.write(`${SKILLS_PAGE_PATH}: missing the generated-block markers\n`);
  process.exit(1);
}
if (process.argv.includes("--check")) {
  if (next !== current) {
    process.stderr.write(`${SKILLS_PAGE_PATH} is stale: run \`npm run docs:skills\`\n`);
    process.exit(1);
  }
} else if (next !== current) {
  await writeSkillsPage(root, next);
  process.stdout.write(`wrote ${SKILLS_PAGE_PATH}\n`);
}
