import { mkdir, writeFile, stat } from "node:fs/promises";
import { join, dirname } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
const pexec = promisify(execFile);
async function exists(p) { try { await stat(p); return true; } catch { return false; } }

const SEEDS = {
  ".gitignore": "node_modules/\n.muster/\n*.log\n",
  "docs/design/.gitkeep": "",
  "docs/plan/.gitkeep": "",
  "README.md": "# Project\n\nScaffolded by muster.\n",
  "AGENTS.md": "# Agents\n\nThis repository is managed with muster.\n"
};

export async function scaffoldProject(dir) {
  const created = [], skipped = [];
  if (!(await exists(join(dir, ".git")))) {
    try { await pexec("git", ["init", "-q"], { cwd: dir }); created.push(".git"); } catch { /* git absent */ }
  } else skipped.push(".git");

  for (const [rel, content] of Object.entries(SEEDS)) {
    const abs = join(dir, rel);
    if (await exists(abs)) { skipped.push(rel); continue; }
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, content);
    created.push(rel);
  }
  return { created, skipped };
}
