// The merge-tracked UX skill family (vendor/manifest.yaml sources uupm, intent, typeui, pfd):
// provenance and catalog resolution, the DESIGN.md-proposal and path adaptations, the
// share-alike rule, routing evidence, the uupm search.py smoke test, and the two vendor-sync
// extensions the family needs (whole-file verbatim items and describe-form pins).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, stat } from "node:fs/promises";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { parse as parseYaml } from "yaml";
import {
  gitBlobSha, gitUpstream, fetchUpstream, runVendorUpdate, checkVendorSync, isWholeFileVerbatim, isDescribePin, baseCopyPath
} from "../src/vendor-sync.js";
import { validateVendorManifest } from "../src/vendor.js";
import { checkShareAlike, isShareAlikeLicense, projectManifest } from "../src/provenance.js";
import { loadCatalog } from "../src/catalog.js";
import { resolveCapabilities } from "../src/capabilities.js";
import { matchProviders, matchSkills, suggestSkillsForStack, signalsFromTask, impliedSurfaceForSkillId } from "../src/match.js";
import { isCodexFrozenOutBuiltin } from "../src/codex-inventory.js";

const pexec = promisify(execFile);
const root = join(import.meta.dirname, "..");
const UX_SOURCES = ["uupm", "intent", "typeui", "pfd"];
const manifestText = await readFile(join(root, "vendor/manifest.yaml"), "utf8");
const manifest = parseYaml(manifestText);
const uxSources = manifest.sources.filter(s => UX_SOURCES.includes(s.id));
const frontmatter = text => parseYaml(text.match(/^---\r?\n([\s\S]*?)\r?\n---/)[1]);
const bare = { skills: [], agents: [], plugins: [], mcpServers: [] };

// The UX family only: impeccable-* and muster-pm are also kept out of the frozen Codex lane but are not UX sources.
const builtinIds = (await readdir(join(root, "plugin/builtins"))).filter(n => isCodexFrozenOutBuiltin(n) && !n.startsWith("impeccable-") && n !== "muster-pm").sort();
const agentIds = (await readdir(join(root, "plugin/agents"))).filter(f => /^intent-/.test(f)).map(f => f.slice(0, -3)).sort();

// ---- provenance --------------------------------------------------------------

test("the UX sources are merge-tracked, pinned to a commit with a tag or describe pin, and the doctor check is clean", async () => {
  assert.deepEqual(uxSources.map(s => s.id), UX_SOURCES);
  for (const s of uxSources) {
    assert.match(s.ref, /^[0-9a-f]{40}$/, `${s.id} pins a commit`);
    assert.ok(/^v\d+\.\d+\.\d+$/.test(s.tag) || isDescribePin(s), `${s.id} tag ${s.tag} is a release or describe pin of its ref`);
    assert.ok(s.copyright, `${s.id} records its copyright line`);
  }
  assert.deepEqual(validateVendorManifest(manifest), { ok: true, errors: [] });
  const check = await checkVendorSync({ root, manifest: { sources: uxSources } });
  assert.deepEqual(check.problems, []);
  assert.ok(check.checked > 200, `checked ${check.checked} UX items`);
});

test("every UX builtin and agent is a manifest item whose upstream: block names its source", async () => {
  const projection = projectManifest(manifest);
  assert.equal(builtinIds.length, 27, "7 uupm + 18 intent + typeui + pfd");
  assert.equal(agentIds.length, 6);
  for (const [kind, ids, path] of [["builtin", builtinIds, id => `plugin/builtins/${id}/SKILL.md`], ["agent", agentIds, id => `plugin/agents/${id}.md`]]) {
    for (const id of ids) {
      const entries = projection.get(`${kind}:${id}`) || [];
      const source = uxSources.find(s => s.items.some(i => i.id === id && i.kind === kind && i.mode));
      assert.ok(source, `${id} is a merge-tracked ${kind} item`);
      const fm = frontmatter(await readFile(join(root, path(id)), "utf8"));
      assert.equal(fm.name, id, `${id} frontmatter name is its id`);
      assert.equal(typeof fm.description, "string");
      assert.ok(fm.description.length > 0 && !fm.description.includes("\n"), `${id} has a one-line description`);
      assert.equal(fm.license, source.license, `${id} declares its source license`);
      assert.deepEqual(fm.upstream, entries, `${id} upstream: equals the manifest projection`);
      assert.ok(entries.some(e => e.repo === source.repo && e.ref === source.ref), `${id} credits ${source.repo}`);
    }
  }
});

test("adapted files have byte-exact base copies; verbatim files are their own base copy", async () => {
  for (const s of uxSources) {
    for (const item of s.items.filter(i => i.mode && i.mode !== "watch")) {
      const items = s.items.filter(i => i.mode);
      const basePath = isWholeFileVerbatim(item, items) ? item.to : baseCopyPath(s.id, item.from);
      assert.equal(gitBlobSha(await readFile(join(root, basePath), "utf8")), item.baseBlob, `${s.id} ${item.from}`);
      if (item.mode === "verbatim") assert.ok(isWholeFileVerbatim(item, items), `${item.to} is a whole-file copy`);
    }
  }
});

test("NOTICE carries every UX source's license, copyright and the PFD trademark notice", async () => {
  const [notice, cowork] = await Promise.all([readFile(join(root, "NOTICE"), "utf8"), readFile(join(root, "cowork/NOTICE"), "utf8")]);
  assert.equal(notice, cowork, "cowork/NOTICE stays byte-identical");
  for (const s of uxSources) {
    assert.ok(notice.includes(`- ${s.repo} @ ${s.ref} (${s.license})`), `${s.repo} listed`);
    assert.ok(notice.includes(s.copyright), `${s.repo} copyright`);
  }
  assert.match(notice, /"Perception-First Design" is a trademark of Stefan Kovalik \/ Aurochs \(Serial 99686343\)/);
  assert.match(notice, /Permission is hereby granted, free of charge/, "the MIT permission notice travels with the MIT sources");
});

test("share-alike: pfd stays CC-BY-SA-4.0 with a license header, and the rule flags a relicensed copy", async () => {
  const text = await readFile(join(root, "plugin/builtins/pfd/SKILL.md"), "utf8");
  assert.equal(frontmatter(text).license, "CC-BY-SA-4.0");
  assert.match(text, /\n---\n<!-- License: CC BY-SA 4\.0 \(https:\/\/creativecommons\.org\/licenses\/by-sa\/4\.0\/\)\. This file is adapted from skovalik\/perception-first-design @ [0-9a-f]{40}[^>]*Changes made by Muster:/);
  assert.ok(isShareAlikeLicense("CC-BY-SA-4.0") && !isShareAlikeLicense("MIT") && !isShareAlikeLicense("CC0-1.0"));
  const entry = { repo: "skovalik/perception-first-design", ref: "a".repeat(40), path: "skills/pfd/SKILL.md", license: "CC-BY-SA-4.0", relation: "adapted" };
  assert.deepEqual(checkShareAlike("builtin:pfd", [entry], "CC-BY-SA-4.0"), []);
  assert.match(checkShareAlike("builtin:pfd", [entry], "Apache-2.0")[0], /share-alike\), so its license must be CC-BY-SA-4\.0, not Apache-2\.0/);
  assert.deepEqual(checkShareAlike("command:x", [{ ...entry, relation: "inspired-by" }], "Apache-2.0"), [], "ideas carry no share-alike obligation");
  const catalog = parseYaml(await readFile(join(root, "catalog/builtins.muster.yaml"), "utf8"));
  assert.equal(catalog.find(e => e.id === "pfd").provenance.license, "CC-BY-SA-4.0");
});

// ---- adaptations ---------------------------------------------------------------

test("uupm script paths point at muster's builtin location and every cited builtin path exists", async () => {
  const files = [];
  const walk = async dir => { for (const e of await readdir(join(root, dir), { withFileTypes: true })) e.isDirectory() ? await walk(`${dir}/${e.name}`) : e.name.endsWith(".md") && files.push(`${dir}/${e.name}`); };
  for (const id of builtinIds) await walk(`plugin/builtins/${id}`);
  for (const f of files) {
    const text = await readFile(join(root, f), "utf8");
    assert.doesNotMatch(text, /\$\{CLAUDE_PLUGIN_ROOT\}\/\.claude\/skills/, `${f} keeps no upstream plugin path`);
    for (const [, rel] of text.matchAll(/\$\{CLAUDE_PLUGIN_ROOT\}\/(builtins\/[A-Za-z0-9_.\/-]+\.[a-z]+)/g))
      await stat(join(root, "plugin", rel)).catch(() => assert.fail(`${f} cites missing plugin/${rel}`));
  }
  const pro = await readFile(join(root, "plugin/builtins/uupm-ui-ux-pro-max/SKILL.md"), "utf8");
  assert.equal((pro.match(/python3 "\$\{CLAUDE_PLUGIN_ROOT\}\/builtins\/uupm-ui-ux-pro-max\/scripts\/search\.py"/g) || []).length, 10);
});

test("design-system output is a DESIGN.md proposal, never a write over DESIGN.md", async () => {
  const pro = await readFile(join(root, "plugin/builtins/uupm-ui-ux-pro-max/SKILL.md"), "utf8");
  assert.match(pro, /### Step 2b: Present the design system as a DESIGN\.md proposal/);
  assert.match(pro, /Never write over it\./);
  assert.doesNotMatch(pro, /--persist -p/, "the --persist command is gone");
  assert.match(await readFile(join(root, "plugin/builtins/uupm-design-system/SKILL.md"), "utf8"), /proposal for `DESIGN\.md`, never a replacement/);
  for (const id of builtinIds) {
    const text = await readFile(join(root, `plugin/builtins/${id}/SKILL.md`), "utf8");
    if (id !== "pfd") assert.match(text, /`DESIGN\.md`, then accessibility\/WCAG, then impeccable/, `${id} states the precedence`);
  }
});

test("the design-ux audit pattern applies impeccable and uupm by reference, deduplicated, with the precedence", async () => {
  const text = await readFile(join(root, "plugin/commands/audit/references/audit-pattern-design-ux.md"), "utf8");
  assert.match(text, /impeccable's critique dimensions/);
  assert.match(text, /builtins\/uupm-ui-ux-pro-max\/SKILL\.md/);
  assert.match(text, /references\/pro-rules\.md/);
  assert.match(text, /Deduplicate before reporting/);
  assert.match(text, /1\. the project's canonical `DESIGN\.md`[\s\S]*2\. accessibility \/ WCAG 2\.2[\s\S]*3\. impeccable[\s\S]*4\. the supporting skills/);
  assert.doesNotMatch(text, /INTEGRATION SLOT/, "the best-of-breed slot is filled");
  assert.match(text, /builtins\/impeccable-critique\/SKILL\.md[\s\S]*builtins\/uupm-ui-ux-pro-max\/SKILL\.md/, "impeccable leads, uupm follows");
  for (const id of ["jk-interface-review", "emil-review-animations", "addy-browser-testing-with-devtools"]) assert.match(text, new RegExp(`\`${id}\``));
  assert.doesNotMatch(text, /pre-verbal|five layers|Perception-First/i, "no PFD wording in a muster-authored file");
  assert.doesNotMatch(text, /\| Priority \| Category \|/, "uupm's table is referenced, not copied");
});

// ---- catalog and routing -------------------------------------------------------

test("each UX builtin and agent has one catalog entry with a role, single-token keywords and a distinct rank per role", async () => {
  const catalog = await loadCatalog(join(root, "catalog"));
  const family = catalog.filter(e => builtinIds.includes(e.id) || agentIds.includes(e.id));
  assert.deepEqual(family.map(e => e.id).sort(), [...builtinIds, ...agentIds].sort());
  const seen = new Map();
  for (const e of family) {
    assert.equal(e.kind, agentIds.includes(e.id) ? "agent" : "builtin");
    assert.ok(e.keywords.length > 0 && e.keywords.every(k => /^[a-z0-9]+$/.test(k)), `${e.id} keywords are single tokens`);
    // uupm-ui-ux-pro-max's catalog description is worded for the ranker; the rest mirror their file.
    if (e.id !== "uupm-ui-ux-pro-max")
      assert.equal(e.description, frontmatter(await readFile(join(root, agentIds.includes(e.id) ? `plugin/agents/${e.id}.md` : `plugin/builtins/${e.id}/SKILL.md`), "utf8")).description, `${e.id} catalog description matches its file`);
    for (const role of e.roles) {
      const key = `${role}:${e.rank}`;
      assert.ok(!seen.has(key), `${e.id} and ${seen.get(key)} share rank ${e.rank} on ${role}`);
      seen.set(key, e.id);
    }
  }
  const { roles } = resolveCapabilities(catalog, bare);
  for (const [role, id] of Object.entries({ frontend: "wsh-frontend-developer", author: "wsh-content-marketer", image: "muster-image", plan: "muster-strategist", brainstorm: "sp-brainstorm" }))
    assert.equal(roles[role].chosen.id, id, `${role} keeps its default provider`);
  assert.equal(roles.frontend.chain.find(c => builtinIds.includes(c.id)).id, "uupm-ui-ux-pro-max", "uupm leads the UX family on frontend");
  // impeccable is the main UX skill: every impeccable-* entry outranks every UX-family entry on its role.
  const impeccable = catalog.filter(e => e.id.startsWith("impeccable-"));
  assert.ok(impeccable.some(e => e.id === "impeccable-critique") && impeccable.some(e => e.id === "impeccable-audit"));
  for (const e of impeccable)
    for (const role of e.roles)
      for (const f of family.filter(x => x.roles.includes(role)))
        assert.ok(e.rank > f.rank, `${e.id} (${e.rank}) outranks ${f.id} (${f.rank}) on ${role}`);
  const ladder = catalog.filter(e => e.roles.includes("frontend") && (e.id.startsWith("impeccable-") || builtinIds.includes(e.id) || agentIds.includes(e.id)));
  assert.equal(new Set(ladder.map(e => e.rank)).size, ladder.length, "no two UX entries tie on frontend");
  const chainIds = roles.frontend.chain.map(c => c.id);
  assert.ok(chainIds.indexOf("impeccable-critique") < chainIds.indexOf("uupm-ui-ux-pro-max"), "impeccable-critique precedes uupm on frontend");
});

test("routing: impeccable-critique is the default UX review skill; uupm-ui-ux-pro-max follows as the data layer", async () => {
  const catalog = await loadCatalog(join(root, "catalog"));
  const { skills } = resolveCapabilities(catalog, bare);
  const task = "review the settings page UX and accessibility";
  const ranked = matchSkills(task, skills).map(m => m.id);
  assert.equal(ranked[0], "impeccable-critique");
  assert.ok(ranked.indexOf("uupm-ui-ux-pro-max") > 0, "uupm still surfaces, after impeccable");
  const stack = suggestSkillsForStack(signalsFromTask(task), skills).map(s => s.id);
  assert.deepEqual(stack.slice(0, 3), ["impeccable-critique", "impeccable-audit", "uupm-ui-ux-pro-max"]);
  assert.equal(impliedSurfaceForSkillId("impeccable-critique"), "ui");
  assert.equal(impliedSurfaceForSkillId("uupm-ui-ux-pro-max"), "ui");
  assert.equal(matchProviders("audit the dashboard UI for accessibility and performance", catalog, bare)[0].id, "impeccable-audit");
  assert.equal(matchProviders("rewrite the error messages and button labels", catalog, bare)[0].id, "impeccable-clarify");
  const landing = matchProviders("build a landing page", catalog, bare).map(m => m.id);
  assert.equal(landing[0], "impeccable-core");
  assert.ok(landing.includes("uupm-ui-ux-pro-max"));
  assert.equal(matchProviders("build a landing page", catalog, bare).filter(m => agentIds.includes(m.id)).length, 0, "no intent agent claims a generic build task");
  // The evaluator agent and the evaluation skill complement each other: both surface, never tied.
  const evalTop = matchProviders("run a heuristic evaluation of the settings screens", catalog, bare).slice(0, 2);
  assert.deepEqual(evalTop.map(m => m.id).sort(), ["intent-evaluate", "intent-vigil"]);
  assert.notEqual(evalTop[0].score, evalTop[1].score);
  assert.equal(matchProviders("design a pitch deck with slides", catalog, bare)[0].id, "uupm-slides");
});

// ---- uupm search.py smoke --------------------------------------------------------

const python = await pexec("python3", ["--version"]).then(() => "python3", () => null);
test("uupm search.py runs from an unrelated cwd and writes nothing there", { skip: python ? false : "python3 not installed" }, async () => {
  const cwd = await mkdtemp(join(tmpdir(), "muster-uupm-smoke-"));
  const script = join(root, "plugin/builtins/uupm-ui-ux-pro-max/scripts/search.py");
  try {
    const style = await pexec(python, ["-I", script, "dashboard dark mode", "--domain", "style", "-n", "1"], { cwd });
    assert.match(style.stdout, /\*\*Domain:\*\* style/);
    assert.match(style.stdout, /\*\*Found:\*\* [1-9]/);
    const system = await pexec(python, ["-I", script, "fintech dashboard dark mode", "--design-system", "-p", "Smoke"], { cwd, maxBuffer: 8 << 20 });
    assert.match(system.stdout, /RECOMMENDED DESIGN SYSTEM/);
    assert.deepEqual(await readdir(cwd), [], "no design-system/ tree is persisted");
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

// ---- vendor-sync extensions: whole-file verbatim items and describe pins ------------

const GIT_ENV = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t", GIT_CONFIG_NOSYSTEM: "1" };
const git = (dir, ...args) => pexec("git", ["-C", dir, ...args], { env: GIT_ENV }).then(r => r.stdout.trim());
async function write(dir, rel, text) { await mkdir(dirname(join(dir, rel)), { recursive: true }); await writeFile(join(dir, rel), text); }

// Upstream: v1.0.0, then one untagged commit (the pin), then v1.1.0 changes the data file.
async function describeFixture() {
  const dir = await mkdtemp(join(tmpdir(), "muster-describe-fixture-"));
  await git(dir, "init", "-q");
  await git(dir, "config", "uploadpack.allowAnySHA1InWant", "true");
  await write(dir, "data/d.csv", "a,b\n1,2\n");
  await write(dir, "SKILL.md", "---\nname: s\n---\nbody\n");
  await git(dir, "add", "-A"); await git(dir, "commit", "-q", "-m", "initial"); await git(dir, "tag", "v1.0.0");
  await write(dir, "data/d.csv", "a,b\n1,2\n3,4\n");
  await git(dir, "commit", "-q", "-am", "more data");
  const pin = await git(dir, "rev-parse", "HEAD");
  const describe = await git(dir, "describe", "--tags", "--long", "HEAD");
  await write(dir, "data/d.csv", "a,b\n1,2\n3,4\n5,6\n");
  await git(dir, "commit", "-q", "-am", "even more data"); await git(dir, "tag", "v1.1.0");
  return { dir, pin, describe };
}

async function describeTree(up) {
  const dir = await mkdtemp(join(tmpdir(), "muster-describe-tree-"));
  const data = "a,b\n1,2\n3,4\n";
  const skill = "---\nname: s\n---\nbody\n";
  await write(dir, "plugin/builtins/x/data/d.csv", data);
  await write(dir, "plugin/builtins/x/SKILL.md", "---\nname: x\n---\nmuster note\nbody\n");
  await write(dir, baseCopyPath("up", "SKILL.md"), skill);
  const text = [
    "sources:", "  - id: up", "    kind: github", "    repo: example/up", `    url: ${up.dir}`, `    ref: ${up.pin}`, `    tag: ${up.describe}`,
    "    license: MIT", '    copyright: "Copyright (c) 2026 Example"', "    relation: vendored", "    items:",
    `      - { id: x, kind: builtin, from: SKILL.md, to: plugin/builtins/x/SKILL.md, mode: adapted, relation: adapted, baseBlob: ${gitBlobSha(skill)} }`,
    `      - { from: data/d.csv, to: plugin/builtins/x/data/d.csv, mode: verbatim, baseBlob: ${gitBlobSha(data)} }`, ""
  ].join("\n");
  await write(dir, "vendor/manifest.yaml", text);
  return { dir, text, manifest: parseYaml(text) };
}

test("a describe pin validates, and a whole-file verbatim item is checked in place without a base copy", async () => {
  const up = await describeFixture();
  const tree = await describeTree(up);
  try {
    assert.match(up.describe, /^v1\.0\.0-1-g[0-9a-f]{7,}$/);
    assert.deepEqual(validateVendorManifest(tree.manifest), { ok: true, errors: [] });
    assert.equal(isDescribePin(tree.manifest.sources[0]), true);
    assert.equal(isDescribePin({ ...tree.manifest.sources[0], ref: "f".repeat(40) }), false, "the abbreviated sha must prefix the ref");
    assert.deepEqual(await checkVendorSync({ root: tree.dir, manifest: tree.manifest }), { ok: true, checked: 2, problems: [], behind: [] });
    await writeFile(join(tree.dir, "plugin/builtins/x/data/d.csv"), "edited\n");
    const tampered = await checkVendorSync({ root: tree.dir, manifest: tree.manifest });
    assert.match(tampered.problems[0], /verbatim file plugin\/builtins\/x\/data\/d\.csv is [0-9a-f]{40}, manifest records/);
  } finally { await rm(up.dir, { recursive: true, force: true }); await rm(tree.dir, { recursive: true, force: true }); }
});

test("vendor update from a describe pin replaces whole-file copies, merges adapted files and moves the pin", async () => {
  const up = await describeFixture();
  const tree = await describeTree(up);
  try {
    const fetched = await fetchUpstream(tree.manifest.sources[0], "v1.1.0");
    try { assert.equal(await fetched.upstream.resolve("refs/muster/pin"), up.pin, "the describe pin is fetched by commit"); }
    finally { await fetched.cleanup(); }
    const res = await runVendorUpdate({ root: tree.dir, manifest: tree.manifest, manifestText: tree.text, sourceId: "up", toTag: "v1.1.0", upstream: gitUpstream(up.dir) });
    assert.deepEqual(res.conflicts, []);
    assert.equal(res.pinMoved, true);
    assert.equal(await readFile(join(tree.dir, "plugin/builtins/x/data/d.csv"), "utf8"), "a,b\n1,2\n3,4\n5,6\n");
    assert.equal(await readFile(join(tree.dir, "plugin/builtins/x/SKILL.md"), "utf8"), "---\nname: x\n---\nmuster note\nbody\n");
    await assert.rejects(stat(join(tree.dir, baseCopyPath("up", "data/d.csv"))), "no base copy is written for a whole-file item");
    const after = parseYaml(await readFile(join(tree.dir, "vendor/manifest.yaml"), "utf8"));
    assert.equal(after.sources[0].tag, "v1.1.0");
    assert.equal(after.sources[0].items[1].baseBlob, gitBlobSha("a,b\n1,2\n3,4\n5,6\n"));
    assert.deepEqual((await checkVendorSync({ root: tree.dir, manifest: after })).problems, []);
  } finally { await rm(up.dir, { recursive: true, force: true }); await rm(tree.dir, { recursive: true, force: true }); }
});
