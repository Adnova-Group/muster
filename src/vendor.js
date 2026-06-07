import { parse, stringify } from "yaml";

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
  const content = `---\n${stringify(fm).trim()}\n---\n\n${body.trim()}\n`;
  return {
    path: `plugin/skills/builtins/${item.id}/SKILL.md`,
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
