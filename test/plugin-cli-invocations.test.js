import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { readdir } from "node:fs/promises";
import { join } from "node:path";

const root = new URL("../", import.meta.url).pathname;

async function collectMdFiles(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await collectMdFiles(full)));
    } else if (entry.isFile() && entry.name.endsWith(".md")) {
      files.push(full);
    }
  }
  return files;
}

// Matches `npx muster ` NOT preceded by `-y @adnova-group/`
// i.e. bare `npx muster ` invocations that resolve the wrong registry package
const BARE_NPX_MUSTER = /npx muster /;
const CORRECT_FORM = /npx -y @adnova-group\/muster /;

function isBare(line) {
  // A line matches if it contains `npx muster ` and does NOT contain the correct form
  return BARE_NPX_MUSTER.test(line) && !CORRECT_FORM.test(line);
}

test("plugin/**/*.md: no bare `npx muster` — must use `npx -y @adnova-group/muster`", async () => {
  const pluginDir = join(root, "plugin");
  const files = await collectMdFiles(pluginDir);
  const violations = [];

  for (const file of files) {
    const content = await readFile(file, "utf8");
    const lines = content.split("\n");
    lines.forEach((line, idx) => {
      if (isBare(line)) {
        violations.push(`${file}:${idx + 1}: ${line.trim()}`);
      }
    });
  }

  assert.deepEqual(
    violations,
    [],
    `Found ${violations.length} bare \`npx muster\` invocation(s) — replace with \`npx -y @adnova-group/muster\`:\n${violations.join("\n")}`
  );
});
