// Shared file-enumeration for the brief-lint repo-wide guards (speed-tuning item criterion 3;
// completed by the brief-lint-coverage item). Both test/prompt-scan-brief-lint.test.js (budget
// check) and test/brief-lint-coverage.test.js (coverage/regression check) scan the SAME corpus --
// every plugin/agents/*.md, plugin/commands/*.md file, and every *.md file directly under a
// plugin/skills/<name>/ directory (not just SKILL.md -- plugin/skills/review-gate/fast-path-brief.md
// is itself a dispatched reviewer brief, not documentation about one, so it belongs in scope on
// the same footing as SKILL.md).
import { readFile, readdir } from "node:fs/promises";

const root = new URL("../", import.meta.url);

export function resolveRepoPath(p) {
  return new URL(p, root);
}

export function readRepoFile(p) {
  return readFile(resolveRepoPath(p), "utf8");
}

export async function proseFiles() {
  const files = [];
  for (const f of await readdir(resolveRepoPath("plugin/agents/"))) {
    if (f.endsWith(".md")) files.push(`plugin/agents/${f}`);
  }
  for (const f of await readdir(resolveRepoPath("plugin/commands/"))) {
    if (f.endsWith(".md")) files.push(`plugin/commands/${f}`);
  }
  for (const dir of await readdir(resolveRepoPath("plugin/skills/"))) {
    const base = `plugin/skills/${dir}/`;
    for (const f of await readdir(resolveRepoPath(base))) {
      if (f.endsWith(".md")) files.push(base + f);
    }
  }
  return files;
}

// Reads every file `proseFiles()` names into a { path: text } map, the shape both
// `lintBriefReturnCaps` and `findUnmarkedDispatchSignals` (src/brief-lint.js) take directly.
export async function readProseFiles() {
  const paths = await proseFiles();
  const filesByPath = {};
  for (const p of paths) filesByPath[p] = await readRepoFile(p);
  return filesByPath;
}
