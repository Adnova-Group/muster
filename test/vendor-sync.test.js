// Merge-tracked upstream sync (src/vendor-sync.js, src/vendor-regions.js): the 3-way
// update, verbatim-region regeneration, the upstream report, the offline check, and
// the adapted gsd agents' contract. Network-free: the upstream is a fixture git
// repository built in a temp dir (gitUpstream over it, or fetchUpstream over file://).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm, cp } from "node:fs/promises";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { parse as parseYaml } from "yaml";
import {
  gitBlobSha, mapRange, regenerateRegions, mergeFile, gitUpstream, fetchUpstream, buildReport,
  updateManifestText, runVendorUpdate, runVendorReport, checkVendorSync, syncItemsOf, baseCopyPath, syncCatalogEntries
} from "../src/vendor-sync.js";
import { parseVerbatimRegions, checkVerbatimRegions, gsdCouplingHits } from "../src/vendor-regions.js";
import { validateVendorManifest, toAgent, vendoredAgentModel, splitFrontmatter } from "../src/vendor.js";

const pexec = promisify(execFile);
const root = join(import.meta.dirname, "..");
const GIT_ENV = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t", GIT_CONFIG_NOSYSTEM: "1" };
const git = (dir, ...args) => pexec("git", ["-C", dir, ...args], { env: GIT_ENV }).then(r => r.stdout.trim());
const lines = (n, prefix) => Array.from({ length: n }, (_, i) => `${prefix} line ${i + 1}`).join("\n") + "\n";
const region = (path, a, b, body) => `<!-- verbatim: up ${path}:${a}-${b} -->\n${body}\n<!-- /verbatim -->`;

async function write(dir, rel, text) {
  await mkdir(dirname(join(dir, rel)), { recursive: true });
  await writeFile(join(dir, rel), text);
}

// ---- pure pieces -------------------------------------------------------------

test("gitBlobSha equals git hash-object", async () => {
  const dir = await mkdtemp(join(tmpdir(), "muster-blob-"));
  try {
    const text = "hello\nwörld\n";
    await writeFile(join(dir, "f"), text);
    assert.equal(gitBlobSha(text), (await pexec("git", ["hash-object", join(dir, "f")])).stdout.trim());
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("verbatim regions parse, check against the base, and report malformed markers", () => {
  const base = lines(10, "b");
  const ok = `intro\n${region("r.md", 3, 4, "b line 3\nb line 4")}\nouter\n`;
  const read = (s, p) => (s === "up" && p === "r.md" ? base : null);
  assert.deepEqual(checkVerbatimRegions(ok, read).errors, []);
  assert.equal(parseVerbatimRegions(ok).regions[0].body, "b line 3\nb line 4");
  assert.match(checkVerbatimRegions(ok.replace("b line 4", "b line FOUR"), read).errors[0], /differs from the base copy/);
  assert.match(checkVerbatimRegions(region("x.md", 1, 1, "x"), read).errors[0], /no base copy/);
  assert.match(checkVerbatimRegions(region("r.md", 9, 40, "b line 9"), read).errors[0], /past the end/);
  assert.match(parseVerbatimRegions("<!-- verbatim: up r.md:1-1 -->\nx\n").errors[0], /never closed/);
  assert.match(parseVerbatimRegions("<!-- /verbatim -->").errors[0], /without an open region/);
});

test("gsd coupling is detected outside HTML comments only", () => {
  assert.deepEqual(gsdCouplingHits("<!-- verbatim: gsd agents/gsd-executor.md:1-2 -->\nplain text\n<!-- /verbatim -->"), []);
  const hits = gsdCouplingHits("run gsd_run state\nread .planning/STATE.md\n@~/.claude/gsd-core/x.md\nthen /gsd-plan-phase\nuse gsd-tools");
  assert.deepEqual(hits.map(h => h.line), [1, 2, 3, 4, 5]);
});

test("mapRange follows moved lines and re-anchors an edited edge", () => {
  const prev = "a\nb\nc\nd\ne";
  assert.deepEqual(mapRange(prev, "x\ny\na\nb\nc\nd\ne", 2, 3), { first: 4, last: 5, exact: true });
  assert.deepEqual(mapRange(prev, "a\nB\nc\nd\ne", 2, 3), { first: 2, last: 3, exact: false });
  assert.equal(mapRange(prev, "a\nd\ne", 2, 3), null);
});

test("regenerateRegions: unchanged upstream is a no-op; moved and edited regions follow upstream", () => {
  const prev = lines(8, "u");
  const text = `head\n${region("r.md", 2, 3, "u line 2\nu line 3")}\ntail\n`;
  const same = regenerateRegions(text, new Map([["r.md", { prev, next: prev, tag: "v2" }]]), { source: "up" });
  assert.equal(same.text, text);
  assert.deepEqual(same.conflicts, []);
  const moved = `new 0\n${prev.replace("u line 3", "u line 3 (clarified)")}`;
  const res = regenerateRegions(text, new Map([["r.md", { prev, next: moved, tag: "v2" }]]), { source: "up" });
  assert.deepEqual(res.conflicts, []);
  assert.equal(res.text, `head\n${region("r.md", 3, 4, "u line 2\nu line 3 (clarified)")}\ntail\n`);
  assert.deepEqual(checkVerbatimRegions(res.text, () => moved).errors, []);
});

test("regenerateRegions: a locally edited, deleted or newly coupled region becomes a marked conflict", () => {
  const prev = lines(8, "u");
  const map = next => new Map([["r.md", { prev, next, tag: "v2" }]]);
  const edited = `${region("r.md", 2, 3, "u line 2\nmy paraphrase")}\n`;
  const e = regenerateRegions(edited, map(prev.replace("u line 3", "u line 3!")), { source: "up" });
  assert.match(e.conflicts[0].detail, /edited in muster/);
  assert.match(e.text, /<<<<<<< muster\nu line 2\nmy paraphrase\n=======\nu line 2\nu line 3!\n>>>>>>> v2 r.md:2-3/);
  const d = regenerateRegions(`${region("r.md", 2, 3, "u line 2\nu line 3")}\n`, map("u line 1\nu line 4\n"), { source: "up" });
  assert.match(d.conflicts[0].detail, /deleted upstream/);
  const c = regenerateRegions(`${region("r.md", 2, 3, "u line 2\nu line 3")}\n`, map(prev.replace("u line 3", "run gsd_run x")), { source: "up" });
  assert.match(c.conflicts[0].detail, /gsd runtime coupling/);
  const untracked = regenerateRegions(`${region("other.md", 1, 1, "z")}\n`, map(prev), { source: "up" });
  assert.match(untracked.conflicts[0].detail, /no manifest item tracks/);
});

test("mergeFile returns git merge-file's conflict count and leaves markers", async () => {
  const base = "one\ntwo\nthree\n";
  const clean = await mergeFile({ ours: "one\ntwo\nthree\nfour\n", base, theirs: "zero\none\ntwo\nthree\n" });
  assert.deepEqual(clean, { text: "zero\none\ntwo\nthree\nfour\n", conflicts: 0 });
  const conflict = await mergeFile({ ours: "one\nTWO\nthree\n", base, theirs: "one\n2\nthree\n" });
  assert.equal(conflict.conflicts, 1);
  assert.match(conflict.text, /<<<<<<< muster\nTWO\n=======\n2\n>>>>>>> upstream/);
});

// ---- fixture upstream + muster tree -------------------------------------------

// Upstream repo: v1.0.0 (pin) and v1.1.0 (target). agents/a.md changes far from the
// lines muster edits; refs/r.md shifts and edits the verbatim lines; workflows/w.md
// is watch-only; one commit cites #12.
async function fixtureUpstream({ conflicting = false } = {}) {
  const dir = await mkdtemp(join(tmpdir(), "muster-upstream-fixture-"));
  await git(dir, "init", "-q");
  const a1 = lines(30, "agent");
  const r1 = lines(10, "ref");
  await write(dir, "agents/a.md", a1);
  await write(dir, "refs/r.md", r1);
  await write(dir, "workflows/w.md", "spine\n");
  await git(dir, "add", "-A");
  await git(dir, "commit", "-q", "-m", "initial");
  await git(dir, "tag", "v1.0.0");
  const a2 = conflicting ? a1.replace("agent line 5", "agent line 5 (upstream)") : a1.replace("agent line 28", "agent line 28 (upstream fix)");
  await write(dir, "agents/a.md", a2);
  await git(dir, "commit", "-q", "-am", "fix(agent): tighten the rule (#12)");
  await write(dir, "refs/r.md", `preamble\n${r1.replace("ref line 4", "ref line 4, reworded")}`);
  await write(dir, "workflows/w.md", "spine v2\n");
  await git(dir, "commit", "-q", "-am", "docs: refresh references");
  await git(dir, "tag", "v1.1.0");
  return { dir, a1, a2, r1, pin: await git(dir, "rev-parse", "v1.0.0"), target: await git(dir, "rev-parse", "v1.1.0") };
}

function fixtureManifest(pin, blobs) {
  return [
    "sources:",
    "  - id: up",
    "    kind: github",
    "    repo: example/up",
    "    # merge-tracked fixture",
    `    ref: ${pin}`,
    "    tag: v1.0.0",
    "    license: MIT",
    '    copyright: "Copyright (c) 2026 Example"',
    "    relation: adapted",
    "    items:",
    `      - { id: muster-x, kind: agent, from: agents/a.md, to: plugin/agents/muster-x.md, mode: adapted, baseBlob: ${blobs.a}, issues: [12] }`,
    `      - { id: muster-x, kind: agent, from: refs/r.md, to: plugin/agents/muster-x.md, mode: verbatim, relation: vendored, baseBlob: ${blobs.r}, issues: [] }`,
    `      - { from: workflows/w.md, mode: watch, baseBlob: ${blobs.w} }`,
    "  - id: other",
    "    kind: github",
    "    repo: example/other",
    `    ref: ${pin}`,
    "    license: MIT",
    '    copyright: "Copyright (c) 2026 Example"',
    "    relation: inspired-by",
    "    fetch: false",
    "    items:",
    "      - { id: muster-y, kind: agent, from: null }",
    ""
  ].join("\n");
}

// The muster side: an adapted agent that rewrote lines 1-5 of agents/a.md and quotes
// refs/r.md:3-4 verbatim.
async function fixtureMuster(up) {
  const dir = await mkdtemp(join(tmpdir(), "muster-tree-fixture-"));
  const adapted = `---\nname: muster-x\n---\nMUSTER HEADER\n${up.a1.split("\n").slice(5).join("\n")}`
    .replace("agent line 10\n", `agent line 10\n${region("refs/r.md", 3, 4, "ref line 3\nref line 4")}\n`);
  await write(dir, "plugin/agents/muster-x.md", adapted);
  await write(dir, baseCopyPath("up", "agents/a.md"), up.a1);
  await write(dir, baseCopyPath("up", "refs/r.md"), up.r1);
  const manifestText = fixtureManifest(up.pin, { a: gitBlobSha(up.a1), r: gitBlobSha(up.r1), w: gitBlobSha("spine\n") });
  await write(dir, "vendor/manifest.yaml", manifestText);
  return { dir, adapted, manifestText, manifest: parseYaml(manifestText) };
}

test("the fixture manifest validates and its watch item projects onto nothing", async () => {
  const up = await fixtureUpstream();
  const tree = await fixtureMuster(up);
  try {
    assert.deepEqual(validateVendorManifest(tree.manifest), { ok: true, errors: [] });
    assert.equal(syncItemsOf(tree.manifest.sources[0]).length, 3);
    assert.deepEqual(await checkVendorSync({ root: tree.dir, manifest: tree.manifest }), { ok: true, checked: 3, problems: [], behind: [] });
  } finally { await rm(up.dir, { recursive: true, force: true }); await rm(tree.dir, { recursive: true, force: true }); }
});

test("vendor update merges cleanly, regenerates the region, moves base copies, manifest pin and report", async () => {
  const up = await fixtureUpstream();
  const tree = await fixtureMuster(up);
  try {
    const res = await runVendorUpdate({ root: tree.dir, manifest: tree.manifest, manifestText: tree.manifestText, sourceId: "up", toTag: "v1.1.0", upstream: gitUpstream(up.dir) });
    assert.deepEqual(res.conflicts, []);
    assert.equal(res.pinMoved, true);
    const merged = await readFile(join(tree.dir, "plugin/agents/muster-x.md"), "utf8");
    assert.match(merged, /^---\nname: muster-x\n---\nMUSTER HEADER\n/, "muster's own edit survives");
    assert.match(merged, /agent line 28 \(upstream fix\)/, "upstream's change is merged in");
    assert.match(merged, /<!-- verbatim: up refs\/r\.md:4-5 -->\nref line 3\nref line 4, reworded\n<!-- \/verbatim -->/);
    const r2 = await readFile(join(tree.dir, baseCopyPath("up", "refs/r.md")), "utf8");
    assert.equal(await readFile(join(tree.dir, baseCopyPath("up", "agents/a.md")), "utf8"), up.a2);
    const manifestAfter = await readFile(join(tree.dir, "vendor/manifest.yaml"), "utf8");
    const m2 = parseYaml(manifestAfter);
    assert.equal(m2.sources[0].ref, up.target);
    assert.equal(m2.sources[0].tag, "v1.1.0");
    assert.deepEqual(m2.sources[0].items.map(i => i.baseBlob), [gitBlobSha(up.a2), gitBlobSha(r2), gitBlobSha("spine v2\n")]);
    assert.match(manifestAfter, /# merge-tracked fixture/, "comments survive the pin move");
    assert.equal(m2.sources[1].ref, up.pin, "other sources keep their ref");
    assert.deepEqual(await checkVendorSync({ root: tree.dir, manifest: m2 }), { ok: true, checked: 3, problems: [], behind: [] });
    const report = await readFile(join(tree.dir, "vendor/reports/up-v1.1.0.md"), "utf8");
    assert.match(report, /3 of 3 tracked item\(s\) changed upstream/);
    assert.match(report, /\| agents\/a\.md \| adapted \| plugin\/agents\/muster-x\.md \| 1 \| \+1\/-1 \| 1 \|/);
    assert.match(report, /Commits citing #12:\n\n- [0-9a-f]{7} fix\(agent\): tighten the rule \(#12\) \(#12\)/);
    assert.match(report, /### workflows\/w\.md\n\nMode: watch\. 1 commit\(s\)/);
  } finally { await rm(up.dir, { recursive: true, force: true }); await rm(tree.dir, { recursive: true, force: true }); }
});

test("vendor update leaves conflict markers, lists them, and moves neither base copies nor the pin", async () => {
  const up = await fixtureUpstream({ conflicting: true });
  const tree = await fixtureMuster(up);
  // muster also rewrote line 5 (kept from upstream in the fixture): make it a real edit.
  await write(tree.dir, "plugin/agents/muster-x.md", tree.adapted.replace("agent line 6", "agent line 6"));
  const ours = tree.adapted.replace("MUSTER HEADER\n", "MUSTER HEADER\nagent line 5 (muster)\n");
  await write(tree.dir, "plugin/agents/muster-x.md", ours);
  try {
    const res = await runVendorUpdate({ root: tree.dir, manifest: tree.manifest, manifestText: tree.manifestText, sourceId: "up", toTag: "v1.1.0", upstream: gitUpstream(up.dir) });
    assert.equal(res.pinMoved, false);
    assert.deepEqual(res.conflicts.map(c => c.kind), ["merge"]);
    const merged = await readFile(join(tree.dir, "plugin/agents/muster-x.md"), "utf8");
    assert.match(merged, /<<<<<<< muster[\s\S]*=======[\s\S]*agent line 5 \(upstream\)[\s\S]*>>>>>>> v1\.1\.0 agents\/a\.md/);
    assert.equal(await readFile(join(tree.dir, "vendor/manifest.yaml"), "utf8"), tree.manifestText, "pin unchanged");
    assert.equal(await readFile(join(tree.dir, baseCopyPath("up", "agents/a.md")), "utf8"), up.a1, "base copy unchanged");
  } finally { await rm(up.dir, { recursive: true, force: true }); await rm(tree.dir, { recursive: true, force: true }); }
});

test("vendor update --dry-run writes nothing and returns the report text", async () => {
  const up = await fixtureUpstream();
  const tree = await fixtureMuster(up);
  try {
    const res = await runVendorUpdate({ root: tree.dir, manifest: tree.manifest, manifestText: tree.manifestText, sourceId: "up", toTag: "v1.1.0", dryRun: true, upstream: gitUpstream(up.dir) });
    assert.equal(res.pinMoved, false);
    assert.equal(res.files[0].changed, true);
    assert.match(res.report.text, /# up upstream report: v1\.0\.0 -> v1\.1\.0/);
    assert.equal(await readFile(join(tree.dir, "plugin/agents/muster-x.md"), "utf8"), tree.adapted);
    assert.equal(await readFile(join(tree.dir, "vendor/manifest.yaml"), "utf8"), tree.manifestText);
    await assert.rejects(readFile(join(tree.dir, "vendor/reports/up-v1.1.0.md")), { code: "ENOENT" });
  } finally { await rm(up.dir, { recursive: true, force: true }); await rm(tree.dir, { recursive: true, force: true }); }
});

test("fetchUpstream clones the pin and target tags (file:// fixture) and rejects a moved pin tag", async () => {
  const up = await fixtureUpstream();
  try {
    const source = { id: "up", repo: "example/up", url: `file://${up.dir}`, ref: up.pin, tag: "v1.0.0" };
    const { upstream, cleanup } = await fetchUpstream(source, "v1.1.0");
    try {
      assert.equal(await upstream.resolve("refs/tags/v1.1.0"), up.target);
      assert.equal(await upstream.readFile(up.target, "workflows/w.md"), "spine v2\n");
      assert.equal(await upstream.readFile(up.target, "missing.md"), null);
    } finally { await cleanup(); }
    await assert.rejects(fetchUpstream({ ...source, ref: up.target }, "v1.1.0"), /resolves to .* but the manifest pins/);
    await assert.rejects(fetchUpstream(source, "--upload-pack=x"), /invalid tag/);
  } finally { await rm(up.dir, { recursive: true, force: true }); }
});

test("vendor report writes vendor/reports/<source>-<tag>.md and a newer report shows as behind", async () => {
  const up = await fixtureUpstream();
  const tree = await fixtureMuster(up);
  try {
    const res = await runVendorReport({ root: tree.dir, manifest: tree.manifest, sourceId: "up", toTag: "v1.1.0", upstream: gitUpstream(up.dir) });
    assert.deepEqual([res.path, res.touched, res.items], ["vendor/reports/up-v1.1.0.md", 3, 3]);
    const check = await checkVendorSync({ root: tree.dir, manifest: tree.manifest });
    assert.deepEqual(check.behind, ["up pin v1.0.0 is behind v1.1.0 (vendor/reports/up-v1.1.0.md)"]);
    const direct = await buildReport({ source: tree.manifest.sources[0], toTag: "v1.1.0", toSha: up.target, upstream: gitUpstream(up.dir) });
    assert.equal(direct.text, await readFile(join(tree.dir, res.path), "utf8"), "the report is deterministic");
  } finally { await rm(up.dir, { recursive: true, force: true }); await rm(tree.dir, { recursive: true, force: true }); }
});

test("the offline check fails a tampered base copy, a missing adapted file and an edited region", async () => {
  const up = await fixtureUpstream();
  const tree = await fixtureMuster(up);
  try {
    await write(tree.dir, baseCopyPath("up", "refs/r.md"), `${up.r1}tampered\n`);
    let res = await checkVendorSync({ root: tree.dir, manifest: tree.manifest });
    assert.equal(res.ok, false);
    assert.match(res.problems.join("\n"), /base copy refs\/r\.md is [0-9a-f]{40}, manifest records/);
    await write(tree.dir, baseCopyPath("up", "refs/r.md"), up.r1);
    await write(tree.dir, "plugin/agents/muster-x.md", tree.adapted.replace("ref line 4", "ref line four"));
    res = await checkVendorSync({ root: tree.dir, manifest: tree.manifest });
    assert.match(res.problems.join("\n"), /body differs from the base copy/);
    await rm(join(tree.dir, "plugin/agents/muster-x.md"));
    res = await checkVendorSync({ root: tree.dir, manifest: tree.manifest });
    assert.match(res.problems.join("\n"), /adapted file plugin\/agents\/muster-x\.md is missing/);
  } finally { await rm(up.dir, { recursive: true, force: true }); await rm(tree.dir, { recursive: true, force: true }); }
});

test("a port (file item into another language) is reported, never merged, and its item ref moves with the pin", async () => {
  const up = await fixtureUpstream();
  const tree = await fixtureMuster(up);
  try {
    // Upstream agents/a.md ported into a JS file: not a copy, so no 3-way merge and no base copy.
    const portLine = `      - { from: agents/a.md, to: src/port.js, mode: adapted, ref: ${up.pin}, baseBlob: ${gitBlobSha(up.a1)} }`;
    const manifestText = tree.manifestText.replace("      - { from: workflows/w.md", `${portLine}\n      - { from: workflows/w.md`);
    const manifest = parseYaml(manifestText);
    assert.deepEqual(validateVendorManifest(manifest), { ok: true, errors: [] });
    await write(tree.dir, "src/port.js", "export const port = 1;\n");
    await write(tree.dir, "vendor/manifest.yaml", manifestText);
    const res = await runVendorUpdate({ root: tree.dir, manifest, manifestText, sourceId: "up", toTag: "v1.1.0", upstream: gitUpstream(up.dir) });
    assert.deepEqual(res.conflicts, []);
    assert.deepEqual(res.ports.map(p => [p.file, p.from]), [["src/port.js", "agents/a.md"]]);
    assert.equal(await readFile(join(tree.dir, "src/port.js"), "utf8"), "export const port = 1;\n", "a port is never merged");
    const after = await readFile(join(tree.dir, "vendor/manifest.yaml"), "utf8");
    assert.match(after, new RegExp(`to: src/port\\.js, mode: adapted, ref: ${up.target}, baseBlob: ${gitBlobSha(up.a2)}`));
    assert.equal(parseYaml(after).sources[1].ref, up.pin, "other sources keep their ref");
  } finally { await rm(up.dir, { recursive: true, force: true }); await rm(tree.dir, { recursive: true, force: true }); }
});

test("manifest validation rejects malformed merge-tracked items", () => {
  const src = items => ({ sources: [{ id: "s", kind: "github", repo: "a/b", ref: "a".repeat(40), tag: "v1.0.0", license: "MIT", copyright: "c", relation: "adapted", items }] });
  const blob = "b".repeat(40);
  const errs = items => validateVendorManifest(src(items)).errors.join("\n");
  assert.equal(errs([{ id: "muster-x", kind: "agent", from: "a.md", to: "plugin/agents/muster-x.md", mode: "adapted", baseBlob: blob }]), "");
  assert.match(errs([{ id: "muster-x", kind: "agent", from: "a.md", to: "plugin/agents/other.md", mode: "adapted", baseBlob: blob }]), /to: must be plugin\/agents\/muster-x\.md/);
  assert.match(errs([{ from: "a.md", mode: "watch", baseBlob: "abc" }]), /baseBlob/);
  assert.match(errs([{ id: "x", kind: "agent", from: "a.md", mode: "watch", baseBlob: blob }]), /watch item carries no id/);
  assert.match(errs([{ id: "x", from: "a.md", to: "src/x.js", mode: "adapted", baseBlob: blob }]), /id and kind come together/);
  assert.match(errs([{ from: "a.md", to: "src/x.js", mode: "adapted", ref: "e".repeat(40), baseBlob: blob }]), /shares its source's pin/);
  assert.match(errs([{ from: "a.md", to: "src/x.js" }]), /a file item \(with to\) needs mode/);
  assert.equal(errs([{ from: "a.md", to: "src/x.js", mode: "watch", baseBlob: blob }]), "", "a watch item may name its consumer");
  assert.match(errs([{ from: "a.md", mode: "copied", baseBlob: blob }]), /mode: must be one of/);
  assert.match(errs([{ from: "../a.md", mode: "watch", baseBlob: blob, issues: ["#1"] }]), /from: must be a relative[\s\S]*issues/);
  const noTag = src([{ from: "a.md", mode: "watch", baseBlob: blob }]);
  delete noTag.sources[0].tag;
  assert.match(validateVendorManifest(noTag).errors.join("\n"), /tag: a merge-tracked source records the release tag/);
  // An upstream with no release tags (wshobson/agents) records tag: null and pins by SHA alone.
  const untagged = src([{ from: "a.md", mode: "watch", baseBlob: blob }]);
  untagged.sources[0].tag = null;
  assert.deepEqual(validateVendorManifest(untagged).errors, []);
});

test("updateManifestText on the real manifest: an identity update is byte-identical", async () => {
  const text = await readFile(join(root, "vendor/manifest.yaml"), "utf8");
  const gsd = parseYaml(text).sources.find(s => s.id === "gsd");
  const blobs = new Map(syncItemsOf(gsd).map(i => [i.from, i.baseBlob]));
  assert.equal(updateManifestText(text, "gsd", { ref: gsd.ref, tag: gsd.tag, blobs }), text);
  const moved = updateManifestText(text, "gsd", { ref: "c".repeat(40), tag: "v9.9.9", blobs: new Map([["agents/gsd-planner.md", "d".repeat(40)]]) });
  const before = text.split("\n");
  const after = moved.split("\n");
  assert.equal(after.length, before.length);
  const start = before.indexOf("  - id: gsd");
  const end = before.findIndex((l, i) => i > start && /^ {2}- id: /.test(l));
  const changed = after.map((l, i) => i).filter(i => after[i] !== before[i]);
  // Only gsd's lines move: its ref and tag, every item line repeating the pin, and the
  // lines whose upstream file got a new blob.
  const expected = before.map((l, i) => i).filter(i => i > start && i < end &&
    (/^ {4}(ref|tag): /.test(before[i]) || before[i].includes(`ref: ${gsd.ref}`) || before[i].includes("from: agents/gsd-planner.md,")));
  assert.deepEqual(changed, expected);
  assert.ok(after.includes(`    ref: ${"c".repeat(40)}`) && after.includes("    tag: v9.9.9"));
});

// ---- the real tree -----------------------------------------------------------

const manifest = parseYaml(await readFile(join(root, "vendor/manifest.yaml"), "utf8"));
const gsd = manifest.sources.find(s => s.id === "gsd");

test("gsd is pinned to v1.20.1 and merge-tracked; the offline check is clean", async () => {
  assert.equal(gsd.ref, "9385f4618b52ef68ed8a5e8bdd93cfb25bd87765");
  assert.equal(gsd.tag, "v1.20.1");
  const watch = syncItemsOf(gsd).filter(i => i.mode === "watch").map(i => i.from);
  for (const spine of ["execute-phase", "plan-phase", "verify-work", "code-review"]) assert.ok(watch.includes(`gsd-core/workflows/${spine}.md`), `${spine} is watched`);
  assert.ok(!gsd.items.some(i => /^gsd-(plan-phase|execute-phase|verify-work)$/.test(i.id || "")), "the hand-ported gsd-* builtins left the manifest");
  const res = await checkVendorSync({ root, manifest });
  assert.deepEqual(res.problems, []);
  assert.ok(res.checked >= 30);
});

const SEATS = {
  "muster-planner": { from: "agents/gsd-planner.md", budget: 20000, effort: "high" },
  "muster-plan-checker": { from: "agents/gsd-plan-checker.md", budget: 20000, effort: "high" },
  "muster-verifier": { from: "agents/gsd-verifier.md", budget: 20000, effort: "high" },
  "muster-executor": { from: "agents/gsd-executor.md", budget: 18000, effort: "medium" },
  "muster-reviewer": { from: "agents/gsd-code-reviewer.md", budget: 16000, effort: "high" }
};

for (const [id, want] of Object.entries(SEATS)) {
  test(`${id}: adapted from ${want.from}, within budget, no gsd runtime coupling, verbatim regions intact`, async () => {
    const path = `plugin/agents/${id}.md`;
    const text = await readFile(join(root, path), "utf8");
    assert.ok(Buffer.byteLength(text) <= want.budget, `${id} is ${Buffer.byteLength(text)} bytes, budget ${want.budget}`);
    const { data } = splitFrontmatter(text);
    assert.equal(data.name, id);
    assert.equal(data.effort, want.effort);
    assert.equal(typeof data.description, "string");
    assert.doesNotMatch(data.description, /\n/, "one-line description");
    assert.ok(data.upstream.some(u => u.repo === "open-gsd/gsd-core" && u.path === want.from && u.relation === "adapted" && u.ref === gsd.ref));
    assert.ok(gsd.items.some(i => i.id === id && i.mode === "adapted" && i.from === want.from && i.to === path));
    assert.deepEqual(gsdCouplingHits(text), []);
    // A region cut mid-block must be closed outside the markers, or the rest of the prompt renders as code.
    assert.equal((text.match(/^\s*```/gm) || []).length % 2, 0, "balanced code fences");
    const read =(s, p) => readFile(join(root, baseCopyPath(s, p)), "utf8").catch(() => null);
    const { regions } = parseVerbatimRegions(text);
    assert.ok(regions.length > 0, "load-bearing protocol text is carried in marked verbatim regions");
    const bases = new Map();
    for (const r of regions) bases.set(r.path, await read(r.source, r.path));
    assert.deepEqual(checkVerbatimRegions(text, (s, p) => bases.get(p)).errors, []);
    for (const p of bases.keys())
      assert.ok(gsd.items.some(i => i.to === path && i.from === p && i.mode !== "watch"), `${p} is tracked for ${path}`);
  });
}

test("muster-builder is gone: the executor absorbed it", async () => {
  await assert.rejects(readFile(join(root, "plugin/agents/muster-builder.md")), { code: "ENOENT" });
});

test("toAgent and the agents.generated drift check share vendoredAgentModel", () => {
  const item = { id: "wsh-debugger", roles: ["debug"], from: "x.md", as: "agent" };
  const { content } = toAgent("---\nname: wsh-debugger\n---\nbody\n", item, { repo: "wshobson/agents", license: "MIT", ref: "a".repeat(40), relation: "vendored" });
  assert.equal(splitFrontmatter(content).data.model, vendoredAgentModel(item));
  assert.equal(vendoredAgentModel({ id: "not-in-agents-manifest", roles: ["debug"], model: "prime" }), "opus", "an item pin is honoured off-manifest");
});

test("the CLI routes vendor update/report/check and never falls through to the regenerate path", async () => {
  const cli = join(root, "src/cli.js");
  await assert.rejects(pexec(process.execPath, [cli, "vendor", "update", "gsd"]), e => /missing --to <tag>/.test(e.stderr));
  await assert.rejects(pexec(process.execPath, [cli, "vendor", "report"]), e => /missing <source>/.test(e.stderr));
  const { stdout } = await pexec(process.execPath, [cli, "vendor", "check"]);
  assert.equal(JSON.parse(stdout).ok, true);
});

// ---- superpowers: the second merge-tracked source (generic sync) -------------------------

const superpowers = manifest.sources.find(s => s.id === "superpowers");
const SP_SKILLS = {
  "sp-brainstorm": "brainstorming", "sp-tdd": "test-driven-development", "sp-review": "requesting-code-review",
  "sp-review-recv": "receiving-code-review", "sp-debug": "systematic-debugging",
  "sp-verify": "verification-before-completion", "sp-parallel": "dispatching-parallel-agents"
};

test("superpowers is merge-tracked at v7.0.2: one builtin per skill plus its supporting files, all with base copies", async () => {
  assert.equal(superpowers.ref, "22f0b463e7a5e579904dd6211a520321035526f7");
  assert.equal(superpowers.tag, "v7.0.2");
  const items = syncItemsOf(superpowers);
  assert.equal(items.length, superpowers.items.length, "every superpowers item carries a mode");
  assert.deepEqual(items.filter(i => i.id).map(i => i.id), Object.keys(SP_SKILLS), "sp-plan and sp-subagents stay deleted");
  for (const item of items) {
    assert.equal(item.mode, "adapted", `${item.from} is a merged copy`);
    const id = item.id ?? item.to.split("/")[2];
    const prefix = `skills/${SP_SKILLS[id]}/`;
    assert.ok(item.from.startsWith(prefix), `${item.from} belongs to ${id}'s upstream skill`);
    assert.equal(item.to, `plugin/builtins/${id}/${item.from.slice(prefix.length)}`);
    assert.equal(gitBlobSha(await readFile(join(root, baseCopyPath("superpowers", item.from)))), item.baseBlob);
  }
  const res = await checkVendorSync({ root, manifest });
  assert.deepEqual(res.problems, []);
});

test("superpowers SKILL.md files carry no stale hand-port notes and reference only files they ship", async () => {
  for (const id of Object.keys(SP_SKILLS)) {
    const dir = join(root, "plugin/builtins", id);
    const text = await readFile(join(dir, "SKILL.md"), "utf8");
    assert.doesNotMatch(text, /hand-ported from obra\/superpowers/, `${id}: upstream carries the fix now`);
    const refs = [...text.matchAll(/\]\(([\w./-]+\.md)\)/g), ...text.matchAll(/`([\w-]+\.md)` in this directory/g)].map(m => m[1]);
    for (const rel of refs) await readFile(join(dir, rel));
  }
  await assert.rejects(readFile(join(root, "plugin/builtins/sp-tdd/testing-anti-patterns.md")), { code: "ENOENT" });
  assert.match(await readFile(join(root, "plugin/builtins/sp-tdd/SKILL.md"), "utf8"), /\[writing-good-tests\.md\]\(writing-good-tests\.md\)/);
});

test("syncCatalogEntries keeps merge-tracked builtins in catalog/builtins.generated.yaml, in manifest order", async () => {
  const shipped = parseYaml(await readFile(join(root, "catalog/builtins.generated.yaml"), "utf8"));
  const { builtins, agents } = syncCatalogEntries(superpowers);
  assert.deepEqual(agents, []);
  assert.deepEqual(builtins, shipped.filter(e => e.id.startsWith("sp-")));
  assert.deepEqual(syncCatalogEntries(gsd), { builtins: [], agents: [] }, "gsd's seats carry no roles: hand-registered");
});

test("merge-tracked roles are validated and regenerateRegions needs the source id", () => {
  const src = item => ({ sources: [{ id: "s", kind: "github", repo: "o/r", ref: "a".repeat(40), tag: "v1.0.0", license: "MIT", items: [item] }] });
  const file = { from: "x/y.md", to: "plugin/builtins/b/y.md", mode: "adapted", baseBlob: "b".repeat(40) };
  const builtin = { ...file, id: "b", kind: "builtin", to: "plugin/builtins/b/SKILL.md" };
  assert.deepEqual(validateVendorManifest(src({ ...builtin, roles: ["plan"], rank: 40 })).errors, []);
  assert.match(validateVendorManifest(src({ ...file, roles: ["plan"] })).errors.join("\n"), /only a builtin or agent item/);
  assert.match(validateVendorManifest(src({ ...builtin, roles: [] })).errors.join("\n"), /non-empty list/);
  assert.throws(() => regenerateRegions("x\n", new Map()), /source id is required/);
});
