import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, access } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { loadCatalog } from "../src/catalog.js";
import { resolveCapabilities } from "../src/capabilities.js";
import { splitFrontmatter, vendoredAgentModel } from "../src/vendor.js";
import { bareCapabilities } from "./test-support/capabilities-helpers.js";

const catalogDir = new URL("../catalog/", import.meta.url);
const agentsFile = new URL("../catalog/agents.generated.yaml", import.meta.url);

async function readAgents() {
  return parse(await readFile(agentsFile, "utf8")) || [];
}

test("loadCatalog resolves with agents.generated.yaml present (validates)", async () => {
  const entries = await loadCatalog(catalogDir);
  assert.ok(entries.length > 0);
  // the vendored agents must be part of the loaded catalog
  assert.ok(entries.some(e => e.id === "wsh-debugger" && e.kind === "agent"));
});

test("every agents.generated.yaml entry is a well-formed MIT agent", async () => {
  const agents = await readAgents();
  assert.ok(agents.length > 0, "agents.generated.yaml must have entries");
  for (const e of agents) {
    assert.equal(e.kind, "agent", `${e.id} kind`);
    assert.ok(Array.isArray(e.roles) && e.roles.length > 0, `${e.id} roles`);
    assert.equal(e.provenance?.license, "MIT", `${e.id} license`);
    assert.deepEqual(e.provenance?.upstream, ["wshobson/agents"], `${e.id} upstream`);
  }
});

test("each vendored agent id has a matching plugin/agents/<id>.md with frontmatter", async () => {
  const agents = await readAgents();
  for (const e of agents) {
    const f = fileURLToPath(new URL(`../plugin/agents/${e.id}.md`, import.meta.url));
    await access(f); // throws if missing
    const text = await readFile(f, "utf8");
    assert.match(text, /^---\n[\s\S]*?\n---\n/, `${e.id}.md must have frontmatter`);
    assert.match(text, /^name:/m, `${e.id}.md frontmatter needs name`);
  }
});

test("core software roles each resolve to SOME provider on a bare machine", async () => {
  const catalog = await loadCatalog(catalogDir);
  const res = resolveCapabilities(catalog, bareCapabilities());
  const required = ["security-review", "debug", "frontend", "test-author", "refactor", "architecture-review"];
  for (const role of required) {
    const chosen = res.roles[role]?.chosen;
    assert.ok(chosen, `role ${role} must exist`);
    assert.notEqual(chosen.source, "inline", `role ${role} must have a real provider, not inline`);
    assert.ok(["agent", "skill", "mcp"].includes(chosen.kind), `role ${role} provider kind`);
  }
});

test("vendored agent plugin files have model frontmatter matching current policy (no drift)", async () => {
  const agents = await readAgents();
  // The manifest item carries any explicit `model:` pin; toAgent reads it, so the drift
  // check must too.
  const manifest = parse(await readFile(new URL("../vendor/manifest.yaml", import.meta.url), "utf8"));
  const items = new Map(manifest.sources.flatMap(s => s.items || []).filter(i => i.as === "agent").map(i => [i.id, i]));
  for (const e of agents) {
    const f = fileURLToPath(new URL(`../plugin/agents/${e.id}.md`, import.meta.url));
    const text = await readFile(f, "utf8");
    const { data: fm } = splitFrontmatter(text);
    // Frontmatter `model:` is a Claude Code surface. The expectation is computed by
    // the SAME function toAgent uses (vendoredAgentModel: the agents.manifest.json
    // profile first, then an item pin, then the role tier), so regeneration and this
    // drift check can never contradict each other.
    const expected = vendoredAgentModel(items.get(e.id) || { id: e.id, roles: e.roles });
    assert.equal(
      fm.model, expected,
      `${e.id}.md has model: ${fm.model} but toAgent would write model: ${expected} — run \`muster vendor\` or fix the frontmatter`
    );
  }
});
