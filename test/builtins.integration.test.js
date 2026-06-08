import { test } from "node:test";
import assert from "node:assert/strict";
import { loadCatalog } from "../src/catalog.js";
import { resolveCapabilities } from "../src/capabilities.js";
import { readInstalled } from "../src/harness.js";
import { tmpProject } from "../test-support/helpers.js";

test("shipped catalog includes generated builtins + still validates", async () => {
  const entries = await loadCatalog(new URL("../catalog/", import.meta.url));
  const builtins = entries.filter(e => e.kind === "builtin");
  assert.ok(builtins.length > 0, "expected generated builtins in the catalog");
  assert.ok(builtins.every(e => e.provenance && e.provenance.license));
});

test("bare machine resolves a builtin-tier role to a real vendored id", async () => {
  const home = await tmpProject({}); // nothing installed
  const caps = resolveCapabilities(await loadCatalog(new URL("../catalog/", import.meta.url)), await readInstalled(home));
  // code-review has vendored builtins (sp-review / wsh-*review) -> should resolve to builtin, not inline
  assert.equal(caps.roles["code-review"].chosen.source, "builtin");
  assert.notEqual(caps.roles["code-review"].chosen.id, "inline");
});
