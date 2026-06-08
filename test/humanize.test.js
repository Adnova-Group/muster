import { test } from "node:test";
import assert from "node:assert/strict";
import { loadCatalog } from "../src/catalog.js";
import { resolveCapabilities } from "../src/capabilities.js";

test("humanize role resolves to the muster-humanizer built-in on a bare machine", async () => {
  const cat = await loadCatalog(new URL("../catalog/", import.meta.url));
  const a = resolveCapabilities(cat, { plugins: [], skills: [], mcpServers: [] });
  assert.ok(a.roles["humanize"], "humanize role must exist");
  assert.equal(a.roles["humanize"].chosen.id, "muster-humanizer");
  assert.equal(a.roles["humanize"].chosen.source, "builtin");
});
