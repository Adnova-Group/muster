// Upstream sync for merge-tracked sources: any vendor/manifest.yaml source whose
// items carry a `mode` (gsd, superpowers, wshobson, and the UX sources uupm, intent,
// typeui and pfd). The old `muster vendor` path regenerates over local edits, which is
// how hand adaptations were lost. A merge-tracked source records `ref` + `tag` (the
// release it is pinned to, `null` for an untagged upstream, or a `git describe` pin
// between releases) and, per item:
//
//   from      upstream path
//   to        muster path (adapted / verbatim items)
//   mode      adapted   muster file is an edited copy: 3-way `git merge-file`
//             verbatim  upstream text carried inside marked verbatim regions of `to`:
//                       the regions are regenerated from the new upstream lines.
//                       A verbatim FILE item (no id, sole item for its `to`) is a
//                       whole-file byte copy instead: `to` is its own base copy
//                       (its blob must equal baseBlob) and an update replaces it.
//             watch     never merged; listed in the report only
//   baseBlob  git blob SHA of `from` at the pinned ref
//   issues    upstream issue numbers whose mechanisms the item carries
//   roles     (optional, builtin/agent items) catalog roles; `rank` optional. The
//             item is registered in catalog/{builtins,agents}.generated.yaml by
//             `muster vendor` (syncCatalogEntries) without being regenerated.
//
// An item with id + kind is a muster item (its `to` is the item's own path); a file
// item ({from, to, mode, baseBlob}, no id) maps any other upstream file onto a muster
// file: a skill's supporting file, or a port into another language.
//
// Byte-exact base copies live under vendor/upstream/<source>/<from>, the merge base.
// `muster vendor update <source> --to <tag>` merges, writes conflict markers where it
// cannot, and moves the base copies and the manifest pin only when every item merged
// cleanly.
//
// Everything that touches git or the network goes through an injectable
// `upstream` object ({ resolve, readFile, fileHistory, commitsCiting }), so the
// merge and report logic is unit-tested against a local fixture repository.
import { createHash } from "node:crypto";
import { readFile, writeFile, mkdir, mkdtemp, rm, readdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { parseVerbatimRegions, checkVerbatimRegions, linesOf, gsdCouplingHits, VERBATIM_OPEN_RE } from "./vendor-regions.js";

const pexec = promisify(execFile);
export const SYNC_MODES = Object.freeze(["adapted", "verbatim", "watch"]);
const SHA40_RE = /^[0-9a-f]{40}$/;
// Release tags only: no leading dash (git would read an option), no refspec characters.
export const TAG_RE = /^v?\d+\.\d+\.\d+(?:[-.][0-9A-Za-z.]+)?$/;
// A pin between releases records `git describe --tags --long` of its ref
// (<release>-<commits since>-g<abbrev sha>) as its tag. The abbreviated sha must
// prefix the pinned ref; the fetch then pins the commit itself, not a tag.
export const DESCRIBE_RE = /^(v?\d+\.\d+\.\d+)-(\d+)-g([0-9a-f]{7,40})$/;
export const isDescribePin = source => {
  const m = String(source?.tag ?? "").match(DESCRIBE_RE);
  return Boolean(m && String(source.ref ?? "").startsWith(m[3]));
};

export const isSyncItem = item => item != null && item.mode !== undefined;
export const isSyncSource = source => (source?.items || []).some(isSyncItem);
export const syncItemsOf = source => (source?.items || []).filter(isSyncItem);
export const baseCopyPath = (sourceId, from) => `vendor/upstream/${sourceId}/${from}`;
export const reportPath = (sourceId, tag) => `vendor/reports/${sourceId}-${tag}.md`;

// The git blob id of `content` (what `git hash-object` prints), without git.
export function gitBlobSha(content) {
  const bytes = Buffer.from(content);
  return createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
}

// Shape errors for one merge-tracked item. `itemPath(kind, id)` is ITEM_PATHS
// from provenance.js, passed in to keep this module free of that import cycle.
const relPath = p => typeof p === "string" && p !== "" && !p.startsWith("/") && !p.split("/").includes("..");

// Item shapes:
//   item       {id, kind, from, to, mode: adapted|verbatim, baseBlob} - `to` is the item's own
//              path (ITEM_PATHS); projected onto its `upstream:` field
//   file item  {from, to, mode, baseBlob} - an upstream file mapped onto a muster source file
//              (e.g. a TypeScript gate ported into src/plan-lint.js); never projected
//   watch      {from, mode: watch, baseBlob, to?} - report only; `to` names the consumer
// An item may repeat the source pin as `ref`; it must equal the source's ref.
export function validateSyncItem(item, at, itemPath, sourceRef) {
  const errors = [];
  if (!SYNC_MODES.includes(item.mode)) errors.push(`${at}.mode: must be one of ${SYNC_MODES.join("|")}`);
  if (!relPath(item.from)) errors.push(`${at}.from: must be a relative upstream path`);
  if (!SHA40_RE.test(String(item.baseBlob))) errors.push(`${at}.baseBlob: must be the 40-hex git blob SHA of from at the pin`);
  if (item.ref !== undefined && item.ref !== sourceRef) errors.push(`${at}.ref: a merge-tracked item shares its source's pin (${sourceRef})`);
  if (item.issues !== undefined && (!Array.isArray(item.issues) || !item.issues.every(n => Number.isInteger(n) && n > 0)))
    errors.push(`${at}.issues: must be a list of upstream issue numbers`);
  if (item.to !== undefined && !relPath(item.to)) errors.push(`${at}.to: must be a relative repository path`);
  if (item.roles !== undefined && (!Array.isArray(item.roles) || !item.roles.length || !item.roles.every(r => typeof r === "string" && r)))
    errors.push(`${at}.roles: must be a non-empty list of role names`);
  if (item.roles !== undefined && !["builtin", "agent"].includes(item.kind)) errors.push(`${at}.roles: only a builtin or agent item is registered in the catalog`);
  if (item.rank !== undefined && (item.roles === undefined || !Number.isFinite(item.rank))) errors.push(`${at}.rank: a number, on an item with roles`);
  if ((item.id === undefined) !== (item.kind === undefined)) errors.push(`${at}: id and kind come together (or neither, for a file item)`);
  if (item.mode === "watch") {
    if (item.id !== undefined || item.kind !== undefined) errors.push(`${at}: a watch item carries no id or kind (it is never copied into muster)`);
  } else if (SYNC_MODES.includes(item.mode)) {
    if (item.to === undefined) errors.push(`${at}.to: an ${item.mode} item names the muster file it lives in`);
    else if (item.id && item.kind && itemPath(item.kind, item.id) && item.to !== itemPath(item.kind, item.id))
      errors.push(`${at}.to: must be ${itemPath(item.kind, item.id)}`);
  }
  return errors;
}

// An adapted item is merged with git merge-file only when its muster file is an edited
// copy of exactly that upstream file. A port (another language, or several upstream files
// folded into one muster file) cannot be 3-way merged: it is reported as a port to redo.
export const needsBaseCopy = (item, items) => (item.mode === "verbatim" && !isWholeFileVerbatim(item, items)) || isMergeable(item, items);

// A verbatim file item that alone owns its muster file is a byte-for-byte copy of the
// upstream file (data, scripts, unedited references): the muster file is the base copy.
export function isWholeFileVerbatim(item, items) {
  return item.mode === "verbatim" && item.id === undefined && item.to !== undefined &&
    items.filter(i => i.mode !== "watch" && i.to === item.to).length === 1;
}

export function isMergeable(item, items) {
  if (item.mode !== "adapted") return false;
  const ext = p => (p.match(/\.[^./]+$/) || [""])[0];
  return ext(item.from) === ext(item.to) && items.filter(i => i.mode === "adapted" && i.to === item.to).length === 1;
}

export function validateSyncSource(source, at) {
  const errors = [];
  if (!SHA40_RE.test(String(source.ref))) errors.push(`${at}.ref: a merge-tracked source pins a 40-hex commit SHA`);
  // An upstream that publishes no release tags (wshobson/agents) records `tag: null` and is
  // pinned by its commit SHA alone; a pin between releases records `git describe --tags --long`.
  if (source.tag !== null && !TAG_RE.test(String(source.tag)) && !isDescribePin(source))
    errors.push(`${at}.tag: a merge-tracked source records the release tag of its ref (null for an untagged upstream, or its git describe --tags --long between releases)`);
  return errors;
}

// Catalog entries for a merge-tracked source's builtin/agent items that carry roles,
// in manifest order and in the shape `muster vendor`'s toBuiltin / toAgent emit, so
// catalog/*.generated.yaml keeps listing them although they are never regenerated.
export function syncCatalogEntries(source) {
  const builtins = [];
  const agents = [];
  for (const item of syncItemsOf(source)) {
    if (item.mode === "watch" || !item.id || !Array.isArray(item.roles)) continue;
    const provenance = { license: source.license, upstream: [source.repo] };
    if (item.kind === "builtin") {
      const entry = { id: item.id, kind: "builtin", roles: item.roles, rank: item.rank !== undefined ? item.rank : 50, provenance };
      if (item.description) entry.description = item.description;
      builtins.push(entry);
    } else if (item.kind === "agent") {
      const entry = { id: item.id, kind: "agent", roles: item.roles, rank: item.rank !== undefined ? item.rank : 50 };
      if (item.description) entry.description = item.description;
      agents.push({ ...entry, provenance });
    }
  }
  return { builtins, agents };
}

// ---- line mapping (pure) -------------------------------------------------------

// For each old line index, the index of the same line in `next` under a longest
// common subsequence alignment, or -1 when the line did not survive.
export function mapLines(prev, next) {
  const map = new Int32Array(prev.length).fill(-1);
  let head = 0;
  while (head < prev.length && head < next.length && prev[head] === next[head]) { map[head] = head; head++; }
  let tail = 0;
  while (tail < prev.length - head && tail < next.length - head && prev[prev.length - 1 - tail] === next[next.length - 1 - tail]) {
    map[prev.length - 1 - tail] = next.length - 1 - tail; tail++;
  }
  const a = prev.slice(head, prev.length - tail);
  const b = next.slice(head, next.length - tail);
  const n = a.length, m = b.length;
  if (n && m) {
    const w = m + 1;
    const dp = new Int32Array((n + 1) * w);
    for (let i = n - 1; i >= 0; i--)
      for (let j = m - 1; j >= 0; j--)
        dp[i * w + j] = a[i] === b[j] ? dp[(i + 1) * w + j + 1] + 1 : Math.max(dp[(i + 1) * w + j], dp[i * w + j + 1]);
    for (let i = 0, j = 0; i < n && j < m;) {
      if (a[i] === b[j]) { map[head + i] = head + j; i++; j++; }
      else if (dp[(i + 1) * w + j] >= dp[i * w + j + 1]) i++;
      else j++;
    }
  }
  return map;
}

// Where lines first..last (1-based) of `prevText` live in `nextText`. An endpoint
// that did not survive falls back to the nearest surviving neighbour outside the
// range, so an edit at a region's edge is carried rather than dropped. Returns
// null when the whole range was deleted upstream.
export function mapRange(prevText, nextText, first, last) {
  const prev = prevText.split("\n");
  const next = nextText.split("\n");
  const map = mapLines(prev, next);
  let start = map[first - 1];
  let end = map[last - 1];
  if (start < 0) {
    let i = first - 2;
    while (i >= 0 && map[i] < 0) i--;
    start = i >= 0 ? map[i] + 1 : 0;
  }
  if (end < 0) {
    let j = last;
    while (j < prev.length && map[j] < 0) j++;
    end = j < prev.length ? map[j] - 1 : next.length - 1;
  }
  if (end < start) return null;
  return { first: start + 1, last: end + 1, exact: map[first - 1] >= 0 && map[last - 1] >= 0 };
}

// ---- verbatim region regeneration (pure) --------------------------------------

function conflictBlock(ours, theirs, label) {
  return [`<<<<<<< muster`, ...(ours ? [ours] : []), `=======`, ...(theirs ? [theirs] : []), `>>>>>>> ${label}`].join("\n");
}

// Refresh every verbatim region of `text` that quotes `source` from the new upstream
// (regions quoting another source are left alone). `bases` maps an
// upstream path to { prev, next, tag } (prev = base copy at the pin, next = text
// at the target, null when the file was removed). Returns the new text, the
// conflicts (each also written into the region as markers) and notes.
export function regenerateRegions(text, bases, { source } = {}) {
  if (!source) throw new Error("regenerateRegions: the merge-tracked source id is required");
  const { regions, errors } = parseVerbatimRegions(text);
  const conflicts = errors.map(detail => ({ kind: "region", detail }));
  const notes = [];
  if (errors.length) return { text, conflicts, notes };
  const lines = text.split("\n");
  // Rewrite bottom-up so earlier line numbers stay valid.
  for (const r of [...regions].reverse()) {
    const at = `${r.path}:${r.start}-${r.end}`;
    if (r.source !== source) continue;
    const entry = bases.get(r.path);
    if (!entry) { conflicts.push({ kind: "region", detail: `${at}: no manifest item tracks this upstream path` }); continue; }
    const carried = linesOf(entry.prev, r.start, r.end);
    if (entry.next === null) {
      conflicts.push({ kind: "region", detail: `${at}: file removed upstream at ${entry.tag}` });
      lines.splice(r.openLine, r.closeLine - r.openLine - 1, conflictBlock(r.body, "", `${entry.tag} (file removed)`));
      continue;
    }
    const range = mapRange(entry.prev, entry.next, r.start, r.end);
    const fresh = range ? linesOf(entry.next, range.first, range.last) : null;
    if (r.body !== carried && r.body !== fresh) {
      conflicts.push({ kind: "region", detail: `${at}: region was edited in muster (differs from the base copy)` });
      lines.splice(r.openLine, r.closeLine - r.openLine - 1, conflictBlock(r.body, fresh, `${entry.tag} ${r.path}${range ? `:${range.first}-${range.last}` : ""}`));
      continue;
    }
    if (!range) {
      conflicts.push({ kind: "region", detail: `${at}: region deleted upstream at ${entry.tag}` });
      lines.splice(r.openLine, r.closeLine - r.openLine - 1, conflictBlock(r.body, "", `${entry.tag} (region deleted)`));
      continue;
    }
    // Applies to every source: gsd runtime coupling must not enter muster through any quoted region.
    const coupling = gsdCouplingHits(fresh);
    if (coupling.length) {
      conflicts.push({ kind: "region", detail: `${at}: upstream region now carries gsd runtime coupling (${coupling[0].match})` });
      lines.splice(r.openLine, r.closeLine - r.openLine - 1, conflictBlock(r.body, fresh, `${entry.tag} ${r.path}:${range.first}-${range.last}`));
      continue;
    }
    if (!range.exact) notes.push(`${at}: an edge line changed upstream; region re-anchored to ${range.first}-${range.last}, review it`);
    lines.splice(r.openLine - 1, r.closeLine - r.openLine + 1,
      lines[r.openLine - 1].replace(VERBATIM_OPEN_RE, `<!-- verbatim: ${r.source} ${r.path}:${range.first}-${range.last} -->`),
      ...fresh.split("\n"),
      lines[r.closeLine - 1]);
  }
  return { text: lines.join("\n"), conflicts, notes };
}

// ---- git-backed pieces (injectable) -------------------------------------------

// 3-way merge of one adapted file. Returns { text, conflicts } where conflicts is
// git merge-file's count of conflicting hunks (markers are left in `text`).
export async function mergeFile({ ours, base, theirs, labels = ["muster", "base", "upstream"], exec = pexec }) {
  const dir = await mkdtemp(join(tmpdir(), "muster-merge-"));
  try {
    const [o, b, t] = ["ours", "base", "theirs"].map(n => join(dir, n));
    await writeFile(o, ours); await writeFile(b, base); await writeFile(t, theirs);
    const args = ["merge-file", "-p", "-L", labels[0], "-L", labels[1], "-L", labels[2], o, b, t];
    try {
      const { stdout } = await exec("git", args, { maxBuffer: 64 << 20 });
      return { text: stdout, conflicts: 0 };
    } catch (error) {
      // merge-file exits with the number of conflicts (1..127); negative / >127 is an error.
      if (typeof error.code === "number" && error.code > 0 && error.code < 128 && typeof error.stdout === "string")
        return { text: error.stdout, conflicts: error.code };
      throw error;
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// An upstream backed by a local git repository holding both refs (a fetched
// temp clone in production, a fixture repository in tests).
export function gitUpstream(dir, { exec = pexec } = {}) {
  const git = async args => (await exec("git", ["-C", dir, ...args], { maxBuffer: 64 << 20 })).stdout;
  return {
    async resolve(ref) { return (await git(["rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`])).trim(); },
    async readFile(ref, path) {
      try { return await git(["show", `${ref}:${path}`]); } catch { return null; }
    },
    async fileHistory(from, to, path) {
      const log = (await git(["log", "--format=%H%x1f%s", `${from}..${to}`, "--", path])).split("\n").filter(Boolean)
        .map(line => { const [sha, subject] = line.split("\x1f"); return { sha, subject }; });
      let added = 0, deleted = 0;
      for (const line of (await git(["diff", "--numstat", from, to, "--", path])).split("\n").filter(Boolean)) {
        const [a, d] = line.split("\t");
        added += Number(a) || 0; deleted += Number(d) || 0;
      }
      return { commits: log, added, deleted };
    },
    async commitsCiting(from, to, issues) {
      const wanted = new Set(issues.map(Number));
      if (!wanted.size) return [];
      const raw = await git(["log", "--format=%H%x1f%s%x1f%b%x1e", `${from}..${to}`]);
      const out = [];
      for (const record of raw.split("\x1e")) {
        const [sha, subject, body = ""] = record.replace(/^\n/, "").split("\x1f");
        if (!sha) continue;
        const cited = [...new Set([...`${subject}\n${body}`.matchAll(/#(\d+)\b/g)].map(m => Number(m[1])))].filter(n => wanted.has(n));
        if (cited.length) out.push({ sha, subject, issues: cited.sort((x, y) => x - y) });
      }
      return out;
    }
  };
}

// Production fetch: a blobless temp clone holding the pin tag and the target tag.
// Network. Returns { upstream, cleanup }.
export async function fetchUpstream(source, toTag, { exec = pexec } = {}) {
  if (!TAG_RE.test(toTag)) throw new Error(`invalid tag ${toTag}`);
  const describe = isDescribePin(source);
  if (!describe && !TAG_RE.test(String(source.tag))) throw new Error(`source ${source.id} records no valid pin tag`);
  const url = source.url || `https://github.com/${source.repo}.git`;
  const root = await mkdtemp(join(tmpdir(), "muster-upstream-"));
  const dir = join(root, "repo");
  try {
    await exec("git", ["init", "-q", dir]);
    await exec("git", ["-C", dir, "remote", "add", "origin", url]);
    // A describe pin is fetched by commit (GitHub serves any reachable sha) instead of by tag.
    const refspecs = [...new Set(describe ? [toTag] : [source.tag, toTag])].map(t => `+refs/tags/${t}:refs/tags/${t}`);
    if (describe) refspecs.push(`+${source.ref}:refs/muster/pin`);
    await exec("git", ["-C", dir, "fetch", "-q", "--filter=blob:none", "--no-tags", "origin", ...refspecs], { maxBuffer: 64 << 20 });
    const upstream = gitUpstream(dir, { exec });
    const pinned = await upstream.resolve(describe ? "refs/muster/pin" : `refs/tags/${source.tag}`);
    if (pinned !== source.ref) throw new Error(`pin ${source.tag} resolves to ${pinned}, but the manifest pins ${source.ref}`);
    return { upstream, cleanup: () => rm(root, { recursive: true, force: true }) };
  } catch (error) {
    await rm(root, { recursive: true, force: true });
    throw error;
  }
}

// ---- report (pure over the upstream interface) --------------------------------

export async function buildReport({ source, toTag, toSha, upstream }) {
  const items = syncItemsOf(source);
  const rows = [];
  const sections = [];
  const seen = new Set();
  for (const item of items) {
    const key = `${item.from}`;
    const history = await upstream.fileHistory(source.ref, toSha, item.from);
    const exists = (await upstream.readFile(toSha, item.from)) !== null;
    const citing = await upstream.commitsCiting(source.ref, toSha, item.issues || []);
    const touched = history.commits.length > 0 || !exists;
    rows.push({ item, history, exists, citing, touched });
    if (seen.has(key)) continue;
    seen.add(key);
    let s = `### ${item.from}\n\nMode: ${item.mode}${item.to ? ` -> ${item.to}` : ""}. ` +
      `${exists ? "" : "**Removed upstream.** "}${history.commits.length} commit(s), +${history.added}/-${history.deleted} lines.\n`;
    if (history.commits.length) s += `\nCommits touching the file:\n\n${history.commits.map(c => `- ${c.sha.slice(0, 7)} ${c.subject}`).join("\n")}\n`;
    if (item.issues?.length) {
      s += `\nCommits citing ${item.issues.map(n => `#${n}`).join(", ")}:\n\n`;
      s += citing.length ? `${citing.map(c => `- ${c.sha.slice(0, 7)} ${c.subject} (${c.issues.map(n => `#${n}`).join(", ")})`).join("\n")}\n` : "- none\n";
    }
    sections.push(s);
  }
  const touched = rows.filter(r => r.touched);
  const table = rows.map(({ item, history, exists, citing }) =>
    `| ${item.from} | ${item.mode} | ${item.to ?? "-"} | ${exists ? history.commits.length : "removed"} | +${history.added}/-${history.deleted} | ${citing.length} |`).join("\n");
  const text = `# ${source.id} upstream report: ${source.tag} -> ${toTag}\n\n` +
    `Generated by \`muster vendor report ${source.id} --to ${toTag}\` from vendor/manifest.yaml. ` +
    `Pin ${source.ref} (${source.tag}); target ${toSha} (${toTag}). ` +
    `${touched.length} of ${rows.length} tracked item(s) changed upstream. ` +
    "Adapted items merge with `muster vendor update`; verbatim regions regenerate; watch items are read for mechanism changes and never merged.\n\n" +
    "| Upstream path | Mode | Muster file | Commits | Lines | Issue-citing commits |\n| --- | --- | --- | --- | --- | --- |\n" +
    `${table}\n\n## Per item\n\n${sections.join("\n")}`;
  return { text, touched: touched.length, items: rows.length };
}

// ---- manifest text edits ------------------------------------------------------

// Move a merge-tracked source's pin in the manifest TEXT (comments and flow style
// are preserved; a YAML round-trip would reformat the file). `blobs` maps an
// upstream path to its new blob SHA.
export function updateManifestText(text, sourceId, { ref, tag, blobs }) {
  const lines = text.split("\n");
  const start = lines.findIndex(l => l === `  - id: ${sourceId}`);
  if (start < 0) throw new Error(`manifest: source ${sourceId} not found`);
  let end = start + 1;
  while (end < lines.length && !/^ {2}- id: /.test(lines[end]) && !/^\S/.test(lines[end])) end++;
  let refDone = false, tagDone = false;
  const oldRef = lines.slice(start + 1, end).map(l => l.match(/^ {4}ref: ([0-9a-f]{40})$/)?.[1]).find(Boolean);
  const pending = new Set(blobs.keys());
  for (let i = start + 1; i < end; i++) {
    if (/^ {4}ref: [0-9a-f]{40}$/.test(lines[i])) { lines[i] = `    ref: ${ref}`; refDone = true; continue; }
    if (/^ {4}tag: \S+$/.test(lines[i])) { lines[i] = `    tag: ${tag}`; tagDone = true; continue; }
    if (oldRef && lines[i].includes(`ref: ${oldRef}`)) lines[i] = lines[i].split(`ref: ${oldRef}`).join(`ref: ${ref}`);
    const from = lines[i].match(/\bfrom: ([^,}\s]+)/)?.[1];
    if (from && blobs.has(from) && /baseBlob: [0-9a-f]{40}/.test(lines[i])) {
      lines[i] = lines[i].replace(/baseBlob: [0-9a-f]{40}/, `baseBlob: ${blobs.get(from)}`);
      pending.delete(from);
    }
  }
  if (!refDone || !tagDone) throw new Error(`manifest: source ${sourceId} has no ref:/tag: line to update`);
  if (pending.size) throw new Error(`manifest: no baseBlob line for ${[...pending].join(", ")}`);
  return lines.join("\n");
}

// ---- update ---------------------------------------------------------------

async function readText(path) {
  try { return await readFile(path, "utf8"); } catch (error) { if (error.code === "ENOENT") return null; throw error; }
}
async function writeText(root, rel, text) {
  await mkdir(dirname(join(root, rel)), { recursive: true });
  await writeFile(join(root, rel), text);
}

// Run the 3-way update of one merge-tracked source. `manifestText` is the raw
// manifest (needed to rewrite the pin without reformatting); `upstream` is
// injected (tests) or fetched. With dryRun nothing is written.
export async function runVendorUpdate({ root, manifest, manifestText, sourceId, toTag, dryRun = false, upstream, exec = pexec }) {
  const source = (manifest?.sources || []).find(s => s.id === sourceId);
  if (!source) throw new Error(`unknown vendor source: ${sourceId}`);
  if (!isSyncSource(source)) throw new Error(`source ${sourceId} is not merge-tracked (no item has a mode)`);
  if (!TAG_RE.test(String(toTag))) throw new Error(`invalid tag ${toTag}`);
  let cleanup;
  if (!upstream) ({ upstream, cleanup } = await fetchUpstream(source, toTag, { exec }));
  try {
    const toSha = await upstream.resolve(`refs/tags/${toTag}`);
    const items = syncItemsOf(source);
    const bases = new Map();
    const conflicts = [];
    for (const item of items) {
      if (bases.has(item.from)) continue;
      // Merged and verbatim items must have a base copy; a watch item or a port may have one.
      // A whole-file verbatim item is its own base copy.
      const whole = isWholeFileVerbatim(item, items);
      const basePath = whole ? item.to : baseCopyPath(source.id, item.from);
      const prev = await readText(join(root, basePath));
      if ((whole || needsBaseCopy(item, items)) && prev === null) throw new Error(`missing base copy ${basePath} (run the offline vendor check)`);
      if (prev !== null && gitBlobSha(prev) !== item.baseBlob) throw new Error(`base copy ${basePath} does not match baseBlob ${item.baseBlob}`);
      const next = await upstream.readFile(toSha, item.from);
      bases.set(item.from, { prev, next, tag: toTag, whole });
      if (next === null) conflicts.push({ file: item.to ?? item.from, kind: "removed", detail: `${item.from} no longer exists at ${toTag}` });
    }
    const files = [];
    const ports = [];
    const byFile = new Map();
    for (const item of items.filter(i => i.mode !== "watch")) {
      if (!byFile.has(item.to)) byFile.set(item.to, []);
      byFile.get(item.to).push(item);
    }
    const regionBases = new Map([...bases].filter(([from, b]) => b.prev !== null && items.some(i => i.from === from && i.mode !== "watch" && i.id !== undefined)));
    for (const [to, fileItems] of byFile) {
      const current = await readText(join(root, to));
      if (current === null) { conflicts.push({ file: to, kind: "missing", detail: `${to} does not exist` }); continue; }
      const regen = regenerateRegions(current, regionBases, { source: source.id });
      let text = regen.text;
      let mergeConflicts = 0;
      for (const port of fileItems.filter(i => i.mode === "adapted" && !isMergeable(i, items))) {
        const { prev, next } = bases.get(port.from);
        if (next !== null && next !== prev) ports.push({ file: to, from: port.from, detail: `${port.from} changed upstream; re-port the change by hand (see the report)` });
      }
      const wholeFile = fileItems.find(i => isWholeFileVerbatim(i, items));
      if (wholeFile && bases.get(wholeFile.from).next !== null) text = bases.get(wholeFile.from).next;
      const adapted = fileItems.find(i => isMergeable(i, items));
      if (adapted) {
        const { prev, next } = bases.get(adapted.from);
        if (next !== null) {
          const merged = await mergeFile({ ours: text, base: prev, theirs: next, labels: ["muster", `${source.tag} ${adapted.from}`, `${toTag} ${adapted.from}`], exec });
          text = merged.text;
          mergeConflicts = merged.conflicts;
        }
      }
      for (const c of regen.conflicts) conflicts.push({ file: to, ...c });
      if (mergeConflicts) conflicts.push({ file: to, kind: "merge", detail: `${mergeConflicts} conflicting hunk(s) from ${adapted.from}` });
      files.push({ path: to, changed: text !== current, conflicts: regen.conflicts.length + mergeConflicts, notes: regen.notes });
      if (!dryRun && text !== current) await writeText(root, to, text);
    }
    const report = await buildReport({ source, toTag, toSha, upstream });
    const clean = conflicts.length === 0;
    if (!dryRun) {
      await writeText(root, reportPath(source.id, toTag), report.text);
      if (clean) {
        const blobs = new Map();
        for (const [from, { prev, next, whole }] of bases) {
          blobs.set(from, gitBlobSha(next));
          if (prev !== null && !whole) await writeText(root, baseCopyPath(source.id, from), next);
        }
        const nextManifest = updateManifestText(manifestText, source.id, { ref: toSha, tag: toTag, blobs });
        await writeText(root, "vendor/manifest.yaml", nextManifest);
      }
    }
    return {
      source: source.id, from: { ref: source.ref, tag: source.tag }, to: { ref: toSha, tag: toTag }, dryRun,
      files, conflicts, ports, report: { path: reportPath(source.id, toTag), touched: report.touched, items: report.items, ...(dryRun ? { text: report.text } : {}) },
      pinMoved: !dryRun && clean
    };
  } finally {
    await cleanup?.();
  }
}

export async function runVendorReport({ root, manifest, sourceId, toTag, upstream, exec = pexec, write = true }) {
  const source = (manifest?.sources || []).find(s => s.id === sourceId);
  if (!source || !isSyncSource(source)) throw new Error(`source ${sourceId} is not merge-tracked`);
  if (!TAG_RE.test(String(toTag))) throw new Error(`invalid tag ${toTag}`);
  let cleanup;
  if (!upstream) ({ upstream, cleanup } = await fetchUpstream(source, toTag, { exec }));
  try {
    const toSha = await upstream.resolve(`refs/tags/${toTag}`);
    const report = await buildReport({ source, toTag, toSha, upstream });
    if (write) await writeText(root, reportPath(source.id, toTag), report.text);
    return { source: source.id, from: source.tag, to: toTag, path: reportPath(source.id, toTag), touched: report.touched, items: report.items, text: report.text };
  } finally {
    await cleanup?.();
  }
}

// ---- offline check (doctor) -----------------------------------------------

const versionKey = tag => String(tag).replace(/^v/, "").split(/[-.]/).map(p => (/^\d+$/.test(p) ? Number(p) : p));
function tagNewer(a, b) {
  const x = versionKey(a), y = versionKey(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    if (x[i] === y[i]) continue;
    if (x[i] === undefined) return false;
    if (y[i] === undefined) return true;
    return typeof x[i] === "number" && typeof y[i] === "number" ? x[i] > y[i] : String(x[i]) > String(y[i]);
  }
  return false;
}

// Offline: every adapted/verbatim item's base copy exists and matches its
// recorded baseBlob, its muster file exists, and the file's verbatim regions
// still equal the base lines. Reports a newer cached report as "behind".
export async function checkVendorSync({ root, manifest }) {
  const problems = [];
  const behind = [];
  let checked = 0;
  for (const source of (manifest?.sources || []).filter(isSyncSource)) {
    const items = syncItemsOf(source);
    for (const item of items) {
      checked++;
      if (isWholeFileVerbatim(item, items)) {
        const copy = await readText(join(root, item.to));
        if (copy === null) problems.push(`${source.id}: verbatim file ${item.to} is missing`);
        else if (gitBlobSha(copy) !== item.baseBlob) problems.push(`${source.id}: verbatim file ${item.to} is ${gitBlobSha(copy)}, manifest records ${item.baseBlob} (a whole-file copy is never edited)`);
        continue;
      }
      const base = await readText(join(root, baseCopyPath(source.id, item.from)));
      if (base === null && !needsBaseCopy(item, items)) continue;
      if (base === null) problems.push(`${source.id}: missing base copy ${baseCopyPath(source.id, item.from)}`);
      else if (gitBlobSha(base) !== item.baseBlob) problems.push(`${source.id}: base copy ${item.from} is ${gitBlobSha(base)}, manifest records ${item.baseBlob}`);
      if (item.to && (await readText(join(root, item.to))) === null) problems.push(`${source.id}: ${item.mode} file ${item.to} is missing`);
    }
    for (const to of new Set(items.filter(i => i.to && i.mode !== "watch").map(i => i.to))) {
      const text = await readText(join(root, to));
      if (text === null) continue;
      // A region may only quote an upstream file the manifest tracks FOR this muster file.
      const tracked = new Set(items.filter(i => i.to === to).map(i => i.from));
      const bases = new Map();
      for (const r of parseVerbatimRegions(text).regions)
        if (r.source === source.id && !bases.has(r.path)) bases.set(r.path, tracked.has(r.path) ? await readText(join(root, baseCopyPath(source.id, r.path))) : null);
      const { errors } = checkVerbatimRegions(text, (src, path) => (src === source.id ? bases.get(path) : null));
      for (const e of errors) problems.push(`${to}: ${e}`);
    }
    const reports = await readdir(join(root, "vendor/reports")).catch(() => []);
    for (const name of reports) {
      const m = name.match(new RegExp(`^${source.id}-(.+)\\.md$`));
      if (m && TAG_RE.test(m[1]) && tagNewer(m[1], source.tag)) behind.push(`${source.id} pin ${source.tag} is behind ${m[1]} (${reportPath(source.id, m[1])})`);
    }
  }
  return { ok: problems.length === 0, checked, problems, behind };
}
