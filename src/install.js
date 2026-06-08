import { readFile, writeFile, mkdir, copyFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

async function readIfExists(p) {
  try { return await readFile(p, "utf8"); } catch { return null; }
}

// Install muster's output style into the user's Claude Code config.
// Mirrors `atomic claude install`: idempotent copy with backup-on-diff.
// Return value is shaped to be extended (e.g. registration guidance in t2).
export async function runInstall({ home = homedir(), repoRoot } = {}) {
  const source = repoRoot
    ? join(repoRoot, "output-styles", "muster.md")
    : fileURLToPath(new URL("../output-styles/muster.md", import.meta.url));

  const content = await readFile(source, "utf8");

  const destDir = join(home, ".claude", "output-styles");
  const dest = join(destDir, "muster.md");
  await mkdir(destDir, { recursive: true });

  let action;
  const existing = await readIfExists(dest);
  if (existing === null) {
    await writeFile(dest, content, "utf8");
    action = "copied";
  } else if (existing === content) {
    action = "skipped";
  } else {
    await copyFile(dest, `${dest}.bak`);
    await writeFile(dest, content, "utf8");
    action = "updated";
  }

  return { style: { action, dest, source } };
}
