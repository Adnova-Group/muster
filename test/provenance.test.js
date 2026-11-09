// Every skill, builtin, agent, command, output style, pipeline and Codex fallback
// must say which external repository it is based on (`upstream: [...]`), or
// declare that it is Muster-authored (`upstream: []`). vendor/manifest.yaml is the
// single source of truth; this suite fails on any drift from it. Offline only:
// renames, archival and license drift upstream are a separate gh-backed check.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { validateVendorManifest } from "../src/vendor.js";
import {
  discoverItems, projectManifest, readUpstream, validateUpstreamEntries, checkLicenseWaivers,
  generateNotice, runProvenance, stampMarkdown, stampPipeline, upstreamEntry
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

test("muster provenance (check mode) reports no drift: items, catalog summary, NOTICE, cowork/NOTICE", async () => {
  const res = await runProvenance({ root, manifest });
  assert.deepEqual({ drift: res.drift, orphans: res.orphans }, { drift: [], orphans: [] });
  assert.equal(res.counts.items, items.length);
});

test("NOTICE names every manifest source with its license and copyright line", async () => {
  const notice = await readFile(join(root, "NOTICE"), "utf8");
  assert.equal(notice, generateNotice(manifest));
  assert.equal(await readFile(join(root, "cowork/NOTICE"), "utf8"), notice, "cowork/NOTICE must be byte-identical to NOTICE");
  const missing = [];
  for (const s of manifest.sources) {
    const line = notice.split("\n").find(l => l.startsWith(`- ${s.repo} `));
    if (!line || !line.includes(`(${s.license})`)) missing.push(s.repo);
    if (s.ref && !line?.includes(s.ref)) missing.push(`${s.repo}@${s.ref}`);
    if (s.copyright && !notice.includes(s.copyright)) missing.push(`${s.repo} copyright`);
  }
  assert.deepEqual(missing, []);
});

test("every MIT source records its copyright line (MIT requires it travel with the copy)", () => {
  const missing = manifest.sources.filter(s => s.license.split(/ (?:AND|OR) /).includes("MIT") && !s.copyright).map(s => s.id);
  assert.deepEqual(missing, []);
});

test("license NONE on vendored/adapted text needs an explicit waiver; every NONE/NC source is waived", (t) => {
  const { errors, waived } = checkLicenseWaivers(manifest);
  assert.deepEqual(errors, []);
  // Keep the open risk visible in the test output.
  for (const w of waived.filter(w => w.status === "pending-owner-decision"))
    t.diagnostic(`pending-owner-decision: ${w.repo} (${w.license}, risk ${w.risk}${w.text ? ", text adapted" : ""})`);
  assert.ok(waived.some(w => w.repo === "jalaalrd/anti-ai-slop-writing" && w.text && w.status === "pending-owner-decision"),
    "the unlicensed humanizer vocabulary source must stay flagged until the owner decides");
});

test("the waiver gate fails an unwaived NONE source carrying adapted text", () => {
  const fixture = { sources: [{ id: "x", kind: "github", repo: "a/b", ref: "1b48564898e999219882660237fde01bf4843a0f", license: "NONE", relation: "adapted", fetch: false,
    items: [{ id: "muster-humanizer", kind: "builtin", from: "SKILL.md" }] }] };
  assert.match(checkLicenseWaivers(fixture).errors[0], /license NONE with adapted text and no licenseWaivers entry/);
  fixture.licenseWaivers = [{ source: "x", status: "pending-owner-decision", reason: "r" }];
  assert.deepEqual(checkLicenseWaivers(fixture).errors, []);
  const nc = { sources: [{ id: "n", kind: "github", repo: "c/d", license: "CC-BY-NC-SA-4.0", relation: "inspired-by", fetch: false, items: [] }] };
  assert.match(checkLicenseWaivers(nc).errors[0], /needs a licenseWaivers entry/);
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
