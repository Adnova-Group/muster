// Upstream provenance: vendor/manifest.yaml is the single source of truth for
// which external repository or work (article, book, paper, standard, talk, person)
// every skill, builtin, agent, command, output style and pipeline is based on. This
// module projects the manifest onto items (the `upstream:` frontmatter / top-level
// pipeline key), stamps that projection into the files, and generates NOTICE, the
// catalog provenance summary and the generated block of website/about/credits.md.
//
// Pure + offline: nothing here touches the network. `muster provenance` runs in
// check mode by default (reports drift, unnamed sources and license-gate failures,
// exits non-zero) and rewrites only with `--write`. `muster vendor` emits the identical block for fetched items
// (toBuiltin/toAgent), so the two writers never fight over a file.
import { parse, stringify } from "yaml";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { matchFrontmatter, parseFrontmatterLenient, topLevelBlocks } from "./frontmatter.js";

export const RELATIONS = Object.freeze(["vendored", "adapted", "mechanism-port", "inspired-by"]);
// SPDX ids muster's upstreams actually use. A new upstream license is added here
// deliberately (and reviewed), not accepted by pattern.
export const SPDX_LICENSES = Object.freeze([
  "MIT", "Apache-2.0", "CC0-1.0", "CC-BY-SA-4.0", "CC-BY-NC-SA-4.0", "CC-BY-NC-ND-4.0"
]);
// `pending-owner-decision` stays a recognised value so a manifest can say so, but the
// license gate fails on it: an open question is not a recorded decision.
export const WAIVER_STATUSES = Object.freeze(["pending-owner-decision", "permission-granted", "accepted-risk"]);
// A restricted source Muster carries no text from records the comparison that showed it.
export const LICENSE_REVIEW_FINDINGS = Object.freeze(["ideas-only", "clean-room-rewrite"]);
// Non-repository works an item is based on (articles, books, talks, standards, papers,
// named people). Muster takes ideas, frameworks or structure from these, never text,
// so they are always `inspired-by`. `unknown` records an origin muster's history
// mentions but never names; it carries a dated note saying what was searched.
export const WORK_KINDS = Object.freeze(["article", "book", "paper", "talk", "standard", "person", "unknown"]);
export const isWorkSource = source => WORK_KINDS.includes(source?.kind);
const SHA40_RE = /^[0-9a-f]{40}$/;
const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const DATED_NOTE_RE = /\b\d{4}-\d{2}-\d{2}\b/;

// Item kinds and where each lives. Fetched (vendored) manifest items carry no
// `kind`; they map to builtin, or agent when `as: agent`.
export const ITEM_PATHS = Object.freeze({
  builtin: id => `plugin/builtins/${id}/SKILL.md`,
  agent: id => `plugin/agents/${id}.md`,
  skill: id => `plugin/skills/${id}/SKILL.md`,
  command: id => `plugin/commands/${id}.md`,
  "output-style": id => `plugin/output-styles/${id}.md`,
  pipeline: id => `pipelines/${id}.yaml`,
  "codex-fallback": id => `codex/fallback-skills/${id}/SKILL.md`
});

export const isFetchedSource = source => source?.fetch !== false;
export const itemKind = item => item.kind || (item.as === "agent" ? "agent" : "builtin");
// A file item maps one upstream file onto a muster source file ({from, to, mode, baseBlob}; see
// docs/strategy/stage-2-contracts.md "Sync model"). It has no kind or id: it is never vendored,
// stamped or projected onto an item, but its ref still reaches NOTICE.
export const SYNC_MODES = Object.freeze(["adapted", "verbatim", "watch"]);
export const isFileItem = item => typeof item?.to === "string";
// Only items of a fetched source without an explicit `kind` are copied by `muster vendor`.
export const isVendoredItem = (source, item) => isFetchedSource(source) && !item.kind && !isFileItem(item);

export function isValidLicense(license) {
  if (typeof license !== "string") return false;
  if (license === "NONE" || /^LicenseRef-[A-Za-z0-9.-]+$/.test(license)) return true;
  return license.split(/ (?:AND|OR) /).every(id => SPDX_LICENSES.includes(id));
}
export const isNonCommercialLicense = license => /(^|-)NC(-|$)/.test(String(license));
// Terms that give Muster no right to reuse text: no license at all (all rights reserved),
// NonCommercial, NoDerivatives, or a proprietary LicenseRef.
export const isRestrictedLicense = license =>
  license === "NONE" || /(^|-)(NC|ND)(-|$)/.test(String(license)) || /^LicenseRef-/.test(String(license));

// One upstream entry, keys in a fixed order so serialization is deterministic.
// Repository entries keep their original shape (no `kind` key); work entries lead with it.
export function upstreamEntry(source, item) {
  if (isWorkSource(source)) {
    const entry = {
      kind: source.kind,
      title: source.title ?? null,
      author: source.author ?? null,
      url: source.url ?? null,
      relation: item.relation ?? source.relation
    };
    if (source.kind === "unknown") entry.note = source.note;
    return entry;
  }
  const entry = {
    repo: source.repo,
    ref: item.ref ?? source.ref ?? null,
    path: item.from ?? null,
    license: source.license,
    relation: item.relation ?? source.relation
  };
  if (Array.isArray(source.formerly) && source.formerly.length) entry.formerly = [...source.formerly];
  return entry;
}

const itemKey = (kind, id) => `${kind}:${id}`;

// Map "<kind>:<id>" -> upstream entries, in manifest order (source, then item).
export function projectManifest(manifest) {
  const map = new Map();
  for (const source of manifest?.sources || []) {
    for (const item of source.items || []) {
      if (isFileItem(item)) continue;
      const key = itemKey(itemKind(item), item.id);
      if (!map.has(key)) map.set(key, []);
      map.get(key).push(upstreamEntry(source, item));
    }
  }
  return map;
}

export function renderUpstreamBlock(entries) {
  return stringify({ upstream: entries }, { lineWidth: 0 }).trimEnd();
}

// Remove top-level keys (and their indented / sequence continuation lines) from
// a YAML mapping's text, leaving every other line untouched.
function dropTopLevelKeys(yamlText, keys) {
  return topLevelBlocks(yamlText).filter(b => !keys.includes(b.key)).flatMap(b => b.lines).join("\n");
}

// Markdown items: the block goes at the end of the frontmatter. `adapted_from` /
// `inspired_by` are retired in favour of `upstream` and are removed here.
export function stampMarkdown(text, entries) {
  const m = matchFrontmatter(text);
  if (!m) throw new Error("item has no YAML frontmatter to stamp");
  const eol = m.raw.includes("\r\n") ? "\r\n" : "\n";
  const body = dropTopLevelKeys(m.body.replace(/\r\n/g, "\n"), ["upstream", "adapted_from", "inspired_by"]).replace(/\n+$/, "");
  const header = `---\n${body}\n${renderUpstreamBlock(entries)}\n---\n`.replace(/\n/g, eol);
  return header + m.rest;
}

// Pipelines: a top-level key placed immediately before `phases:`.
export function stampPipeline(text, entries) {
  const stripped = dropTopLevelKeys(text, ["upstream"]);
  const lines = stripped.split("\n");
  const at = lines.findIndex(line => /^phases:/.test(line));
  if (at === -1) throw new Error("pipeline has no top-level phases: key");
  lines.splice(at, 0, ...renderUpstreamBlock(entries).split("\n"));
  return lines.join("\n");
}

export function stampItem(kind, text, entries) {
  return kind === "pipeline" ? stampPipeline(text, entries) : stampMarkdown(text, entries);
}

// The `upstream` value currently recorded in an item, or undefined when absent.
export function readUpstream(kind, text) {
  if (kind === "pipeline") return parse(text)?.upstream;
  const m = matchFrontmatter(text);
  return m ? parseFrontmatterLenient(m.body, parse).upstream : undefined;
}

async function listDir(path) {
  try { return await readdir(path, { withFileTypes: true }); } catch (error) { if (error.code === "ENOENT") return []; throw error; }
}

// Every item on disk that must declare `upstream`. The portable skills/ adapters
// are thin pointers at their canonical plugin/skills entry and are not listed.
export async function discoverItems(root) {
  const items = [];
  const dirItems = async (kind, dir) => {
    for (const e of await listDir(join(root, dir))) if (e.isDirectory()) items.push({ kind, id: e.name });
  };
  const fileItems = async (kind, dir, ext) => {
    for (const e of await listDir(join(root, dir))) if (e.isFile() && e.name.endsWith(ext)) items.push({ kind, id: e.name.slice(0, -ext.length) });
  };
  await dirItems("builtin", "plugin/builtins");
  await fileItems("agent", "plugin/agents", ".md");
  await dirItems("skill", "plugin/skills");
  await fileItems("command", "plugin/commands", ".md");
  await fileItems("output-style", "plugin/output-styles", ".md");
  await fileItems("pipeline", "pipelines", ".yaml");
  await dirItems("codex-fallback", "codex/fallback-skills");
  return items.map(item => ({ ...item, path: ITEM_PATHS[item.kind](item.id) }))
    .sort((a, b) => a.path.localeCompare(b.path));
}

const nonEmpty = v => typeof v === "string" && v.trim().length > 0;

// Does an upstream entry actually name what the item is based on? A repository entry
// names its repo; a work entry names a title or an author; an `unknown` entry names
// nothing, so it must say (in a dated note) what was searched and what is missing.
export function namesSource(entry) {
  if (!entry || typeof entry !== "object") return false;
  if (entry.kind === undefined) return REPO_RE.test(entry.repo || "");
  if (entry.kind === "unknown") return nonEmpty(entry.title) && nonEmpty(entry.note) && DATED_NOTE_RE.test(entry.note);
  return WORK_KINDS.includes(entry.kind) && (nonEmpty(entry.title) || nonEmpty(entry.author));
}

function validateWorkEntry(e, at) {
  const errors = [];
  if (!WORK_KINDS.includes(e.kind)) return [`${at}.kind: must be one of ${WORK_KINDS.join("|")} (omit it for a repository)`];
  if (!namesSource(e)) errors.push(e.kind === "unknown"
    ? `${at}: an unknown origin needs a title and a dated note (YYYY-MM-DD) saying what was searched`
    : `${at}: must name the work (title or author)`);
  if (e.relation !== "inspired-by") errors.push(`${at}.relation: a non-repository work can only be inspired-by (no text is carried from it)`);
  if (e.url !== null && !(typeof e.url === "string" && /^https:\/\//.test(e.url))) errors.push(`${at}.url: must be an https:// URL or null`);
  return errors;
}

// Shape-check one upstream list (invalid relation / license / ref / repo, unnamed work).
export function validateUpstreamEntries(entries) {
  const errors = [];
  if (!Array.isArray(entries)) return ["upstream must be a list ([] for clean-room items)"];
  entries.forEach((e, i) => {
    const at = `upstream[${i}]`;
    if (!e || typeof e !== "object") { errors.push(`${at}: must be a mapping`); return; }
    if (e.kind !== undefined) { errors.push(...validateWorkEntry(e, at)); return; }
    if (!REPO_RE.test(e.repo || "")) errors.push(`${at}.repo: must be owner/name`);
    if (!RELATIONS.includes(e.relation)) errors.push(`${at}.relation: must be one of ${RELATIONS.join("|")}`);
    if (!isValidLicense(e.license)) errors.push(`${at}.license: must be an allowed SPDX id, NONE or LicenseRef-*`);
    if (e.ref !== null && !SHA40_RE.test(String(e.ref))) errors.push(`${at}.ref: must be a 40-hex commit SHA or null`);
    if (e.ref === null && e.relation !== "inspired-by") errors.push(`${at}.ref: only an inspired-by entry may be unpinned`);
    if (e.path !== null && (typeof e.path !== "string" || !e.path || e.path.startsWith("/") || e.path.split("/").includes("..")))
      errors.push(`${at}.path: must be a relative upstream path or null`);
    if (e.formerly !== undefined && (!Array.isArray(e.formerly) || !e.formerly.every(r => REPO_RE.test(r))))
      errors.push(`${at}.formerly: must be a list of owner/name`);
  });
  return errors;
}

// License-risk gate for repositories whose terms give Muster no right to reuse text
// (NONE, NonCommercial, NoDerivatives, proprietary). Returns { errors, waived, reviewed }:
//  - a restricted source that Muster carries vendored or adapted TEXT from needs a
//    licenseWaivers entry with a decided status (permission-granted | accepted-risk);
//    `pending-owner-decision` fails, because nobody has accepted the risk;
//  - a restricted source Muster takes only ideas or mechanisms from carries no waiver
//    but a `licenseReview` ({ date, finding, evidence }) recording the comparison that
//    showed no text was carried (ideas-only) or that it was rewritten (clean-room-rewrite).
export function checkLicenseWaivers(manifest) {
  const waivers = new Map((manifest?.licenseWaivers || []).map(w => [w.source, w]));
  const errors = [];
  const waived = [];
  const reviewed = [];
  for (const source of manifest?.sources || []) {
    if (isWorkSource(source)) continue;
    const textRelations = (source.items || []).map(i => i.relation ?? source.relation).filter(r => r === "vendored" || r === "adapted");
    const restricted = isRestrictedLicense(source.license);
    const waiver = waivers.get(source.id);
    const who = `${source.id} (${source.repo})`;
    if (waiver?.status === "pending-owner-decision")
      errors.push(`${who}: licenseWaivers status is pending-owner-decision; record the owner's decision or rewrite the text clean-room`);
    if (restricted && textRelations.length) {
      if (!waiver) errors.push(`${who}: license ${source.license} with ${textRelations[0]} text and no licenseWaivers entry`);
    } else if (waiver) {
      errors.push(`${who}: licenseWaivers entry for a source Muster carries no text from; record a licenseReview instead`);
    }
    if (restricted && !textRelations.length) {
      const r = source.licenseReview;
      if (!r || !DATED_NOTE_RE.test(String(r.date ?? "")) || !LICENSE_REVIEW_FINDINGS.includes(r.finding) || !nonEmpty(r.evidence))
        errors.push(`${who}: ${source.license} source needs a licenseReview { date, finding: ${LICENSE_REVIEW_FINDINGS.join("|")}, evidence }`);
      else reviewed.push({ source: source.id, repo: source.repo, license: source.license, finding: r.finding, date: String(r.date) });
    }
    if (waiver) waived.push({ source: source.id, repo: source.repo, license: source.license, status: waiver.status, risk: waiver.risk ?? null, text: textRelations.length > 0 });
  }
  for (const id of waivers.keys()) if (!(manifest?.sources || []).some(s => s.id === id)) errors.push(`licenseWaivers: unknown source ${id}`);
  return { errors, waived, reviewed };
}

// Generated NOTICE: every manifest repository once, with license, the refs muster
// pins, the upstream copyright line (MIT requires it travel with the copy) and
// any former name.
export const NOTICE_BANNER = "GENERATED by `muster vendor` from vendor/manifest.yaml — do not edit";
export function generateNotice(manifest) {
  const byRepo = new Map();
  for (const source of manifest?.sources || []) {
    if (!source.repo) continue;
    const row = byRepo.get(source.repo) || { license: source.license, refs: [], copyright: null, formerly: [], waived: false };
    const refs = [source.ref, ...(source.items || []).map(i => i.ref)].filter(Boolean);
    for (const ref of refs) if (!row.refs.includes(ref)) row.refs.push(ref);
    row.copyright ||= source.copyright || null;
    for (const f of source.formerly || []) if (!row.formerly.includes(f)) row.formerly.push(f);
    byRepo.set(source.repo, row);
  }
  let out = `${NOTICE_BANNER}\n\nMuster\nCopyright 2026 Adnova Group\n\n` +
    "This product includes or is based on material from the repositories below.\n" +
    "Per-item detail (upstream path, ref, relation) is in each item's `upstream:` field.\n";
  for (const [repo, row] of byRepo) {
    out += `\n- ${repo}${row.refs.length ? ` @ ${row.refs.join(", ")}` : ""} (${row.license})`;
    if (row.formerly.length) out += `\n  formerly: ${row.formerly.join(", ")}`;
    if (row.copyright) out += `\n  ${row.copyright}`;
  }
  const works = (manifest?.sources || []).filter(s => isWorkSource(s) && s.kind !== "unknown");
  if (works.length) {
    out += "\n\nItems are also based on the works below. Muster takes ideas, frameworks or structure\n" +
      "from them and carries none of their text; they are credited, not reproduced.\n";
    for (const w of works) {
      out += `\n- ${workLabel(w)} (${w.kind})`;
      if (w.url) out += `\n  ${w.url}`;
    }
  }
  if ([...byRepo.values()].some(row => row.license.split(/ (?:AND|OR) /).includes("MIT"))) out += `\n\n${MIT_PERMISSION}`;
  return out + "\n";
}

// "Title, Author" for a work, either part optional.
export const workLabel = w => [w.title, w.author].filter(nonEmpty).join(", ");

// The MIT permission notice, reproduced once for every MIT-licensed source above
// (each source's own copyright line is listed with it).
const MIT_PERMISSION = `For each source above licensed under MIT, the following permission notice applies:

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.`;

// Catalog provenance is a compact summary of the item record: the repositories only.
export const upstreamRepos = entries => [...new Set(entries.filter(e => e.repo).map(e => e.repo))];

function stampCatalogMuster(text, projection, kind) {
  return text.replace(/^(- id: (\S+)[\s\S]*?\n)(\s+)provenance: \{([^\n]*)\}/gm, (all, head, id, indent, inner) => {
    const entries = projection.get(itemKey(kind, id)) || [];
    const license = (inner.match(/license: "?([^",}\s]+)"?/) || [])[1];
    return `${head}${indent}provenance: { license: ${license}, upstream: [${upstreamRepos(entries).join(", ")}] }`;
  });
}

function stampCatalogGenerated(text, projection) {
  const banner = text.startsWith("#") ? text.slice(0, text.indexOf("\n") + 1) : "";
  const entries = parse(text) || [];
  for (const e of entries) {
    const license = e.provenance?.license;
    e.provenance = { license, upstream: upstreamRepos(projection.get(itemKey(e.kind, e.id)) || []) };
  }
  return banner + stringify(entries, { lineWidth: 0 });
}

const CATALOGS = [
  { path: "catalog/builtins.generated.yaml", stamp: (t, p) => stampCatalogGenerated(t, p) },
  { path: "catalog/agents.generated.yaml", stamp: (t, p) => stampCatalogGenerated(t, p) },
  { path: "catalog/builtins.muster.yaml", stamp: (t, p) => stampCatalogMuster(t, p, "builtin") },
  { path: "catalog/agents.muster.yaml", stamp: (t, p) => stampCatalogMuster(t, p, "agent") }
];
export const NOTICE_PATHS = Object.freeze(["NOTICE", "cowork/NOTICE"]);

// Check (default) or rewrite every generated provenance surface. Returns the
// paths whose content differs from the manifest projection.
export async function runProvenance({ root, manifest, write = false }) {
  const projection = projectManifest(manifest);
  const items = await discoverItems(root);
  const onDisk = new Set(items.map(i => itemKey(i.kind, i.id)));
  const orphans = [...projection.keys()].filter(k => !onDisk.has(k));
  const drift = [];
  const counts = { items: items.length, withUpstream: 0, cleanRoom: 0 };
  const sync = async (path, next) => {
    const current = await readFile(join(root, path), "utf8").catch(e => (e.code === "ENOENT" ? null : Promise.reject(e)));
    if (current === next) return;
    drift.push(path);
    if (write) await writeFile(join(root, path), next);
  };
  for (const item of items) {
    const entries = projection.get(itemKey(item.kind, item.id)) || [];
    entries.length ? counts.withUpstream++ : counts.cleanRoom++;
    const text = await readFile(join(root, item.path), "utf8");
    await sync(item.path, stampItem(item.kind, text, entries));
  }
  for (const { path, stamp } of CATALOGS) {
    const text = await readFile(join(root, path), "utf8").catch(e => (e.code === "ENOENT" ? null : Promise.reject(e)));
    if (text !== null) await sync(path, stamp(text, projection));
  }
  const notice = generateNotice(manifest);
  for (const path of NOTICE_PATHS) await sync(path, notice);
  const credits = await readFile(join(root, CREDITS_PATH), "utf8").catch(e => (e.code === "ENOENT" ? null : Promise.reject(e)));
  const problems = [];
  if (credits !== null) {
    const next = stampCredits(credits, manifest);
    if (next === null) problems.push(`${CREDITS_PATH}: missing the ${CREDITS_BEGIN} / ${CREDITS_END} markers`);
    else await sync(CREDITS_PATH, next);
  }
  // Every recorded entry must name its source, and the license gate must hold.
  for (const [key, entries] of projection) for (const e of validateUpstreamEntries(entries)) problems.push(`${key}: ${e}`);
  problems.push(...checkLicenseWaivers(manifest).errors);
  return { ok: drift.length === 0 && orphans.length === 0 && problems.length === 0, written: write, drift, orphans, problems, counts };
}

// website/about/credits.md carries a generated block between these markers: every
// non-vendored repository, every work, and every origin still unidentified, with the
// items each one is the basis for. The prose around the block stays hand-written.
export const CREDITS_PATH = "website/about/credits.md";
export const CREDITS_BEGIN = "<!-- BEGIN GENERATED by `muster provenance --write` from vendor/manifest.yaml; do not edit -->";
export const CREDITS_END = "<!-- END GENERATED -->";

const itemList = items => [...new Set(items.map(i => `\`${i.id}\``))].join(", ");
const cell = s => String(s).replace(/\|/g, "\\|");

export function generateCreditsBlock(manifest) {
  const sources = manifest?.sources || [];
  let out = "### Repositories\n\n| Source | License | Basis for | Relation |\n| --- | --- | --- | --- |\n";
  for (const s of sources.filter(s => !isWorkSource(s))) {
    const relations = [...new Set((s.items || []).map(i => i.relation ?? s.relation))].join(", ");
    const basis = isFetchedSource(s) ? `${(s.items || []).length} vendored builtins and agents` : itemList(s.items || []);
    out += `| [${s.repo}](https://github.com/${s.repo})${s.ref ? ` @ \`${s.ref.slice(0, 12)}\`` : ""} | ${s.license} | ${basis} | ${relations} |\n`;
  }
  const works = sources.filter(s => isWorkSource(s) && s.kind !== "unknown");
  out += "\n### Works\n\nArticles, books, papers, standards, talks and people whose ideas, frameworks or structure an item is based on. No text is carried from them.\n\n" +
    "| Work | Kind | Basis for |\n| --- | --- | --- |\n";
  for (const w of works) out += `| ${w.url ? `[${cell(w.title ?? w.author)}](${w.url})` : cell(w.title ?? w.author)}${w.title && w.author ? `, ${cell(w.author)}` : ""} | ${w.kind} | ${itemList(w.items || [])} |\n`;
  const unknown = sources.filter(s => s.kind === "unknown");
  if (unknown.length) {
    out += "\n### Origins not yet identified\n\nMuster's history says these items drew on sources it never named. Each note records what was searched.\n\n" +
      "| What | Note | Basis for |\n| --- | --- | --- |\n";
    for (const u of unknown) out += `| ${cell(u.title)} | ${cell(u.note)} | ${itemList(u.items || [])} |\n`;
  }
  return out;
}

// Replace the generated block of credits.md; null when the markers are missing.
export function stampCredits(text, manifest) {
  const begin = text.indexOf(CREDITS_BEGIN);
  const end = text.indexOf(CREDITS_END);
  if (begin === -1 || end === -1 || end < begin) return null;
  return `${text.slice(0, begin)}${CREDITS_BEGIN}\n\n${generateCreditsBlock(manifest)}\n${text.slice(end)}`;
}

// Codex has no frontmatter channel for provenance, so the Codex bundle ships
// this generated table next to NOTICE.
export function generateProvenanceMarkdown(manifest) {
  const projection = projectManifest(manifest);
  const rows = [...projection.entries()].sort(([a], [b]) => a.localeCompare(b));
  let out = `# Provenance\n\n${NOTICE_BANNER}.\n\nEvery Muster item based on an external repository or work, as recorded in vendor/manifest.yaml. ` +
    "Items not listed are Muster-authored (`upstream: []`). Relations: vendored (upstream text carried essentially unchanged), " +
    "adapted (upstream text edited), mechanism-port (mechanism re-implemented in new text), inspired-by (idea or structure only).\n\n" +
    "| Item | Upstream | Ref | Path | License | Relation |\n| --- | --- | --- | --- | --- | --- |\n";
  for (const [key, entries] of rows) {
    for (const e of entries) {
      if (e.kind !== undefined) {
        const what = e.kind === "unknown" ? `unidentified: ${cell(e.title)} (${cell(e.note)})` : `${cell(workLabel(e))} (${e.kind})`;
        out += `| ${key} | ${what} | n/a | ${e.url ?? "n/a"} | n/a | ${e.relation} |\n`;
        continue;
      }
      out += `| ${key} | ${e.repo}${e.formerly ? ` (formerly ${e.formerly.join(", ")})` : ""} | ${e.ref ?? "unpinned"} | ${e.path ?? "(repository)"} | ${e.license} | ${e.relation} |\n`;
    }
  }
  return out;
}
