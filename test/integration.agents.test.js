import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { loadCatalog } from "../src/catalog.js";
import { resolveCapabilities } from "../src/capabilities.js";

const CATALOG = new URL("../catalog/", import.meta.url);
const AGENTS_DIR = new URL("../plugin/agents/", import.meta.url);

// Agent layer: provenance is honored per source, the ladder prefers installed > agent > skill,
// every agent file has a catalog entry (and vice versa), and the dispatch docs wire chosen.kind.

test("muster agents credit atomic as inspiration; vendored agents carry MIT provenance", async () => {
  const catalog = await loadCatalog(CATALOG);
  const agents = catalog.filter(e => e.kind === "agent");
  assert.ok(agents.length >= 13, "expected the muster + vendored agents");
  for (const a of agents) {
    if (a.id.startsWith("muster-")) {
      assert.equal(a.provenance.license, "Apache-2.0", `${a.id} should be Apache-2.0`);
      assert.ok(a.provenance.inspired_by, `${a.id} must credit inspiration, not copy`);
      assert.ok(!a.provenance.adapted_from, `${a.id} is clean-room — no adapted_from`);
    } else {
      assert.equal(a.provenance.license, "MIT", `${a.id} vendored agent should be MIT`);
      assert.ok(a.provenance.adapted_from, `${a.id} must record its upstream source`);
    }
  }
});

test("the ladder prefers installed external agent > muster agent > skill", async () => {
  const catalog = await loadCatalog(CATALOG);
  // bare machine: implement has no installed external -> a muster agent wins over any skill
  const bare = resolveCapabilities(catalog, { plugins: [], skills: [], mcpServers: [], agents: [] });
  assert.equal(bare.roles.implement.chosen.kind, "agent", "muster agent should win implement on a bare machine");
  assert.equal(bare.roles.implement.chosen.id, "muster-builder", "builder is the default implementer (rank 56)");

  // if an external agent is installed for a role, it outranks the built-in agent
  const externalForImplement = catalog.find(e => e.kind === "external" && e.roles.includes("implement"));
  if (externalForImplement) {
    const m = externalForImplement.detect.match;
    const withExt = resolveCapabilities(catalog, { plugins: [m], skills: [m], mcpServers: [m], agents: [m] });
    assert.equal(withExt.roles.implement.chosen.source, "installed", "installed external must win when present");
  }
});

test("every plugin/agents/*.md has a catalog entry and every agent entry has a file", async () => {
  const catalog = await loadCatalog(CATALOG);
  const agentIds = new Set(catalog.filter(e => e.kind === "agent").map(e => e.id));
  const files = (await readdir(AGENTS_DIR)).filter(f => f.endsWith(".md"));
  const fileIds = new Set(files.map(f => f.slice(0, -3)));
  for (const id of agentIds) assert.ok(fileIds.has(id), `agent "${id}" has no plugin/agents/${id}.md`);
  for (const id of fileIds) assert.ok(agentIds.has(id), `orphan agent file ${id}.md has no catalog entry`);
});

test("orchestrator + go dispatch by chosen.kind and apply the role model", async () => {
  const orch = await readFile(new URL("../plugin/skills/orchestrator/SKILL.md", import.meta.url), "utf8");
  assert.match(orch, /chosen\.kind/, "orchestrator must dispatch by chosen.kind");
  assert.match(orch, /subagent_type|agentType/, "orchestrator must dispatch agents as the subagent type");
  assert.match(orch, /model.*override|override.*model/i, "orchestrator must pass the role model as an override");
  // go.md is the canonical hands-off runner now (autopilot.md is a legacy alias stub —
  // see the alias-shape/alias-guidance checks in test/mode-evals.test.js).
  const go = await readFile(new URL("../plugin/commands/go.md", import.meta.url), "utf8");
  assert.match(go, /chosen\.kind|provider kind/, "go must note provider-kind dispatch");
});
