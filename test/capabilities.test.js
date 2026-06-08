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
  assert.deepEqual(a.roles["code-navigation"].chosen, { id: "serena", source: "installed" });
});

test("falls back to builtin when external absent", () => {
  const a = resolveCapabilities(catalog, { plugins: [], skills: [], mcpServers: [] });
  assert.deepEqual(a.roles["code-navigation"].chosen, { id: "muster-grep-nav", source: "builtin" });
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
  assert.deepEqual(a.roles["plan"].chosen, { id: "muster-planner", source: "builtin" });
  assert.deepEqual(a.roles["security-review"].chosen, { id: "inline", source: "inline" });
});

import { loadCatalog } from "../src/catalog.js";
test("debug role resolves to a built-in on a bare machine (not inline)", async () => {
  const cat = await loadCatalog(new URL("../catalog/", import.meta.url));
  const a = resolveCapabilities(cat, { plugins: [], skills: [], mcpServers: [] });
  assert.ok(a.roles["debug"], "debug role must exist");
  assert.equal(a.roles["debug"].chosen.source, "builtin");
  assert.notEqual(a.roles["debug"].chosen.id, "inline");
});
