import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { exists } from "./fs-util.js";

export async function initScratchpad(dir, runId) {
  const sp = join(dir, "scratchpad", runId);
  await mkdir(sp, { recursive: true });
  const files = { "BRIEF.md": "# Brief\n", "STATE.md": "# State (append-only)\n", "FOLLOWUPS.md": "# Follow-ups\n" };
  const created = [];
  for (const [f, c] of Object.entries(files)) {
    const p = join(sp, f);
    if (!(await exists(p))) { await writeFile(p, c); created.push(f); }
  }
  return { path: sp, created };
}
