import { readdir, readFile, writeFile, mkdir, stat, appendFile } from "node:fs/promises";
import { join } from "node:path";

async function exists(p) { try { await stat(p); return true; } catch { return false; } }

export async function writeMemory(dir, entry) {
  await mkdir(dir, { recursive: true });
  const links = (entry.links || []).map(l => `[[${l}]]`).join(" ");
  const md = `---
title: ${entry.title}
outcome: ${entry.outcome}
---

${entry.body}

${links}
`;
  await writeFile(join(dir, `${entry.slug}.md`), md);

  const line = `- [${entry.title}](${entry.slug}.md) — ${entry.outcome}\n`;
  const indexPath = join(dir, "INDEX.md");
  const head = (await exists(indexPath)) ? await readFile(indexPath, "utf8") : "# Muster memory index\n\n";
  if (!head.includes(`${entry.slug}.md`)) await writeFile(indexPath, head + line);
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

export async function appendState(dir, runId, line) {
  await mkdir(dir, { recursive: true });
  await appendFile(join(dir, `${runId}.state.md`), line.replace(/\n/g, " ") + "\n");
}

export async function appendFollowup(dir, runId, finding) {
  await mkdir(dir, { recursive: true });
  await appendFile(join(dir, `${runId}.followups.md`), `- [${finding.severity}] ${finding.note}\n`);
}
