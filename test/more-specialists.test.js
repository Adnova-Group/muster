import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, access } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { loadCatalog } from "../src/catalog.js";

// Canonical ROLES enum (mirrors src/capabilities.js / src/catalog.js).
const ROLES = new Set([
  "code-navigation", "docs-research", "brainstorm", "plan", "implement",
  "code-review", "security-review", "test-author", "refactor", "frontend", "tech-debt", "debug",
  "author", "research", "score",
  "architecture-review", "browser-control", "computer-control",
  "performance", "seo", "humanize", "prompt-quality"
]);

const catalogDir = new URL("../catalog/", import.meta.url);
const agentsFile = new URL("../catalog/agents.generated.yaml", import.meta.url);

// The agents broadened in the more-specialists roster expansion.
const NEW_IDS = [
  "wsh-data-scientist", "wsh-data-engineer", "wsh-devops-troubleshooter",
  "wsh-cloud-architect", "wsh-database-optimizer", "wsh-api-documenter",
  "wsh-ml-engineer", "wsh-prompt-engineer", "wsh-business-analyst",
  "wsh-content-marketer", "wsh-tutorial-engineer", "wsh-customer-support"
];

async function readAgents() {
  return parse(await readFile(agentsFile, "utf8")) || [];
}

test("loadCatalog resolves cleanly with the broadened roster present", async () => {
  const entries = await loadCatalog(catalogDir);
  assert.ok(entries.length > 0);
  for (const id of NEW_IDS) {
    assert.ok(
      entries.some(e => e.id === id && e.kind === "agent"),
      `${id} must be a loaded agent in the catalog`
    );
  }
});

test("each new vendored agent is well-formed: kind, MIT, description, role, plugin file", async () => {
  const agents = await readAgents();
  const byId = new Map(agents.map(e => [e.id, e]));
  for (const id of NEW_IDS) {
    const e = byId.get(id);
    assert.ok(e, `${id} must exist in agents.generated.yaml`);
    assert.equal(e.kind, "agent", `${id} kind`);
    assert.equal(e.provenance?.license, "MIT", `${id} license`);
    assert.equal(typeof e.description, "string", `${id} description is a string`);
    assert.ok(e.description.trim().length > 0, `${id} description non-empty`);
    assert.ok(Array.isArray(e.roles) && e.roles.length > 0, `${id} has roles`);
    for (const r of e.roles) assert.ok(ROLES.has(r), `${id} role "${r}" in ROLES set`);
    const f = fileURLToPath(new URL(`../plugin/agents/${id}.md`, import.meta.url));
    await access(f); // throws if the matching plugin file is missing
    const text = await readFile(f, "utf8");
    assert.match(text, /^---\n[\s\S]*?\n---\n/, `${id}.md must have frontmatter`);
  }
});

test("vendored-agent roster grew to >= 16 entries", async () => {
  const agents = await readAgents();
  const vendored = agents.filter(e => e.kind === "agent" && e.provenance?.license === "MIT");
  assert.ok(
    vendored.length >= 16,
    `expected >= 16 vendored agents, got ${vendored.length}`
  );
});
