// The ui-skills.com UX skills (vendored 2026-11-10): eight merge-tracked sources whose
// builtins support the design stack. Pins the contract the integration relies on: every
// builtin is registered in the generated catalog exactly as syncCatalogEntries emits it,
// carries a one-line description, ranks below the wsh frontend builtins (50) so none
// becomes the default frontend provider, keeps every skill-local link resolvable, and
// ships no DESIGN.md that could compete with a project's canonical one.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir, stat } from "node:fs/promises";
import { join, dirname } from "node:path";
import { parse as parseYaml } from "yaml";
import { syncCatalogEntries, syncItemsOf } from "../src/vendor-sync.js";

const root = join(import.meta.dirname, "..");
const UI_SOURCES = {
  "anthropic-skills": "anthropics/skills",
  "taste-skill-classics": "Leonxlnx/taste-skill-classics",
  "addy-agent-skills": "addyosmani/agent-skills",
  "emil-skills": "emilkowalski/skills",
  hallmark: "nutlope/hallmark",
  "gsap-skills": "greensock/gsap-skills",
  "elaya-design-skills": "elayadesign/ai-design-skills",
  "jakubkrehel-skills": "jakubkrehel/skills",
};
const manifest = parseYaml(await readFile(join(root, "vendor/manifest.yaml"), "utf8"));
const sources = manifest.sources.filter(s => s.id in UI_SOURCES);
const builtinItems = sources.flatMap(s => syncItemsOf(s).filter(i => i.kind === "builtin"));
const exists = p => stat(p).then(() => true, () => false);

async function walk(dir) {
  const out = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...await walk(p)); else out.push(p);
  }
  return out;
}

test("every ui-skills source is pinned, merge-tracked and licensed for redistribution", () => {
  assert.deepEqual(sources.map(s => s.id).sort(), Object.keys(UI_SOURCES).sort());
  for (const s of sources) {
    assert.equal(s.repo, UI_SOURCES[s.id]);
    assert.match(s.ref, /^[0-9a-f]{40}$/, `${s.id} pins a commit`);
    assert.ok(["MIT", "Apache-2.0"].includes(s.license), `${s.id} license ${s.license}`);
    assert.ok(s.copyright, `${s.id} records its copyright line`);
    assert.ok(syncItemsOf(s).every(i => i.mode === "adapted"), `${s.id} items are all merge-tracked`);
  }
  assert.equal(builtinItems.length, 46);
});

test("the ui-skills builtins are registered in catalog/builtins.generated.yaml as syncCatalogEntries emits them", async () => {
  const shipped = parseYaml(await readFile(join(root, "catalog/builtins.generated.yaml"), "utf8"));
  const expected = sources.flatMap(s => syncCatalogEntries(s).builtins);
  const ids = new Set(expected.map(e => e.id));
  assert.deepEqual(shipped.filter(e => ids.has(e.id)), expected);
});

test("ui-skills builtins: one-line descriptions, role frontend, ranked below the wsh frontend builtins", async () => {
  for (const item of builtinItems) {
    assert.deepEqual(item.roles, ["frontend"], item.id);
    assert.ok(item.rank < 50, `${item.id} rank ${item.rank} must stay below 50`);
    assert.ok(item.description && !item.description.includes("\n"), `${item.id} needs a one-line description`);
    const text = await readFile(join(root, item.to), "utf8");
    const fm = parseYaml(text.match(/^---\r?\n([\s\S]*?)\r?\n---/)[1]);
    assert.equal(fm.description, item.description, `${item.id} SKILL.md description matches the catalog`);
    assert.equal(fm.muster_builtin, true);
    assert.ok(!("disable-model-invocation" in fm) && !("hooks" in fm), `${item.id} carries no harness keys`);
  }
});

test("ui-skills builtins keep every skill-local markdown link resolvable and ship no DESIGN.md", async () => {
  const dangling = [];
  for (const item of builtinItems) {
    const dir = dirname(join(root, item.to));
    for (const file of await walk(dir)) {
      assert.ok(!/(^|\/)design\.md$/i.test(file), `${file} would compete with a project's canonical DESIGN.md`);
      if (!file.endsWith(".md")) continue;
      const text = (await readFile(file, "utf8")).replace(/```[\s\S]*?```/g, "");
      for (const m of text.matchAll(/\]\(([^)\s]+)\)/g)) {
        const target = m[1].split("#")[0];
        if (!target || /^(https?:|mailto:|\/)/.test(target)) continue;
        if (!await exists(join(dirname(file), target))) dangling.push(`${file} -> ${m[1]}`);
      }
      for (const m of text.matchAll(/(?:\.\.\/)+[\w./-]+/g)) {
        if (!await exists(join(dirname(file), m[0]))) dangling.push(`${file} -> ${m[0]}`);
      }
    }
  }
  assert.deepEqual(dangling, []);
});
