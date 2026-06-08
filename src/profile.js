import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";

// Muster's own user profile — self-contained, NOT a dependency on atomic or any other tool.
// Global: ~/.claude/muster/profile.md   Project: .muster/profile.md (project overrides global).
export async function readProfile(home = homedir(), cwd = process.cwd()) {
  const candidates = [join(cwd, ".muster/profile.md"), join(home, ".claude/muster/profile.md")];
  for (const p of candidates) {
    try { return { found: true, path: p, content: await readFile(p, "utf8") }; } catch { /* try next */ }
  }
  return { found: false, path: null, content: "" };
}
