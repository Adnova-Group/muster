// `muster skills` (src/skills.js, src/skill-registry.js, src/skill-pins.js): browse, search,
// per-project enable/add/disable, pins, usage, and the generated skill-library page. Every network
// call goes through an injected fetch; nothing here touches the real network or the user cache.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { trackedMkdtemp } from "../test-support/helpers.js";
import {
  SKILLS_PAGE_PATH, addSkill, builtinInventory, disableSkill, enableSkill, generateSkillsBlock, groupBuiltins,
  pinSkill, runSkillsCli, searchSkills, skillUsage, stampSkillsPage, unpinSkill,
} from "../src/skills.js";
import {
  REGISTRY_URL, githubSource, licenseVerdict, loadRegistry, matchRegistry, normalizeRegistry, referencedFiles,
  registryCachePath, safeSkillFile, suggestFromCachedRegistry, userCacheDir,
} from "../src/skill-registry.js";
import { readPins, resolvePins } from "../src/skill-pins.js";
import { buildArgsFromPlan, writeBuildArgs } from "../src/build-args.js";
import { specialistCatalog } from "../src/specialists.js";
import { runPreflight } from "../src/preflight.js";

const root = fileURLToPath(new URL("../", import.meta.url));
const REGISTRY = JSON.parse(await readFile(join(root, "test/fixtures/ui-skills-registry.json"), "utf8"));
const inv = builtinInventory();
const tmp = (p) => trackedMkdtemp(join(tmpdir(), `muster-skills-${p}-`));
const NOW = new Date("2026-11-10T12:00:00Z");
const SHA = "a".repeat(40);

const response = (status, body) => ({ ok: status >= 200 && status < 300, status, text: async () => (typeof body === "string" ? body : JSON.stringify(body)) });
const noNetwork = async (url) => { throw new Error(`network disabled in tests: ${url}`); };

// A router over URL -> [status, body]; records every URL it served.
function mockFetch(routes) {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    for (const [match, reply] of routes) if (typeof match === "string" ? url === match : match.test(url)) return response(...(typeof reply === "function" ? reply(url) : reply));
    return response(404, "not found");
  };
  return { fetchImpl, calls };
}

async function capture(argv, opts) {
  let out = "", err = "";
  const code = await runSkillsCli(argv, { stdout: { write: (s) => { out += s; } }, stderr: { write: (s) => { err += s; } }, fetchImpl: noNetwork, now: NOW, ...opts });
  return { code, out, err };
}

async function seedCache(cacheDir, fetchedAt = NOW.toISOString()) {
  await mkdir(cacheDir, { recursive: true });
  await writeFile(registryCachePath(cacheDir), JSON.stringify({ url: REGISTRY_URL, fetchedAt, registry: REGISTRY.registry }));
}

// ── inventory, list, show ────────────────────────────────────────────────────

test("inventory: every plugin/builtins dir, with stamped license and upstream, catalog roles when catalogued", () => {
  const dirs = readdirSync(join(root, "plugin/builtins")).filter((d) => existsSync(join(root, "plugin/builtins", d, "SKILL.md")));
  assert.equal(inv.length, dirs.length);
  const tdd = inv.find((b) => b.id === "sp-tdd");
  assert.equal(tdd.license, "MIT");
  assert.deepEqual(tdd.roles, ["test-author"]);
  assert.equal(tdd.upstream[0].repo, "obra/superpowers");
  assert.ok(tdd.files.includes("SKILL.md") && tdd.files.length > 1);
  for (const b of inv) assert.ok(b.license && b.license !== "unknown", `${b.id} has no license`);
});

test("list: grouped by role, filter by role or family, unrouted last; CLI prints source and license per line", async () => {
  const groups = groupBuiltins(inv);
  assert.equal(groups.reduce((n, g) => n + g.skills.length, 0), inv.length, "each builtin listed once");
  if (inv.some((b) => !b.cataloged)) assert.equal(groups.at(-1).role, "unrouted");
  assert.deepEqual(groupBuiltins(inv, "test-author")[0].skills.map((b) => b.id).slice(0, 2), ["sp-tdd", "sp-verify"]);
  assert.ok(groupBuiltins(inv, "emil").flatMap((g) => g.skills).every((b) => b.id.startsWith("emil-")));
  const { code, out } = await capture(["list", "test-author"]);
  assert.equal(code, 0);
  assert.match(out, /^test-author \(\d+\)$/m, 'test-author group header with its count');
  assert.match(out, /obra\/superpowers · MIT: sp-tdd, sp-verify/);
  const full = await capture(["list"]);
  assert.ok(full.out.length < 8 * 1024, `list is ${full.out.length} bytes; keep it compact`);
  const json = JSON.parse((await capture(["list", "--json"])).out);
  assert.equal(json.total, inv.length);
});

test("show: description, source, license, roles, path and project status; unknown ids exit 1 with suggestions", async () => {
  const cwd = await tmp("show");
  const { code, out } = await capture(["show", "sp-tdd"], { cwd });
  assert.equal(code, 0);
  assert.match(out, /license: MIT/);
  assert.match(out, /source: obra\/superpowers @ 22f0b463e7a5 skills\/test-driven-development\/SKILL\.md \(MIT, vendored\)/);
  assert.match(out, /bound to: test-author/);
  assert.match(out, /plugin\/builtins\/sp-tdd\/SKILL\.md/);
  assert.match(out, /project: not enabled, not pinned/);
  const bad = await capture(["show", "sp-tddd"], { cwd });
  assert.equal(bad.code, 1);
  assert.match(bad.out, /did you mean/);
  assert.equal((await capture(["show"], { cwd })).code, 2);
});

// ── registry: cache, search, timeout ─────────────────────────────────────────

test("userCacheDir: MUSTER_CACHE_DIR, then the platform convention", () => {
  assert.equal(userCacheDir({ MUSTER_CACHE_DIR: "/c" }, "/h", "linux"), "/c");
  assert.equal(userCacheDir({ XDG_CACHE_HOME: "/x" }, "/h", "linux"), join("/x", "muster"));
  assert.equal(userCacheDir({}, "/h", "linux"), join("/h", ".cache", "muster"));
  assert.equal(userCacheDir({}, "/h", "darwin"), join("/h", "Library", "Caches", "muster"));
  assert.equal(userCacheDir({ LOCALAPPDATA: "C:\\L" }, "/h", "win32"), join("C:\\L", "muster", "Cache"));
});

test("loadRegistry: fresh cache skips the network; stale cache refetches; a failed fetch falls back to the stale copy", async () => {
  const cacheDir = await tmp("cache");
  const net = mockFetch([[REGISTRY_URL, [200, REGISTRY]]]);
  const first = await loadRegistry({ fetchImpl: net.fetchImpl, cacheDir, now: NOW });
  assert.equal(first.source, "network");
  assert.equal(first.skills.length, REGISTRY.registry.length);
  const cached = await loadRegistry({ fetchImpl: noNetwork, cacheDir, now: new Date(NOW.getTime() + 3600_000) });
  assert.equal(cached.source, "cache", "within the TTL the cache answers without a fetch");
  const stale = await loadRegistry({ fetchImpl: noNetwork, cacheDir, now: new Date(NOW.getTime() + 25 * 3600_000) });
  assert.equal(stale.source, "stale-cache");
  assert.match(stale.note, /registry unreachable/);
  const offline = await loadRegistry({ fetchImpl: net.fetchImpl, cacheDir: await tmp("empty"), network: false });
  assert.equal(offline.source, "none");
  assert.equal(net.calls.length, 1);
});

test("loadRegistry: a hung registry times out quickly and leaves builtin-only results", async () => {
  const hang = (url, { signal }) => new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason)));
  const r = await loadRegistry({ fetchImpl: hang, cacheDir: await tmp("hang"), timeoutMs: 30 });
  assert.equal(r.source, "none");
  assert.match(r.note, /timed out after 30 ms/);
});

test("normalizeRegistry drops malformed entries; matchRegistry ranks by slug, topics and description", () => {
  const skills = normalizeRegistry({ registry: [...REGISTRY.registry, { slug: "../evil", user: "x" }, null, { user: "y" }] });
  assert.equal(skills.length, REGISTRY.registry.length);
  const hits = matchRegistry("threejs keyframe animation", skills, { limit: 3 });
  assert.equal(hits[0].ref, "cloudai-x/threejs-animation");
});

test("search: builtins first via match --skills ranking, then registry hits marked not installed; offline adds a note", async () => {
  const cacheDir = await tmp("search");
  const net = mockFetch([[REGISTRY_URL, [200, REGISTRY]]]);
  const r = await searchSkills({ query: "react animation performance", inventory: inv, cacheDir, fetchImpl: net.fetchImpl, now: NOW });
  assert.ok(r.builtins.length > 0 && r.builtins.every((b) => inv.some((x) => x.id === b.id)));
  assert.ok(r.registry.some((m) => m.ref === "emilkowalski/animation-performance"));
  assert.ok(r.registry.every((m) => m.install === `muster skills add ${m.ref}`));
  const offline = await capture(["search", "react", "animation", "--offline"], { env: { MUSTER_CACHE_DIR: await tmp("nocache") } });
  assert.equal(offline.code, 0);
  assert.match(offline.out, /^builtins for "react animation":/);
  assert.match(offline.out, /note: offline and no cached registry; builtin results only/);
  const down = await capture(["search", "react"], { env: { MUSTER_CACHE_DIR: await tmp("down") } });
  assert.match(down.out, /note: registry unreachable/);
});

// ── enable / disable ─────────────────────────────────────────────────────────

test("enable copies a builtin with a provenance header and manifest; refuses to overwrite anything", async () => {
  const cwd = await tmp("enable");
  const r = await enableSkill({ cwd, id: "sp-tdd", inventory: inv, now: NOW });
  assert.equal(r.ok, true);
  const skill = await readFile(join(cwd, ".claude/skills/sp-tdd/SKILL.md"), "utf8");
  assert.match(skill, /^---\nname: test-driven-development\n/, "frontmatter stays first so Claude Code parses it");
  assert.match(skill, /<!-- muster skills: copied from muster \S+ builtin "sp-tdd".*License: MIT\. Upstream: obra\/superpowers@22f0b463e7a5/);
  assert.match(skill, /\nlicense: MIT\n/);
  assert.ok(existsSync(join(cwd, ".claude/skills/sp-tdd/writing-good-tests.md")));
  const manifest = JSON.parse(await readFile(join(cwd, ".claude/skills/.muster-enabled.json"), "utf8"));
  assert.equal(manifest.skills["sp-tdd"].kind, "builtin");
  assert.equal(manifest.skills["sp-tdd"].files.length, r.files);
  assert.match((await enableSkill({ cwd, id: "sp-tdd", inventory: inv })).problems[0], /already installed by muster/);

  await mkdir(join(cwd, ".claude/skills/sp-debug"), { recursive: true });
  await writeFile(join(cwd, ".claude/skills/sp-debug/SKILL.md"), "mine");
  const clash = await enableSkill({ cwd, id: "sp-debug", inventory: inv });
  assert.equal(clash.ok, false);
  assert.match(clash.problems[0], /muster did not create it; refusing to overwrite/);
  assert.equal(await readFile(join(cwd, ".claude/skills/sp-debug/SKILL.md"), "utf8"), "mine");
  assert.equal((await enableSkill({ cwd, id: "no-such", inventory: inv })).ok, false);
});

test("disable removes only unmodified files muster wrote; edited, user-added and sibling files survive", async () => {
  const cwd = await tmp("disable");
  await mkdir(join(cwd, ".claude/skills/mine"), { recursive: true });
  await writeFile(join(cwd, ".claude/skills/mine/SKILL.md"), "user skill");
  assert.equal((await enableSkill({ cwd, id: "sp-tdd", inventory: inv })).ok, true);
  await writeFile(join(cwd, ".claude/skills/sp-tdd/notes.md"), "my notes");
  await writeFile(join(cwd, ".claude/skills/sp-tdd/writing-good-tests.md"), "edited");

  const notMine = await disableSkill({ cwd, id: "mine" });
  assert.equal(notMine.ok, false);
  assert.equal(await readFile(join(cwd, ".claude/skills/mine/SKILL.md"), "utf8"), "user skill");

  const r = await disableSkill({ cwd, id: "sp-tdd" });
  assert.equal(r.ok, true);
  assert.equal(r.removed, 1);
  assert.deepEqual(r.kept, [{ path: "sp-tdd/writing-good-tests.md", reason: "modified since install" }]);
  assert.ok(!existsSync(join(cwd, ".claude/skills/sp-tdd/SKILL.md")));
  assert.equal(await readFile(join(cwd, ".claude/skills/sp-tdd/notes.md"), "utf8"), "my notes");
  assert.equal(await readFile(join(cwd, ".claude/skills/sp-tdd/writing-good-tests.md"), "utf8"), "edited");
  assert.equal(await readFile(join(cwd, ".claude/skills/mine/SKILL.md"), "utf8"), "user skill");
  assert.ok(!existsSync(join(cwd, ".claude/skills/.muster-enabled.json")), "an empty manifest is removed");
});

test("enable/disable round trip leaves no trace; a tampered manifest path outside the skill is never deleted", async () => {
  const cwd = await tmp("roundtrip");
  await mkdir(join(cwd, ".claude/skills/mine"), { recursive: true });
  await writeFile(join(cwd, ".claude/skills/mine/SKILL.md"), "user skill");
  const before = readdirSync(join(cwd, ".claude/skills")).sort();
  for (const id of ["sp-verify", "sp-debug"]) assert.equal((await enableSkill({ cwd, id, inventory: inv })).ok, true);
  assert.equal((await disableSkill({ cwd, id: "sp-verify" })).ok, true);
  assert.ok(existsSync(join(cwd, ".claude/skills/sp-debug/SKILL.md")), "disabling one skill leaves the other");
  const mpath = join(cwd, ".claude/skills/.muster-enabled.json");
  const manifest = JSON.parse(await readFile(mpath, "utf8"));
  manifest.skills["sp-debug"].files.push({ path: "mine/SKILL.md", sha256: "0".repeat(64) }, { path: "sp-debug/../mine/SKILL.md", sha256: "0".repeat(64) });
  await writeFile(mpath, JSON.stringify(manifest));
  const r = await disableSkill({ cwd, id: "sp-debug" });
  assert.equal(r.kept.length, 2);
  assert.ok(r.kept.every((k) => k.reason === "outside the skill directory"));
  assert.equal(await readFile(join(cwd, ".claude/skills/mine/SKILL.md"), "utf8"), "user skill");
  assert.deepEqual(readdirSync(join(cwd, ".claude/skills")).sort(), before);
});

// ── add (registry) ───────────────────────────────────────────────────────────

const SKILL_MD = "---\nname: design-first-ui-prompting\ndescription: turn a goal into a UI prompt\n---\n\n# Design first\n\nSee [the guide](references/guide.md) and [site](https://example.com).\n";
const mengtoRoutes = (license) => [
  [REGISTRY_URL, [200, REGISTRY]],
  ["https://api.github.com/repos/MengTo/Skills/license", license],
  ["https://api.github.com/repos/MengTo/Skills/commits/main", [200, SHA]],
  [`https://raw.githubusercontent.com/MengTo/Skills/${SHA}/agent-skills/ui/design-first-ui-prompting/SKILL.md`, [200, SKILL_MD]],
  [`https://raw.githubusercontent.com/MengTo/Skills/${SHA}/agent-skills/ui/design-first-ui-prompting/ARTICLE.md`, [200, "article"]],
  [`https://raw.githubusercontent.com/MengTo/Skills/${SHA}/agent-skills/ui/design-first-ui-prompting/REFERENCES.md`, [200, "refs"]],
  [`https://raw.githubusercontent.com/MengTo/Skills/${SHA}/agent-skills/ui/design-first-ui-prompting/references/guide.md`, [200, "guide"]],
];

test("add: license-checked install from the commit the branch points at, with provenance header and manifest", async () => {
  const cwd = await tmp("add");
  const net = mockFetch(mengtoRoutes([200, { license: { spdx_id: "MIT" } }]));
  const r = await addSkill({ cwd, ref: "mengto/design-first-ui-prompting", fetchImpl: net.fetchImpl, cacheDir: await tmp("add-cache"), now: NOW, env: {} });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.license, "MIT");
  assert.equal(r.files, 4);
  const skill = await readFile(join(cwd, ".claude/skills/design-first-ui-prompting/SKILL.md"), "utf8");
  assert.match(skill, /^---\nname: design-first-ui-prompting\n/);
  assert.match(skill, /<!-- muster skills: added from the ui-skills\.com registry entry mengto\/design-first-ui-prompting .*Upstream: MengTo\/Skills@aaaaaaaaaaaa agent-skills\/ui\/design-first-ui-prompting\/SKILL\.md\. License: MIT/);
  assert.equal(await readFile(join(cwd, ".claude/skills/design-first-ui-prompting/references/guide.md"), "utf8"), "guide");
  const manifest = JSON.parse(await readFile(join(cwd, ".claude/skills/.muster-enabled.json"), "utf8"));
  assert.deepEqual([manifest.skills["design-first-ui-prompting"].kind, manifest.skills["design-first-ui-prompting"].ref], ["registry", SHA]);
  assert.ok(net.calls.every((u) => /^https:\/\/(www\.ui-skills\.com|api\.github\.com|raw\.githubusercontent\.com)\//.test(u)));
  // The same manifest drives disable.
  assert.equal((await disableSkill({ cwd, id: "design-first-ui-prompting" })).removed, 4);
  assert.ok(!existsSync(join(cwd, ".claude/skills/design-first-ui-prompting")));
});

test("add refuses NONE, NC, ND, NOASSERTION and non-GitHub skills with a clear message and writes nothing", async () => {
  for (const [license, why] of [
    [[404, { message: "Not Found" }], /no license, so all rights are reserved/],
    [[200, { license: { spdx_id: "CC-BY-NC-4.0" } }], /CC-BY-NC-4\.0 forbids commercial use or derivatives/],
    [[200, { license: { spdx_id: "CC-BY-ND-4.0" } }], /forbids commercial use or derivatives/],
    [[200, { license: { spdx_id: "NOASSERTION" } }], /cannot identify the repository's license/],
  ]) {
    const cwd = await tmp("refuse");
    const net = mockFetch(mengtoRoutes(license));
    const r = await addSkill({ cwd, ref: "mengto/design-first-ui-prompting", fetchImpl: net.fetchImpl, cacheDir: await tmp("refuse-cache"), env: {} });
    assert.equal(r.ok, false);
    assert.match(r.problems[0], /^refusing mengto\/design-first-ui-prompting: /);
    assert.match(r.problems[0], why);
    assert.ok(!existsSync(join(cwd, ".claude")), "nothing written on refusal");
    assert.ok(!net.calls.some((u) => u.includes("raw.githubusercontent.com")), "no skill file fetched before the license passes");
  }
  const cwd = await tmp("refuse-host");
  const net = mockFetch([[REGISTRY_URL, [200, REGISTRY]]]);
  const r = await addSkill({ cwd, ref: "danny/motion-ad", fetchImpl: net.fetchImpl, cacheDir: await tmp("host-cache"), env: {} });
  assert.match(r.problems[0], /not hosted on GitHub.*license cannot be checked/);
  assert.equal(net.calls.length, 1);
  const unknown = await addSkill({ cwd, ref: "nobody/nothing", fetchImpl: net.fetchImpl, cacheDir: await tmp("unknown-cache"), env: {} });
  assert.match(unknown.problems[0], /not in the ui-skills\.com registry/);
  const cli = await capture(["add", "mengto/design-first-ui-prompting"], { cwd: await tmp("refuse-cli"), env: { MUSTER_CACHE_DIR: await tmp("cli-cache") }, fetchImpl: mockFetch(mengtoRoutes([404, {}])).fetchImpl });
  assert.equal(cli.code, 1);
  assert.match(cli.out, /^muster skills add: refusing/);
});

test("licenseVerdict, githubSource and file-path guards", () => {
  assert.equal(licenseVerdict("MIT").ok, true);
  assert.equal(licenseVerdict("Apache-2.0").note, null);
  assert.match(licenseVerdict("GPL-3.0").note, /copyleft/);
  assert.match(licenseVerdict("CC-BY-SA-4.0").note, /share-alike/);
  for (const bad of [undefined, "NONE", "NOASSERTION", "CC-BY-NC-SA-4.0", "CC-BY-NC-ND-4.0", "LicenseRef-Proprietary"]) assert.equal(licenseVerdict(bad).ok, false, String(bad));
  const reg = normalizeRegistry(REGISTRY);
  assert.deepEqual(githubSource(reg.find((e) => e.pathSlug === "rams-design/rams")), { owner: "rams-design", repo: "rams-plugin", ref: "master", dir: "skills/rams" });
  assert.equal(githubSource(reg.find((e) => e.pathSlug === "danny/motion-ad")), null);
  assert.equal(safeSkillFile("../x.md"), null);
  assert.equal(safeSkillFile("/etc/passwd.md"), null);
  assert.equal(safeSkillFile("./references/a.md"), "references/a.md");
  assert.deepEqual(referencedFiles("[a](references/a.md) [b](https://x.y/b.md) [c](../c.md) [d](#top)"), ["references/a.md"]);
});

// ── pins ─────────────────────────────────────────────────────────────────────

test("pin/unpin create and edit .muster/config, keep other keys, and validate ids and roles", async () => {
  const cwd = await tmp("pin");
  assert.equal((await pinSkill({ cwd, id: "sp-tdd", inventory: inv })).ok, true);
  assert.equal((await pinSkill({ cwd, id: "impeccable-core", role: "frontend", inventory: inv })).ok, true);
  assert.deepEqual(readPins(cwd), [{ id: "sp-tdd" }, { id: "impeccable-core", role: "frontend" }]);
  const config = JSON.parse(await readFile(join(cwd, ".muster/config"), "utf8"));
  assert.equal(config.version, 1);
  config.other = { keep: true };
  await writeFile(join(cwd, ".muster/config"), JSON.stringify(config));
  assert.match((await pinSkill({ cwd, id: "sp-tdd", role: "nope", inventory: inv })).problems[0], /unknown role/);
  assert.match((await pinSkill({ cwd, id: "no-such", inventory: inv })).problems[0], /unknown skill/);
  const unrouted = inv.find((b) => !b.cataloged);
  if (unrouted) assert.match((await pinSkill({ cwd, id: unrouted.id, inventory: inv })).problems[0], /not in the catalog/);
  assert.equal((await unpinSkill({ cwd, id: "sp-tdd" })).ok, true);
  assert.equal((await unpinSkill({ cwd, id: "sp-tdd" })).ok, false);
  const after = JSON.parse(await readFile(join(cwd, ".muster/config"), "utf8"));
  assert.deepEqual(after.other, { keep: true });
  assert.deepEqual(after.skills.pins, [{ id: "impeccable-core", role: "frontend" }]);
  await writeFile(join(cwd, ".muster/config"), "{not json");
  assert.throws(() => readPins(cwd), /not valid JSON/);
});

const PLAN = `---
run: r1
type: execute
autonomous: true
must_haves: [greet works]
---
<tasks>
<task id="01" type="tracer" wave="1" agent_hint="wsh-test-automator">
  <name>greet</name>
  <files>greet.js, greet.test.js</files>
  <action>implement</action>
  <verify><automated>node --test greet.test.js</automated></verify>
  <done>x</done>
</task>
<task id="02" wave="2" depends_on="01" skills="anthropic-frontend-design">
  <name>page</name>
  <files>page.html</files>
  <action>implement</action>
  <verify><automated>node --test page.test.js</automated></verify>
  <done>x</done>
</task>
</tasks>
`;

test("pins are bound by build-args: unscoped pins on every task, role pins only on tasks carrying that role", async () => {
  const catalog = specialistCatalog();
  const pins = [{ id: "sp-tdd", path: catalog.skills.get("sp-tdd").path }, { id: "impeccable-core", role: "frontend", path: catalog.skills.get("impeccable-core").path }];
  const { args, problems } = buildArgsFromPlan(PLAN, { runId: "r1", catalog, pins });
  assert.deepEqual(problems, []);
  const [t1, t2] = args.waves.flat();
  assert.deepEqual(t1.skills.map((k) => k.id), ["sp-tdd"]);
  assert.deepEqual(t2.skills.map((k) => k.id), ["anthropic-frontend-design", "sp-tdd", "impeccable-core"]);
  assert.equal(t2.skills[2].path, catalog.skills.get("impeccable-core").path);
  assert.deepEqual(t2.pinned, ["sp-tdd", "impeccable-core"]);

  const cwd = await tmp("pin-build");
  await mkdir(join(cwd, ".muster/runs/r1"), { recursive: true });
  await writeFile(join(cwd, ".muster/runs/r1/PLAN.md"), PLAN);
  await writeFile(join(cwd, ".muster/config"), JSON.stringify({ version: 1, skills: { pins: [{ id: "sp-tdd", role: "test-author" }, { id: "gone-skill" }] } }));
  assert.equal(resolvePins(cwd, catalog).pins.length, 1);
  const report = await writeBuildArgs({ cwd, runId: "r1", base: "abc" });
  assert.equal(report.ok, true);
  assert.deepEqual(report.pinned, ["01: sp-tdd"]);
  assert.match(report.warnings[0], /pinned skill gone-skill/);
  const written = JSON.parse(await readFile(join(cwd, ".muster/runs/r1/build-args.json"), "utf8"));
  assert.deepEqual(written.waves[0][0].skills.map((k) => k.id), ["sp-tdd"]);
  assert.equal(written.waves[1][0].skills.some((k) => k.id === "sp-tdd"), false);
});

const AsyncFunction = (async () => {}).constructor;
async function planPrompt(args) {
  const src = await readFile(join(root, "plugin/workflows/plan.js"), "utf8");
  const fn = new AsyncFunction("agent", "parallel", "pipeline", "phase", "log", "args", src.replace(/^export const meta =/, "const meta ="));
  const prompts = [];
  await fn(async (prompt, opts) => {
    prompts.push(prompt);
    return opts.label.startsWith("plan") ? { status: "done", planPath: "p", taskCount: 1, summary: "ok" } : { verdict: "PASS", issues: [] };
  }, null, null, () => {}, () => {}, args);
  return prompts[0];
}

test("pins reach preflight's skill candidates and the planner brief", async () => {
  const cwd = await tmp("pin-preflight");
  const home = await tmp("pin-home");
  await mkdir(join(cwd, ".muster"), { recursive: true });
  await writeFile(join(cwd, ".muster/config"), JSON.stringify({ version: 1, skills: { pins: [{ id: "sp-tdd" }, { id: "impeccable-core", role: "frontend" }] } }));
  const s = await runPreflight({ outcome: "Add a --json flag to the hygiene command", cwd, home, catalogDir: join(root, "catalog"), runId: "r1", now: NOW, env: { MUSTER_CACHE_DIR: await tmp("pf-cache") } });
  assert.deepEqual(s.skills.slice(0, 2), ["sp-tdd", "impeccable-core"]);
  assert.deepEqual(s.pins, [{ id: "sp-tdd" }, { id: "impeccable-core", role: "frontend" }]);
  const prompt = await planPrompt({ runId: "r1", outcome: "x", skills: s.skills, pins: s.pins });
  assert.match(prompt, /Project-pinned skills, always bound at build time: sp-tdd \(every task\), impeccable-core \(tasks with role frontend\)/);
  assert.doesNotMatch(await planPrompt({ runId: "r1", outcome: "x" }), /pinned/);
});

// ── preflight registry suggestions ───────────────────────────────────────────

test("preflight suggests up to 3 cached registry skills only when no builtin is strong, and never fetches", async () => {
  const cacheDir = await tmp("pf-reg");
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => { throw new Error(`preflight fetched ${url}`); };
  try {
    const weak = "threejs skeletal morph targets keyframe blending";
    assert.deepEqual(await suggestFromCachedRegistry(weak, { cacheDir }), [], "no cache, no suggestions");
    await seedCache(cacheDir, "2020-01-01T00:00:00Z");
    const s = await runPreflight({ outcome: weak, cwd: await tmp("pf-cwd"), home: await tmp("pf-home"), catalogDir: join(root, "catalog"), runId: "r2", now: NOW, env: { MUSTER_CACHE_DIR: cacheDir } });
    assert.ok(s.registrySuggestions.length >= 1 && s.registrySuggestions.length <= 3);
    assert.equal(s.registrySuggestions[0].ref, "cloudai-x/threejs-animation");
    assert.equal(s.registrySuggestions[0].note, "not installed; offer `/muster:skills add cloudai-x/threejs-animation` only if the user asks");
    const strong = await runPreflight({ outcome: "write tests first with test-driven development tdd", cwd: await tmp("pf-cwd2"), home: await tmp("pf-home2"), catalogDir: join(root, "catalog"), runId: "r3", now: NOW, env: { MUSTER_CACHE_DIR: cacheDir } });
    assert.equal(strong.registrySuggestions, undefined, "a strong builtin match suppresses registry suggestions");
  } finally {
    globalThis.fetch = realFetch;
  }
});

// ── usage ────────────────────────────────────────────────────────────────────

test("usage aggregates bound, applied, missed and never-used skills across run directories", async () => {
  const cwd = await tmp("usage");
  const run = (id) => join(cwd, ".muster/runs", id);
  for (const id of ["a", "b", "c"]) await mkdir(run(id), { recursive: true });
  await writeFile(join(run("a"), "build-args.json"), JSON.stringify({ runId: "a", waves: [[{ taskId: "01", skills: [{ id: "sp-tdd", path: "x" }, { id: "sp-debug", path: "y" }] }], [{ taskId: "02", skills: [{ id: "sp-tdd", path: "x" }] }]] }));
  await writeFile(join(run("a"), "build-result.json"), JSON.stringify({ summary: "s", result: { runId: "a", tasks: [
    { taskId: "01", skillsApplied: [{ id: "sp-tdd", how: "test first", quote: "q" }], skillsMissing: ["sp-debug"] },
    { taskId: "02", skillsApplied: [] },
  ] } }));
  await writeFile(join(run("a"), "SUMMARY-01.md"), "# SUMMARY 01\n\n- skill sp-tdd: test first\n- skills without evidence: sp-debug\n");
  await writeFile(join(run("b"), "PLAN.md"), PLAN.replace('agent_hint="wsh-test-automator"', 'agent_hint="wsh-test-automator" skills="wsh-javascript-testing-patterns"'));
  await writeFile(join(run("c"), "pipeline-args.json"), JSON.stringify({ phases: [{ id: "draft", skills: [{ id: "muster-author", path: "z" }] }] }));
  await writeFile(join(run("c"), "pipeline-result.json"), JSON.stringify({ phases: [{ id: "draft", skillsApplied: [{ id: "muster-author", how: "drafted" }] }] }));

  const u = await skillUsage({ cwd, inventory: inv });
  assert.equal(u.runs, 3);
  const row = (id) => u.skills.find((s) => s.id === id);
  assert.deepEqual(row("sp-tdd"), { id: "sp-tdd", bound: 2, applied: 1, missed: 1, runs: 1 });
  assert.deepEqual(row("sp-debug"), { id: "sp-debug", bound: 1, applied: 0, missed: 1, runs: 1 });
  assert.deepEqual(row("anthropic-frontend-design"), { id: "anthropic-frontend-design", bound: 1, applied: 0, missed: 0, runs: 1 });
  assert.deepEqual(row("wsh-javascript-testing-patterns"), { id: "wsh-javascript-testing-patterns", bound: 1, applied: 0, missed: 0, runs: 1 });
  assert.deepEqual(row("muster-author"), { id: "muster-author", bound: 1, applied: 1, missed: 0, runs: 1 });
  assert.equal(u.neverUsed.length, inv.length - 5);
  assert.ok(!u.neverUsed.includes("sp-tdd"));
  assert.deepEqual(await skillUsage({ cwd, inventory: inv }), u, "deterministic");
  const cli = await capture(["usage"], { cwd });
  assert.match(cli.out, /^skill usage across 3 runs/);
  assert.match(cli.out, /sp-tdd\s+2\s+1\s+1\s+1/);
  assert.match((await capture(["usage"], { cwd: await tmp("usage-empty") })).out, /no runs under \.muster\/runs/);
});

// ── generated docs page ──────────────────────────────────────────────────────

test("website/reference/skills.md lists every builtin and matches the generator (run npm run docs:skills)", async () => {
  const page = await readFile(join(root, SKILLS_PAGE_PATH), "utf8");
  assert.equal(stampSkillsPage(page, inv), page, "skills.md drift: run `npm run docs:skills`");
  const block = generateSkillsBlock(inv);
  for (const b of inv) assert.ok(block.includes(`| \`${b.id}\` |`), `${b.id} missing from the skill library page`);
  assert.match(await readFile(join(root, "website/.vitepress/config.js"), "utf8"), /link: "\/reference\/skills"/);
});

test("CLI: usage errors exit 2", async () => {
  assert.equal((await capture(["frobnicate"])).code, 2);
  assert.equal((await capture(["enable"])).code, 2);
  assert.equal((await capture(["pin", "sp-tdd", "--role"])).code, 2);
  assert.equal((await capture(["search"])).code, 2);
});

// ── security: symlinked skill directory, untrusted registry text ─────────────

test("disable refuses a symlinked skill directory and never deletes outside the project", async () => {
  const { symlink } = await import("node:fs/promises");
  const cwd = await tmp("symlinked");
  const outside = await tmp("outside");
  assert.equal((await enableSkill({ cwd, id: "sp-verify", inventory: inv })).ok, true);
  const manifestPath = join(cwd, ".claude/skills/.muster-enabled.json");
  const rec = JSON.parse(await readFile(manifestPath, "utf8")).skills["sp-verify"];
  // Recreate the recorded files outside the project, byte-identical, then point the skill dir there.
  const { rm, cp } = await import("node:fs/promises");
  await cp(join(cwd, ".claude/skills/sp-verify"), join(outside, "sp-verify"), { recursive: true });
  await rm(join(cwd, ".claude/skills/sp-verify"), { recursive: true });
  await symlink(join(outside, "sp-verify"), join(cwd, ".claude/skills/sp-verify"), "dir");
  const r = await disableSkill({ cwd, id: "sp-verify" }).catch((e) => ({ ok: false, error: e.message }));
  assert.equal(r.ok, false, "a symlinked skill directory is refused");
  for (const f of rec.files) assert.ok(existsSync(join(outside, f.path)), `outside file survives: ${f.path}`);
});

test("cached registry suggestions carry only refs, never untrusted free text", async () => {
  const cacheDir = await tmp("suggest-safe");
  await seedCache(cacheDir);
  const out = await suggestFromCachedRegistry("react animation motion", { cacheDir, minScore: 1 });
  assert.ok(out.length > 0, "fixture yields suggestions");
  for (const s of out) {
    assert.deepEqual(Object.keys(s).sort(), ["note", "ref"]);
    assert.match(s.ref, /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/);
  }
});
