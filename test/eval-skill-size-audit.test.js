// Smoke test for eval/perf/skill-size-audit.mjs (speed-tuning item, criterion 2). Runs the
// script to completion and checks its structured report shape -- deliberately does NOT pin
// exact char counts (those are REAL, live-measured plugin/skills/*/SKILL.md sizes that
// legitimately drift as those files evolve; test/skill-footprint.test.js already pins the
// pure ranking/percentage ARITHMETIC with fixed inputs).
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";
import { readdir } from "node:fs/promises";

const pexecFile = promisify(execFile);
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = join(REPO_ROOT, "eval/perf/skill-size-audit.mjs");

test("eval/perf/skill-size-audit.mjs runs to completion and prints every skill plus its top-5 slice", async () => {
  const { stdout } = await pexecFile(process.execPath, [SCRIPT], { cwd: REPO_ROOT });
  const skillDirs = (await readdir(join(REPO_ROOT, "plugin", "skills"), { withFileTypes: true }))
    .filter((d) => d.isDirectory()).map((d) => d.name);

  assert.match(stdout, /skill-size audit: \d+ plugin\/skills\/\*\/SKILL\.md measured/);
  assert.match(stdout, /All skills, largest first:/);
  assert.match(stdout, /The 5 largest \(this item's >=40%-cut targets\):/);
  for (const name of skillDirs) {
    assert.match(stdout, new RegExp(`\\b${name}\\b`), `expected ${name} to appear in the audit output`);
  }
});

test("eval/perf/skill-size-audit.mjs's largest-first ordering matches a fresh, independent measurement", async () => {
  const { stdout } = await pexecFile(process.execPath, [SCRIPT], { cwd: REPO_ROOT });
  const skillsDir = join(REPO_ROOT, "plugin", "skills");
  const dirs = (await readdir(skillsDir, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name);
  const { readFile } = await import("node:fs/promises");
  const sizes = await Promise.all(dirs.map(async (name) => {
    const content = await readFile(join(skillsDir, name, "SKILL.md"), "utf8").catch(() => null);
    return content === null ? null : { name, chars: content.length };
  }));
  const expectedOrder = sizes.filter(Boolean).sort((a, b) => b.chars - a.chars).map((s) => s.name);

  const allSection = stdout.split("All skills, largest first:")[1].split("The 5 largest")[0];
  const printedOrder = [...allSection.matchAll(/^\s*([a-z0-9-]+)\s+\d+ chars/gm)].map((m) => m[1]);
  assert.deepEqual(printedOrder, expectedOrder, "the script's printed order must match an independent largest-first sort");
});
