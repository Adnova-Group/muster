import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { exists } from "./fs-util.js";

export async function initScratchpad(dir, runId) {
  // Guard runId before it joins into a path (mirrors writeMemory's slug guard):
  // a `/`, `\`, or `..` would let a caller scaffold directories outside the
  // named store. Reject before any mkdir runs.
  if (typeof runId !== "string" || runId.includes("/") || runId.includes("\\") || runId.includes(".."))
    throw new Error(`initScratchpad: invalid runId ${JSON.stringify(runId)} (no path separators or ..)`);
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
