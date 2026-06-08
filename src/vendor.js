import { parse, stringify } from "yaml";
import { readFile, writeFile, mkdir, readdir, stat } from "node:fs/promises";
import { join, dirname } from "node:path";
import { homedir, tmpdir } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

export function validateManifest(doc) {
  const errors = [];
  if (!doc || !Array.isArray(doc.sources)) return { ok: false, errors: ["manifest.sources must be an array"] };
  doc.sources.forEach((s, i) => {
    if (!s.id) errors.push(`sources[${i}].id: required`);
    if (!s.license) errors.push(`sources[${i}].license: required`);
    if (!["local", "github"].includes(s.kind)) errors.push(`sources[${i}].kind: must be local|github`);
    if (!Array.isArray(s.items)) errors.push(`sources[${i}].items: must be an array`);
    else s.items.forEach((it, j) => {
      if (!it.from) errors.push(`sources[${i}].items[${j}].from: required`);
      if (!it.id) errors.push(`sources[${i}].items[${j}].id: required`);
      if (!Array.isArray(it.roles) || it.roles.length === 0)
        errors.push(`sources[${i}].items[${j}].roles: required non-empty array`);
    });
  });
  return { ok: errors.length === 0, errors };
}

export function splitFrontmatter(text) {
  const m = text.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!m) return { data: {}, body: text };
  return { data: parse(m[1]) || {}, body: m[2] };
}

export function toBuiltin(sourceText, item, source) {
  const { data, body } = splitFrontmatter(sourceText);
  const adapted_from = `${source.repo} ${item.from}`;
  const fm = {
    name: data.name || item.id,
    description: data.description || `Built-in for ${item.roles.join(", ")} (adapted from ${source.repo})`,
    muster_builtin: true,
    adapted_from,
    license: source.license
  };
  const content = `---\n${stringify(fm, { lineWidth: 0 }).trim()}\n---\n\n${body.trim()}\n`;
  return {
    path: `plugin/builtins/${item.id}/SKILL.md`,
    content,
    catalogEntry: {
      id: item.id, kind: "builtin", roles: item.roles, rank: 50,
      provenance: { adapted_from, license: source.license }
    }
  };
}

export function generateNotice(builtinEntries) {
  const bySrc = new Map();
  for (const e of builtinEntries) {
    const repo = e.provenance.adapted_from.split(" ")[0];
    if (!bySrc.has(repo)) bySrc.set(repo, e.provenance.license);
  }
  let out = "Muster\nCopyright 2026 Adnova Group\n\nThis product bundles adapted content from:\n";
  for (const [repo, lic] of bySrc) out += `\n- ${repo} (${lic})`;
  return out + "\n";
}

const pexec = promisify(execFile);
async function exists(p) { try { await stat(p); return true; } catch { return false; } }

async function resolveSuperpowers(home) {
  const base = join(home, ".claude/plugins/cache/claude-plugins-official/superpowers");
  if (!(await exists(base))) return null;
  const versions = (await readdir(base)).sort().reverse();
  for (const v of versions) {
    const skills = join(base, v, "skills");
    if (await exists(skills)) return skills;
  }
  return null;
}

async function fetchSourceRoot(source, home) {
  if (source.kind === "local") {
    if (source.id === "superpowers") return await resolveSuperpowers(home);
    return null;
  }
  const dir = join(tmpdir(), `muster-vendor-${source.id}`);
  try {
    await pexec("rm", ["-rf", dir]);
    await pexec("git", ["clone", "--depth", "1", "--branch", source.ref || "main",
      `https://github.com/${source.repo}.git`, dir]);
    return dir;
  } catch { return null; }
}

export async function runVendor({ home = homedir(), repoRoot = process.cwd(), manifest } = {}) {
  const warnings = [];
  const allEntries = [];
  for (const source of manifest.sources) {
    const root = await fetchSourceRoot(source, home);
    if (!root) { warnings.push(`source ${source.id}: could not fetch (${source.kind})`); continue; }
    for (const item of source.items) {
      const srcPath = join(root, item.from);
      if (!(await exists(srcPath))) { warnings.push(`${source.id}: missing item ${item.from}`); continue; }
      const text = await readFile(srcPath, "utf8");
      const { path, content, catalogEntry } = toBuiltin(text, item, source);
      const abs = join(repoRoot, path);
      await mkdir(dirname(abs), { recursive: true });
      await writeFile(abs, content);
      allEntries.push(catalogEntry);
    }
  }
  if (allEntries.length === 0) {
    return { count: 0, warnings: [...warnings, "no items vendored — refusing to overwrite NOTICE/builtins.generated.yaml"] };
  }
  await writeFile(join(repoRoot, "catalog/builtins.generated.yaml"), stringify(allEntries, { lineWidth: 0 }));
  await writeFile(join(repoRoot, "NOTICE"), generateNotice(allEntries));
  return { count: allEntries.length, warnings };
}
