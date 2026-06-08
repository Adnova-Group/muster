import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";

// Compatible with atomic's user profile; falls back to a muster-local profile.
export async function readProfile(home = homedir()) {
  const candidates = [join(home, ".claude/.atomic/profile.md"), join(home, ".claude/muster/profile.md")];
  for (const p of candidates) {
    try { return { found: true, path: p, content: await readFile(p, "utf8") }; } catch { /* try next */ }
  }
  return { found: false, path: null, content: "" };
}
