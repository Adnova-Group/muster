import { test } from "node:test";
import assert from "node:assert/strict";
import { loadCatalog } from "../src/catalog.js";
import { resolveCapabilities } from "../src/capabilities.js";

const CAT = new URL("../catalog/", import.meta.url);

test("recognizes installed control/audit providers across sources (plugin or mcp)", async () => {
  const cat = await loadCatalog(CAT);
  const installed = {
    plugins: ["serena", "context7", "code-simplifier", "security-guidance", "qodo-skills", "chrome-devtools-mcp"],
    skills: [],
    mcpServers: ["playwright"]
  };
  const a = resolveCapabilities(cat, installed);
  assert.equal(a.roles["code-navigation"].chosen.id, "serena");          // plugin-installed, cross-source match
  assert.equal(a.roles["docs-research"].chosen.id, "context7");
  assert.equal(a.roles["refactor"].chosen.id, "code-simplifier");
  assert.equal(a.roles["security-review"].chosen.id, "security-guidance"); // rank 80 beats pr-review 70
  assert.equal(a.roles["tech-debt"].chosen.id, "qodo-skills");
  assert.equal(a.roles["browser-control"].chosen.id, "playwright");       // mcp server
  for (const r of ["code-navigation", "docs-research", "refactor", "security-review", "tech-debt", "browser-control"])
    assert.equal(a.roles[r].chosen.source, "installed", `${r} not installed-resolved`);
});

test("new roles exist; computer-control recommends desktop-commander when absent", async () => {
  const cat = await loadCatalog(CAT);
  const a = resolveCapabilities(cat, { plugins: [], skills: [], mcpServers: [] });
  assert.ok(a.roles["browser-control"]);
  assert.ok(a.roles["architecture-review"]);
  assert.ok(a.roles["computer-control"]);
  assert.ok(a.roles["computer-control"].recommendations.some(r => /desktop-commander/.test(r)));
});
