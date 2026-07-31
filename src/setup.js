import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createContainedFile, ensureContainedDirectory, inspectContainedPath } from "./fs-safe.js";
const pexec = promisify(execFile);

const SEEDS = {
  ".gitignore": "node_modules/\n.muster/\n*.log\n",
  "docs/design/.gitkeep": "",
  "docs/plan/.gitkeep": "",
  "README.md": "# Project\n\nScaffolded by muster.\n",
  "AGENTS.md": "# Agents\n\nThis repository is managed with muster.\n",
  "CLAUDE.md": "# Claude Code\n\n@AGENTS.md\n"
};

export async function scaffoldProject(dir) {
  const created = [], skipped = [];
  await ensureContainedDirectory(dir);
  if (!(await inspectContainedPath(dir, join(dir, ".git")))) {
    try { await pexec("git", ["init", "-q"], { cwd: dir }); created.push(".git"); }
    catch { skipped.push(".git (git unavailable)"); }
  } else skipped.push(".git");

  const preserveClaudeOnly = Boolean(await inspectContainedPath(dir, join(dir, "CLAUDE.md"))) &&
    !(await inspectContainedPath(dir, join(dir, "AGENTS.md")));
  for (const [rel, content] of Object.entries(SEEDS)) {
    const abs = join(dir, rel);
    if (rel === "AGENTS.md" && preserveClaudeOnly) {
      skipped.push(rel);
      continue;
    }
    if (await createContainedFile(dir, abs, content)) created.push(rel);
    else skipped.push(rel);
  }
  return { created, skipped };
}
