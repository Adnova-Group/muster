import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { parse } from "yaml";

const ROLES = new Set([
  "code-navigation", "docs-research", "brainstorm", "plan", "implement",
  "code-review", "security-review", "test-author", "refactor", "frontend", "tech-debt", "debug",
  "author", "research", "score",
  "architecture-review", "browser-control", "computer-control",
  "performance", "seo", "humanize"
]);
const DETECT_KINDS = new Set(["plugin", "skill", "mcp_server", "agent"]);

export function validateCatalog(entries) {
  const errors = [];
  if (!Array.isArray(entries)) return { ok: false, errors: ["catalog must be an array"] };
  entries.forEach((e, i) => {
    const at = `entry[${i}]`;
    if (!e.id) errors.push(`${at}: missing id`);
    if (e.kind !== "external" && e.kind !== "builtin" && e.kind !== "agent") errors.push(`${at}: kind must be external|builtin|agent`);
    if (!Array.isArray(e.roles) || e.roles.length === 0) errors.push(`${at}: roles must be a non-empty array`);
    else for (const r of e.roles) if (!ROLES.has(r)) errors.push(`${at}: unknown role "${r}"`);
    if (typeof e.rank !== "number") errors.push(`${at}: rank must be a number`);
    if (e.kind === "external" && (!e.detect || !e.detect.kind || !e.detect.match))
      errors.push(`${at}: external entry needs detect.{kind,match}`);
    else if (e.kind === "external" && e.detect && e.detect.kind && !DETECT_KINDS.has(e.detect.kind))
      errors.push(`${at}: unknown detect.kind "${e.detect.kind}" (must be plugin|skill|mcp_server|agent)`);
    if ((e.kind === "builtin" || e.kind === "agent") && (!e.provenance || !e.provenance.license))
      errors.push(`${at}: ${e.kind} entry needs provenance.license (adapted_from for vendored, inspired_by for clean-room)`);
  });
  return { ok: errors.length === 0, errors };
}

export async function loadCatalog(dir) {
  const base = dir instanceof URL ? fileURLToPath(dir) : dir;
  const files = (await readdir(base)).filter(f => f.endsWith(".yaml") || f.endsWith(".yml"));
  let entries = [];
  for (const f of files) entries = entries.concat(parse(await readFile(join(base, f), "utf8")) || []);
  const { ok, errors } = validateCatalog(entries);
  if (!ok) throw new Error("Invalid catalog:\n" + errors.join("\n"));
  return entries;
}
