// Every skill, builtin, agent, command, output style, pipeline and Codex fallback
// must say which external repository or work (article, book, paper, standard, talk,
// person) it is based on (`upstream: [...]`), or declare that it is Muster-authored
// (`upstream: []`). vendor/manifest.yaml is the single source of truth; this suite
// fails on any drift from it, on an entry that names no source, and on a
// restricted-license source without a recorded decision. Offline only: renames,
// archival and license drift upstream are a separate gh-backed check.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { validateVendorManifest } from "../src/vendor.js";
import {
  discoverItems, projectManifest, readUpstream, validateUpstreamEntries, checkLicenseWaivers,
  generateNotice, runProvenance, stampMarkdown, stampPipeline, upstreamEntry, namesSource,
  isRestrictedLicense, isWorkSource, generateCreditsBlock, stampCredits, CREDITS_BEGIN, CREDITS_END
} from "../src/provenance.js";

const root = join(import.meta.dirname, "..");
const manifest = parseYaml(await readFile(join(root, "vendor/manifest.yaml"), "utf8"));
const projection = projectManifest(manifest);
const items = await discoverItems(root);
const recorded = new Map();
for (const item of items) recorded.set(item, readUpstream(item.kind, await readFile(join(root, item.path), "utf8")));

test("the manifest validates (relations, licenses, refs, kinds, waivers)", () => {
  assert.deepEqual(validateVendorManifest(manifest), { ok: true, errors: [] });
});

test("every item declares upstream (a list; [] means Muster-authored)", () => {
  assert.ok(items.length >= 130, `expected the full item set, found ${items.length}`);
  for (const kind of ["builtin", "agent", "skill", "command", "output-style", "pipeline", "codex-fallback"])
    assert.ok(items.some(i => i.kind === kind), `no ${kind} items discovered`);
  const missing = items.filter(item => !Array.isArray(recorded.get(item))).map(i => i.path);
  assert.deepEqual(missing, [], "items without an upstream list — run `muster provenance --write`");
});

test("adapted_from / inspired_by are retired everywhere upstream now lives", async () => {
  const stale = [];
  for (const item of items) {
    const text = await readFile(join(root, item.path), "utf8");
    if (/^(adapted_from|inspired_by):/m.test(text.split(/\n---/)[0])) stale.push(item.path);
  }
  assert.deepEqual(stale, []);
});

test("every item's upstream equals the manifest projection, and no manifest item is orphaned", () => {
  const disagree = [];
  for (const item of items) {
    const expected = projection.get(`${item.kind}:${item.id}`) || [];
    try { assert.deepEqual(recorded.get(item), expected); } catch { disagree.push(item.path); }
  }
  assert.deepEqual(disagree, [], "items disagree with vendor/manifest.yaml — run `muster provenance --write`");
  const onDisk = new Set(items.map(i => `${i.kind}:${i.id}`));
  assert.deepEqual([...projection.keys()].filter(k => !onDisk.has(k)), [], "manifest items with no file");
});

test("every recorded upstream entry has a valid repo, relation, license, ref and path", () => {
  const bad = [];
  for (const [item, entries] of recorded) for (const e of validateUpstreamEntries(entries)) bad.push(`${item.path}: ${e}`);
  assert.deepEqual(bad, []);
});

test("the shape check rejects an invalid relation, license or ref", () => {
  const good = { repo: "obra/superpowers", ref: "284be5905ed540d34ce5bcde24728b9b7f413ea0", path: "skills/x/SKILL.md", license: "MIT", relation: "adapted" };
  assert.deepEqual(validateUpstreamEntries([good]), []);
  assert.deepEqual(validateUpstreamEntries([]), []);
  assert.match(validateUpstreamEntries([{ ...good, relation: "copied" }])[0], /relation/);
  assert.match(validateUpstreamEntries([{ ...good, license: "MIT-ish" }])[0], /license/);
  assert.match(validateUpstreamEntries([{ ...good, ref: "284be59" }])[0], /ref/);
  assert.match(validateUpstreamEntries([{ ...good, ref: null }])[0], /only an inspired-by entry may be unpinned/);
  assert.deepEqual(validateUpstreamEntries([{ ...good, ref: null, relation: "inspired-by" }]), []);
  assert.match(validateUpstreamEntries([{ ...good, path: "../escape" }])[0], /path/);
  assert.match(validateUpstreamEntries("obra/superpowers")[0], /must be a list/);
});

test("muster provenance (check mode) reports no drift: items, catalog summary, NOTICE, cowork/NOTICE, credits", async () => {
  const res = await runProvenance({ root, manifest });
  assert.deepEqual({ drift: res.drift, orphans: res.orphans, problems: res.problems }, { drift: [], orphans: [], problems: [] });
  assert.equal(res.counts.items, items.length);
});

test("NOTICE names every manifest source with its license and copyright line", async () => {
  const notice = await readFile(join(root, "NOTICE"), "utf8");
  assert.equal(notice, generateNotice(manifest));
  assert.equal(await readFile(join(root, "cowork/NOTICE"), "utf8"), notice, "cowork/NOTICE must be byte-identical to NOTICE");
  const missing = [];
  for (const s of manifest.sources.filter(s => !isWorkSource(s))) {
    const line = notice.split("\n").find(l => l.startsWith(`- ${s.repo} `));
    // A repository several sources record under different licenses lists them all, joined
    // with AND (getsentry/skills: Apache-2.0 AND CC-BY-SA-4.0); each source's own must appear.
    const paren = line?.match(/\(([^()]*)\)$/)?.[1] ?? "";
    const listed = paren.split(" AND ");
    if (!line || !(paren === s.license || s.license.split(" AND ").every(l => listed.includes(l)))) missing.push(s.repo);
    if (s.ref && !line?.includes(s.ref)) missing.push(`${s.repo}@${s.ref}`);
    if (s.copyright && !notice.includes(s.copyright)) missing.push(`${s.repo} copyright`);
  }
  assert.deepEqual(missing, []);
  const works = manifest.sources.filter(s => isWorkSource(s) && s.kind !== "unknown");
  assert.deepEqual(works.filter(w => !notice.includes(w.title ?? w.author)).map(w => w.id), [], "NOTICE omits works");
});

test("every MIT source records its copyright line (MIT requires it travel with the copy)", () => {
  const missing = manifest.sources.filter(s => !isWorkSource(s) && s.license.split(/ (?:AND|OR) /).includes("MIT") && !s.copyright).map(s => s.id);
  assert.deepEqual(missing, []);
});

test("no license waiver is pending, and every restricted source has a recorded decision", (t) => {
  const { errors, waived, reviewed } = checkLicenseWaivers(manifest);
  assert.deepEqual(errors, []);
  assert.deepEqual((manifest.licenseWaivers || []).filter(w => w.status === "pending-owner-decision").map(w => w.source), [],
    "pending-owner-decision waivers must be decided (permission-granted | accepted-risk) or resolved clean-room");
  const restricted = manifest.sources.filter(s => !isWorkSource(s) && isRestrictedLicense(s.license));
  assert.ok(restricted.length >= 10, `expected the restricted-license sources, found ${restricted.length}`);
  for (const s of restricted)
    assert.ok(waived.some(w => w.source === s.id) || reviewed.some(r => r.source === s.id), `${s.id} (${s.license}) has neither a decided waiver nor a licenseReview`);
  for (const r of reviewed) t.diagnostic(`licenseReview ${r.finding} ${r.date}: ${r.repo} (${r.license})`);
  // The humanizer's unlicensed vocabulary source was rewritten clean-room, not waived.
  const slop = manifest.sources.find(s => s.repo === "jalaalrd/anti-ai-slop-writing");
  assert.equal(slop.licenseReview?.finding, "clean-room-rewrite");
  assert.ok(slop.items.every(i => (i.relation ?? slop.relation) === "inspired-by"));
});

test("the license gate fails pending, unwaived text and unreviewed restricted sources", () => {
  const ref = "1b48564898e999219882660237fde01bf4843a0f";
  const textSource = { id: "x", kind: "github", repo: "a/b", ref, license: "NONE", relation: "adapted", fetch: false,
    items: [{ id: "muster-humanizer", kind: "builtin", from: "SKILL.md" }] };
  assert.match(checkLicenseWaivers({ sources: [textSource] }).errors[0], /license NONE with adapted text and no licenseWaivers entry/);
  const pending = { sources: [textSource], licenseWaivers: [{ source: "x", status: "pending-owner-decision", reason: "r" }] };
  assert.match(checkLicenseWaivers(pending).errors.join("\n"), /pending-owner-decision/);
  const decided = { sources: [textSource], licenseWaivers: [{ source: "x", status: "permission-granted", reason: "r" }] };
  assert.deepEqual(checkLicenseWaivers(decided).errors, []);
  const nc = { id: "n", kind: "github", repo: "c/d", license: "CC-BY-NC-SA-4.0", relation: "inspired-by", fetch: false, items: [] };
  assert.match(checkLicenseWaivers({ sources: [nc] }).errors[0], /needs a licenseReview/);
  const reviewedNc = { ...nc, licenseReview: { date: "2026-11-09", finding: "ideas-only", evidence: "no shared 5-gram" } };
  assert.deepEqual(checkLicenseWaivers({ sources: [reviewedNc] }).errors, []);
  assert.match(checkLicenseWaivers({ sources: [reviewedNc], licenseWaivers: [{ source: "n", status: "accepted-risk", reason: "r" }] }).errors[0],
    /carries no text from; record a licenseReview instead/);
  assert.match(checkLicenseWaivers({ sources: [{ ...nc, id: "p", license: "LicenseRef-proprietary" }] }).errors[0], /needs a licenseReview/);
  const badFinding = { ...nc, id: "d", license: "CC-BY-NC-ND-4.0", licenseReview: { date: "2026-11-09", finding: "copied", evidence: "e" } };
  assert.match(checkLicenseWaivers({ sources: [badFinding] }).errors[0], /needs a licenseReview/, "an unknown finding is not a decision");
});

test("every derived item's upstream names its source; an unknown origin carries a dated note", () => {
  const unnamed = [];
  for (const [item, entries] of recorded) for (const [i, e] of (entries || []).entries()) if (!namesSource(e)) unnamed.push(`${item.path}: upstream[${i}]`);
  assert.deepEqual(unnamed, []);
  // Works flow through: each kind the 2026-11-09 sweep recorded reaches an item.
  const kinds = new Set([...recorded.values()].flat().filter(e => e?.kind).map(e => e.kind));
  for (const kind of ["article", "book", "paper", "standard", "person", "unknown"]) assert.ok(kinds.has(kind), `no ${kind} work reaches any item`);
});

test("an item whose body credits an outside origin records it in upstream", async () => {
  const CREDIT_RE = /\b(inspired by|adapted from|ported from|prior art|clean-room synthesis|paraphrased:)/i;
  const uncredited = [];
  for (const item of items) {
    const text = await readFile(join(root, item.path), "utf8");
    const body = item.kind === "pipeline" ? text.replace(/^upstream:[\s\S]*?(?=^phases:)/m, "") : text.replace(/^---[\s\S]*?\n---/, "");
    if (CREDIT_RE.test(body) && !(recorded.get(item) || []).length) uncredited.push(item.path);
  }
  assert.deepEqual(uncredited, []);
});

test("work entries are shape-checked: named, inspired-by only, https or null url", () => {
  const book = upstreamEntry({ kind: "book", title: "The Pyramid Principle", author: "Barbara Minto", relation: "inspired-by" }, { id: "executive-summary" });
  assert.deepEqual(book, { kind: "book", title: "The Pyramid Principle", author: "Barbara Minto", url: null, relation: "inspired-by" });
  assert.deepEqual(validateUpstreamEntries([book]), []);
  assert.ok(namesSource(book));
  assert.match(validateUpstreamEntries([{ ...book, title: null, author: null }]).join(), /must name the work/);
  assert.match(validateUpstreamEntries([{ ...book, relation: "adapted" }]).join(), /can only be inspired-by/);
  assert.match(validateUpstreamEntries([{ ...book, url: "http://example.com" }]).join(), /https/);
  assert.match(validateUpstreamEntries([{ ...book, kind: "blog" }]).join(), /kind/);
  const unknown = upstreamEntry({ kind: "unknown", title: "high-signal sources", note: "2026-11-09: not named anywhere", relation: "inspired-by" }, {});
  assert.ok(namesSource(unknown));
  assert.match(validateUpstreamEntries([{ ...unknown, note: "not named anywhere" }]).join(), /dated note/);
  assert.equal(namesSource({ repo: "", relation: "adapted" }), false);
});

test("the manifest validator enforces the work-source shape and licenseReview", () => {
  const work = { id: "w", kind: "article", title: "T", url: "https://example.com/t", relation: "inspired-by", fetch: false,
    items: [{ id: "prd", kind: "pipeline", from: null }] };
  assert.deepEqual(validateVendorManifest({ sources: [work] }), { ok: true, errors: [] });
  const bad = patch => validateVendorManifest({ sources: [{ ...work, ...patch }] }).errors.join("\n");
  assert.match(bad({ relation: "adapted" }), /can only be inspired-by/);
  assert.match(bad({ fetch: undefined }), /must be fetch: false/);
  assert.match(bad({ title: undefined }), /title or an author/);
  assert.match(bad({ repo: "a/b" }), /no repo or ref/);
  assert.match(bad({ kind: "unknown", note: "undated" }), /dated note/);
  const repo = { id: "g", kind: "github", repo: "a/b", license: "NONE", relation: "inspired-by", fetch: false, items: [],
    licenseReview: { date: "soon", finding: "ideas-only", evidence: "e" } };
  assert.match(validateVendorManifest({ sources: [repo] }).errors.join(), /licenseReview/);
});

test("credits.md carries the generated block, in sync with the manifest", async () => {
  const credits = await readFile(join(root, "website/about/credits.md"), "utf8");
  assert.ok(credits.includes(CREDITS_BEGIN) && credits.includes(CREDITS_END));
  assert.equal(stampCredits(credits, manifest), credits, "credits drift: run `muster provenance --write`");
  const block = generateCreditsBlock(manifest);
  const label = s => String(s.title ?? s.author).replace(/\|/g, "\\|");
  assert.deepEqual(manifest.sources.filter(isWorkSource).filter(s => !block.includes(label(s))).map(s => s.id), [], "credits omit works");
  assert.equal(stampCredits("no markers", manifest), null);
});

test("drift is detected: a hand-edited or missing upstream fails the projection", () => {
  const entry = upstreamEntry({ repo: "obra/superpowers", ref: "284be5905ed540d34ce5bcde24728b9b7f413ea0", license: "MIT", relation: "vendored" }, { from: "skills/x/SKILL.md" });
  const stamped = stampMarkdown("---\nname: x\nadapted_from: obra/superpowers x/SKILL.md\nlicense: MIT\n---\n\nbody\n", [entry]);
  assert.deepEqual(readUpstream("builtin", stamped), [entry]);
  assert.doesNotMatch(stamped, /adapted_from/);
  assert.equal(stampMarkdown(stamped, [entry]), stamped, "stamping is idempotent");
  assert.notDeepEqual(readUpstream("builtin", stamped.replace("relation: vendored", "relation: adapted")), [entry]);
  assert.equal(readUpstream("builtin", "---\nname: x\n---\nbody"), undefined);
  const pipeline = stampPipeline("id: p\ndomain: d\nphases:\n  - { id: a, role: author, desc: x }\n", []);
  assert.deepEqual(readUpstream("pipeline", pipeline), []);
  assert.equal(stampPipeline(pipeline, []), pipeline);
});

test("portable skills/ adapters inherit from a canonical plugin skill that declares upstream", async () => {
  const adapters = (await readdir(join(root, "skills"), { withFileTypes: true })).filter(e => e.isDirectory()).map(e => e.name);
  assert.ok(adapters.length > 0);
  for (const name of adapters) {
    const canonical = items.find(i => i.kind === "skill" && i.id === name);
    assert.ok(canonical, `skills/${name} has no canonical plugin/skills/${name}`);
    assert.ok(Array.isArray(recorded.get(canonical)), `plugin/skills/${name} lacks upstream`);
  }
});
