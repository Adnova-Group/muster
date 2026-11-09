// Upstream provenance: vendor/manifest.yaml is the single source of truth for
// which external repository every skill, builtin, agent, command, output style
// and pipeline is based on. This module projects the manifest onto items (the
// `upstream:` frontmatter / top-level pipeline key), stamps that projection into
// the files, and generates NOTICE + the catalog provenance summary from it.
//
// Pure + offline: nothing here touches the network. `muster provenance` runs in
// check mode by default (reports drift, exits non-zero) and rewrites only with
// `--write`. `muster vendor` emits the identical block for fetched items
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
export const WAIVER_STATUSES = Object.freeze(["pending-owner-decision", "permission-granted", "accepted-risk"]);
const SHA40_RE = /^[0-9a-f]{40}$/;
const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

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

// One upstream entry, keys in a fixed order so serialization is deterministic.
export function upstreamEntry(source, item) {
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

// Shape-check one upstream list (invalid relation / license / ref / repo).
export function validateUpstreamEntries(entries) {
  const errors = [];
  if (!Array.isArray(entries)) return ["upstream must be a list ([] for clean-room items)"];
  entries.forEach((e, i) => {
    const at = `upstream[${i}]`;
    if (!e || typeof e !== "object") { errors.push(`${at}: must be a mapping`); return; }
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

// License-risk gate. Returns { errors, waived }:
//  - a NONE-licensed source that Muster carries vendored or adapted TEXT from is an
//    error unless licenseWaivers names it;
//  - every NONE or NonCommercial source must have a waiver entry at all, so the risk
//    stays visible in one place even when only ideas were taken.
export function checkLicenseWaivers(manifest) {
  const waivers = new Map((manifest?.licenseWaivers || []).map(w => [w.source, w]));
  const errors = [];
  const waived = [];
  for (const source of manifest?.sources || []) {
    const textRelations = (source.items || []).map(i => i.relation ?? source.relation).filter(r => r === "vendored" || r === "adapted");
    const risky = source.license === "NONE" || isNonCommercialLicense(source.license);
    const waiver = waivers.get(source.id);
    if (source.license === "NONE" && textRelations.length && !waiver)
      errors.push(`${source.id} (${source.repo}): license NONE with ${textRelations[0]} text and no licenseWaivers entry`);
    else if (risky && !waiver)
      errors.push(`${source.id} (${source.repo}): ${source.license} source needs a licenseWaivers entry`);
    if (waiver) waived.push({ source: source.id, repo: source.repo, license: source.license, status: waiver.status, risk: waiver.risk ?? null, text: textRelations.length > 0 });
  }
  for (const id of waivers.keys()) if (!(manifest?.sources || []).some(s => s.id === id)) errors.push(`licenseWaivers: unknown source ${id}`);
  return { errors, waived };
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
  if ([...byRepo.values()].some(row => row.license.split(/ (?:AND|OR) /).includes("MIT"))) out += `\n\n${MIT_PERMISSION}`;
  return out + "\n";
}

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
export const upstreamRepos = entries => [...new Set(entries.map(e => e.repo))];

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
  return { ok: drift.length === 0 && orphans.length === 0, written: write, drift, orphans, counts };
}

// Codex has no frontmatter channel for provenance, so the Codex bundle ships
// this generated table next to NOTICE.
export function generateProvenanceMarkdown(manifest) {
  const projection = projectManifest(manifest);
  const rows = [...projection.entries()].sort(([a], [b]) => a.localeCompare(b));
  let out = `# Provenance\n\n${NOTICE_BANNER}.\n\nEvery Muster item based on an external repository, as recorded in vendor/manifest.yaml. ` +
    "Items not listed are Muster-authored (`upstream: []`). Relations: vendored (upstream text carried essentially unchanged), " +
    "adapted (upstream text edited), mechanism-port (mechanism re-implemented in new text), inspired-by (idea or structure only).\n\n" +
    "| Item | Upstream | Ref | Path | License | Relation |\n| --- | --- | --- | --- | --- | --- |\n";
  for (const [key, entries] of rows) {
    for (const e of entries) {
      out += `| ${key} | ${e.repo}${e.formerly ? ` (formerly ${e.formerly.join(", ")})` : ""} | ${e.ref ?? "unpinned"} | ${e.path ?? "(repository)"} | ${e.license} | ${e.relation} |\n`;
    }
  }
  return out;
}
