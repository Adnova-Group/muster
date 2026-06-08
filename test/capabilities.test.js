import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveCapabilities } from "../src/capabilities.js";

const catalog = [
  { id: "serena", kind: "external", roles: ["code-navigation"], rank: 90, recommended: true,
    detect: { kind: "mcp_server", match: "serena" } },
  { id: "muster-grep-nav", kind: "builtin", roles: ["code-navigation"], rank: 30,
    provenance: { adapted_from: "Muster", license: "Apache-2.0" } },
  { id: "muster-planner", kind: "builtin", roles: ["plan"], rank: 50,
    provenance: { adapted_from: "superpowers", license: "MIT" } }
];

test("installed external wins over builtin", () => {
  const a = resolveCapabilities(catalog, { plugins: [], skills: [], mcpServers: ["serena"] });
  assert.deepEqual(a.roles["code-navigation"].chosen, { id: "serena", source: "installed", kind: "mcp" });
});

test("falls back to builtin when external absent", () => {
  const a = resolveCapabilities(catalog, { plugins: [], skills: [], mcpServers: [] });
  assert.deepEqual(a.roles["code-navigation"].chosen, { id: "muster-grep-nav", source: "builtin", kind: "skill" });
});

test("recommends a better absent external", () => {
  const a = resolveCapabilities(catalog, { plugins: [], skills: [], mcpServers: [] });
  assert.ok(a.roles["code-navigation"].recommendations.some(r => r.includes("serena")));
});

test("no recommendation when the recommended external is installed", () => {
  const a = resolveCapabilities(catalog, { plugins: [], skills: [], mcpServers: ["serena"] });
  assert.equal(a.roles["code-navigation"].recommendations.length, 0);
});

test("role with neither external nor builtin resolves to inline", () => {
  const a = resolveCapabilities(catalog, { plugins: [], skills: [], mcpServers: [] });
  assert.deepEqual(a.roles["plan"].chosen, { id: "muster-planner", source: "builtin", kind: "skill" });
  assert.deepEqual(a.roles["security-review"].chosen, { id: "inline", source: "inline", kind: "inline" });
});

const agentCatalog = [
  { id: "muster-agent-planner", kind: "agent", roles: ["plan"], rank: 50,
    provenance: { adapted_from: "Muster", license: "Apache-2.0" } },
  { id: "muster-skill-planner", kind: "builtin", roles: ["brainstorm"], rank: 50,
    provenance: { adapted_from: "Muster", license: "Apache-2.0" } },
  { id: "low-agent", kind: "agent", roles: ["implement"], rank: 20,
    provenance: { adapted_from: "Muster", license: "Apache-2.0" } },
  { id: "ext-agent", kind: "external", roles: ["implement"], rank: 90, recommended: true,
    detect: { kind: "agent", match: "ext-agent" } }
];

test("agent builtin resolves with chosen.kind === agent", () => {
  const a = resolveCapabilities(agentCatalog, { plugins: [], skills: [], mcpServers: [], agents: [] });
  assert.deepEqual(a.roles["plan"].chosen, { id: "muster-agent-planner", source: "builtin", kind: "agent" });
});

test("builtin skill resolves with chosen.kind === skill", () => {
  const a = resolveCapabilities(agentCatalog, { plugins: [], skills: [], mcpServers: [], agents: [] });
  assert.deepEqual(a.roles["brainstorm"].chosen, { id: "muster-skill-planner", source: "builtin", kind: "skill" });
});

test("installed external agent beats a lower-ranked built-in agent", () => {
  const a = resolveCapabilities(agentCatalog, { plugins: [], skills: [], mcpServers: [], agents: ["ext-agent"] });
  assert.deepEqual(a.roles["implement"].chosen, { id: "ext-agent", source: "installed", kind: "agent" });
});

import { loadCatalog } from "../src/catalog.js";
test("debug role resolves to a built-in on a bare machine (not inline)", async () => {
  const cat = await loadCatalog(new URL("../catalog/", import.meta.url));
  const a = resolveCapabilities(cat, { plugins: [], skills: [], mcpServers: [] });
  assert.ok(a.roles["debug"], "debug role must exist");
  assert.equal(a.roles["debug"].chosen.source, "builtin");
  assert.notEqual(a.roles["debug"].chosen.id, "inline");
});
