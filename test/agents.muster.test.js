import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { parse } from "yaml";
import { loadCatalog } from "../src/catalog.js";
import { resolveCapabilities } from "../src/capabilities.js";
import { modelForRole } from "../src/model.js";
import { toAgent } from "../src/vendor.js";

// Derive agent ids and primary roles directly from the catalog yaml so that any
// newly added agent is automatically covered — no manual list to update.
//
// Convention (documented in catalog/agents.muster.yaml): roles[0] is the primary
// role for each agent and drives the modelForRole policy assertion below.
const musterYamlUrl = new URL("../catalog/agents.muster.yaml", import.meta.url);
const MUSTER_ENTRIES = parse(await readFile(musterYamlUrl, "utf8"));

// Derive a flat list of ids and a primary-role map from the yaml at test time.
// Adding a 6th (or nth) entry to agents.muster.yaml is sufficient — no test edits needed.
const AGENT_IDS = MUSTER_ENTRIES.map(e => e.id);
// Primary role = roles[0] per catalog convention (first role drives modelForRole policy).
const PRIMARY_ROLE = Object.fromEntries(MUSTER_ENTRIES.map(e => [e.id, e.roles[0]]));

const catalogDir = new URL("../catalog/", import.meta.url);

test("catalog loads with agents.muster.yaml present (no validation error)", async () => {
  await assert.doesNotReject(() => loadCatalog(catalogDir));
});

test("each muster agent id appears with kind: agent", async () => {
  const catalog = await loadCatalog(catalogDir);
  for (const id of AGENT_IDS) {
    const entry = catalog.find(e => e.id === id);
    assert.ok(entry, `missing catalog entry ${id}`);
    assert.equal(entry.kind, "agent", `${id} should be kind: agent`);
  }
});

test("agent roles resolve to a chosen provider with kind 'agent'", async () => {
  const catalog = await loadCatalog(catalogDir);
  const { roles } = resolveCapabilities(catalog, {
    plugins: [], skills: [], mcpServers: [], agents: []
  });
  for (const role of ["implement", "code-review", "code-navigation", "architecture-review"]) {
    assert.equal(roles[role].chosen.kind, "agent", `${role} should resolve to an agent`);
  }
});

test("each agent file's frontmatter model equals modelForRole(primaryRole)", async () => {
  // Count assertion: every yaml entry is iterated — a newly added agent is never silently skipped.
  assert.ok(MUSTER_ENTRIES.length > 0, "agents.muster.yaml must contain at least one entry");
  let covered = 0;
  for (const id of AGENT_IDS) {
    const src = await readFile(new URL(`../plugin/agents/${id}.md`, import.meta.url), "utf8");
    const m = src.match(/^---\n([\s\S]*?)\n---/);
    assert.ok(m, `${id}.md missing YAML frontmatter`);
    const fm = parse(m[1]);
    const expected = modelForRole(PRIMARY_ROLE[id]);
    assert.equal(fm.model, expected, `${id} model should be ${expected}`);
    covered++;
  }
  assert.equal(covered, MUSTER_ENTRIES.length,
    `iterated ${covered} agents but yaml has ${MUSTER_ENTRIES.length} entries`);
});

// Description search feeds off catalog `description`. Every authored + vendored agent
// entry must carry a non-empty string description (input for the description-search ranker).
for (const file of ["agents.muster.yaml", "agents.generated.yaml"]) {
  test(`every agent entry in ${file} has a non-empty string description`, async () => {
    const raw = await readFile(new URL(`../catalog/${file}`, import.meta.url), "utf8");
    const entries = parse(raw);
    assert.ok(Array.isArray(entries) && entries.length > 0, `${file} should parse to a non-empty array`);
    for (const e of entries) {
      assert.equal(typeof e.description, "string", `${e.id}: description must be a string`);
      assert.ok(e.description.trim().length > 0, `${e.id}: description must be non-empty`);
    }
  });
}

test("catalog still loads/validates clean with descriptions present", async () => {
  await assert.doesNotReject(() => loadCatalog(catalogDir));
});

test("toAgent carries source frontmatter description into the catalog entry", () => {
  const sourceText = `---\nname: foo-agent\ndescription: Foo bar\n---\n\n# Foo\nbody\n`;
  const item = { from: "foo.md", id: "wsh-foo", roles: ["implement"], as: "agent" };
  const source = { repo: "wshobson/agents", license: "MIT" };
  const { catalogEntry } = toAgent(sourceText, item, source);
  assert.equal(catalogEntry.description, "Foo bar");
});
