#!/usr/bin/env node
// speed-tuning item, criterion 2: skill prompt-size audit harness.
//
// REAL measurement: reads plugin/skills/*/SKILL.md off disk right now (never hardcoded)
// and computes each one's byte/char footprint via src/skill-footprint.js's
// computeSkillFootprint, then ranks them (rankSkillFootprints) to surface the 5 largest --
// the ones whose loaded footprint costs the most on every dispatch that loads them (see
// docs/speed-tuning.md for which verb/dispatch loads which skill). This script is the
// measurement half; the actual >=40%-cut work happens by hand in each of the 5 files,
// verified by re-running this script (before/after) plus the full contract-test suite
// (corpus-contradiction, docs-binding-interface, prompt-scan, mode-evals) staying green.
//
// Usage: node eval/perf/skill-size-audit.mjs
import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { computeSkillFootprint, rankSkillFootprints, MIN_REDUCTION_PCT } from "../../src/skill-footprint.js";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..");
const skillsDir = join(repoRoot, "plugin", "skills");

async function measureAll() {
  const dirs = (await readdir(skillsDir, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name);
  const footprints = [];
  for (const name of dirs) {
    const path = join(skillsDir, name, "SKILL.md");
    const content = await readFile(path, "utf8").catch(() => null);
    if (content === null) continue; // a skill dir with no SKILL.md is not part of the audited surface
    footprints.push(computeSkillFootprint(name, content));
  }
  return footprints;
}

const footprints = await measureAll();
const { all, largest } = rankSkillFootprints(footprints, { count: 5 });

console.log(`speed-tuning skill-size audit: ${all.length} plugin/skills/*/SKILL.md measured, real byte counts, ${new Date().toISOString().slice(0, 10)}\n`);
console.log("All skills, largest first:");
for (const f of all) {
  console.log(`  ${f.name.padEnd(24)} ${String(f.chars).padStart(7)} chars  ~${f.tokens.toFixed(0).padStart(6)} tokens`);
}

console.log(`\nThe ${largest.length} largest (this item's >=${MIN_REDUCTION_PCT}%-cut targets):`);
for (const f of largest) {
  console.log(`  ${f.name.padEnd(24)} ${String(f.chars).padStart(7)} chars  ~${f.tokens.toFixed(0).padStart(6)} tokens`);
}

console.log("\nRun this script again after cutting each file and compare against the numbers above --");
console.log("each of the 5 largest must show a >=40% chars reduction (src/skill-footprint.js's");
console.log("reductionPct/meetsReductionTarget), with the contract-test suite (corpus-contradiction,");
console.log("docs-binding-interface, prompt-scan, mode-evals) still green as proof no load-bearing");
console.log("rule was dropped in the process.");
