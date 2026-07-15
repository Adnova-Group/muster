import { readdir, readFile, writeFile, mkdir, appendFile } from "node:fs/promises";
import { join } from "node:path";
import { stringify } from "yaml";
import { exists } from "./fs-util.js";

export async function writeMemory(dir, entry) {
  for (const field of ["slug", "title", "outcome", "body"]) {
    const v = entry?.[field];
    if (typeof v !== "string" || v.length === 0)
      throw new Error(`writeMemory: missing required field "${field}"`);
  }
  if (entry.slug.includes("/") || entry.slug.includes("\\") || entry.slug.includes(".."))
    throw new Error(`writeMemory: invalid slug "${entry.slug}" (no path separators or ..)`);
  // [[link]] values are emitted as raw wiki-links, not YAML — so a `]]` would
  // close the link early and a newline would break out of the line. Reject both
  // rather than emit forgeable markup. (Frontmatter fields are safe via yaml
  // stringify below; links are the one un-escaped surface.)
  const links = entry.links || [];
  for (const l of links) {
    if (typeof l !== "string" || l.includes("]]") || /[\n\r]/.test(l))
      throw new Error(`writeMemory: invalid link ${JSON.stringify(l)} (no "]]" or newlines)`);
  }
  await mkdir(dir, { recursive: true });
  const linkLine = links.map(l => `[[${l}]]`).join(" ");
  // Build frontmatter from an object via yaml.stringify so free-text fields
  // (title/outcome) are quoted/escaped — a newline or `---` in a value becomes a
  // YAML scalar, never a forged key. Mirrors vendor.js's stringify wrapping.
  const frontmatter = stringify({ title: entry.title, outcome: entry.outcome }, { lineWidth: 0 }).trim();
  const md = `---\n${frontmatter}\n---\n\n${entry.body}\n\n${linkLine}\n`;
  await writeFile(join(dir, `${entry.slug}.md`), md);

  const line = `- [${entry.title}](${entry.slug}.md) — ${entry.outcome}\n`;
  const indexPath = join(dir, "INDEX.md");
  // Use appendFile so concurrent writes of different slugs never overwrite each other.
  // A sequential same-slug dedup check runs before the append; truly concurrent
  // same-slug calls may still produce duplicate lines (narrow race), but data from
  // other slugs is never lost.
  const existing = (await exists(indexPath)) ? await readFile(indexPath, "utf8") : "";
  if (!existing.includes(`${entry.slug}.md`)) {
    const prefix = existing ? "" : "# Muster memory index\n\n";
    await appendFile(indexPath, prefix + line);
  }
}

export async function readMemory(dir, query) {
  if (!(await exists(dir))) return [];
  const files = (await readdir(dir)).filter(f => f.endsWith(".md") && f !== "INDEX.md");
  const q = query.toLowerCase();
  const hits = [];
  for (const f of files) {
    const content = await readFile(join(dir, f), "utf8");
    if (content.toLowerCase().includes(q)) hits.push({ slug: f.replace(/\.md$/, ""), content });
  }
  return hits;
}

// Run-record STATE API (intended public surface — not orphaned). appendState
// and appendFollowup are the glass-box run-record helpers the model-driven
// orchestrator (and the diagnose/audit STATE logging) invoke via the CLI's
// memory/scratchpad verbs to journal per-wave progress and non-blocking
// findings. They have no direct in-process production caller by design: the
// orchestrator drives them through the CLI surface. Keep them exported.
export async function appendState(dir, runId, line) {
  // A-SEC7: guard runId before joining into a path (mirrors initScratchpad's
  // runId check and writeMemory's slug check). A traversal runId like "../x"
  // would write files outside the named store.
  if (typeof runId !== "string" || runId.includes("/") || runId.includes("\\") || runId.includes(".."))
    throw new Error(`appendState: invalid runId ${JSON.stringify(runId)} (no path separators or ..)`);
  await mkdir(dir, { recursive: true });
  await appendFile(join(dir, `${runId}.state.md`), line.replace(/\n/g, " ") + "\n");
}

// Run-record STATE API (intended public surface — see appendState above).
export async function appendFollowup(dir, runId, finding) {
  // A-SEC7: guard runId before joining into a path (mirrors initScratchpad's
  // runId check and writeMemory's slug check).
  if (typeof runId !== "string" || runId.includes("/") || runId.includes("\\") || runId.includes(".."))
    throw new Error(`appendFollowup: invalid runId ${JSON.stringify(runId)} (no path separators or ..)`);
  await mkdir(dir, { recursive: true });
  await appendFile(join(dir, `${runId}.followups.md`), `- [${finding.severity}] ${finding.note}\n`);
}
