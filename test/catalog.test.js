import { test } from "node:test";
import assert from "node:assert/strict";
import { validateCatalog, loadCatalog } from "../src/catalog.js";

test("validateCatalog rejects entry missing id", () => {
  const { ok, errors } = validateCatalog([{ kind: "builtin", roles: ["plan"], rank: 1 }]);
  assert.equal(ok, false);
  assert.match(errors[0], /id/);
});

test("validateCatalog requires detect for external entries", () => {
  const { ok, errors } = validateCatalog([{ id: "x", kind: "external", roles: ["plan"], rank: 1 }]);
  assert.equal(ok, false);
  assert.match(errors[0], /detect/);
});

test("validateCatalog accepts a valid builtin + external", () => {
  const { ok } = validateCatalog([
    { id: "muster-planner", kind: "builtin", roles: ["plan"], rank: 50,
      provenance: { adapted_from: "superpowers", license: "MIT" } },
    { id: "serena", kind: "external", roles: ["code-navigation"], rank: 90,
      detect: { kind: "mcp_server", match: "serena" } }
  ]);
  assert.equal(ok, true);
});

test("validateCatalog rejects an unknown detect.kind", () => {
  const { ok, errors } = validateCatalog([
    { id: "x", kind: "external", roles: ["plan"], rank: 1, detect: { kind: "filesystem", match: "x" } }
  ]);
  assert.equal(ok, false);
  assert.ok(errors.some(e => /detect\.kind/.test(e)));
});

test("loadCatalog reads + validates the shipped software catalog", async () => {
  const entries = await loadCatalog(new URL("../catalog/", import.meta.url));
  assert.ok(entries.length > 0);
  assert.ok(entries.every(e => e.id && e.kind && Array.isArray(e.roles)));
});
