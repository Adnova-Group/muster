import { test } from "node:test";
import assert from "node:assert/strict";
import { ROLES } from "../src/roles.js";

// The role vocabulary used to be duplicated in capabilities.js (array) and
// catalog.js (Set). Both now import from roles.js — assert they observe the
// identical set so a drift between consumers can never reappear silently.
test("roles.js is the single source for the 21-role vocabulary", () => {
  assert.equal(ROLES.length, 21, "expected 21 roles");
  assert.equal(new Set(ROLES).size, ROLES.length, "roles must be unique");
});

test("capabilities and catalog see the same role set", async () => {
  // capabilities.js resolves a manifest keyed by every role; catalog.js
  // validates entries against its role Set. Both derive from roles.js, so a
  // role accepted by catalog must be resolvable by capabilities and vice versa.
  const { resolveCapabilities } = await import("../src/capabilities.js");
  const { validateCatalog } = await import("../src/catalog.js");

  // capabilities: which roles get a manifest entry
  const caps = resolveCapabilities([], { plugins: [], skills: [], mcpServers: [], agents: [] });
  const capRoles = new Set(Object.keys(caps.roles));

  // catalog: a fabricated entry tagged with every role must validate clean
  const entry = {
    id: "x", kind: "builtin", rank: 1, roles: [...ROLES],
    provenance: { license: "MIT" }
  };
  const res = validateCatalog([entry]);
  assert.ok(res.ok, `catalog rejected a known role: ${JSON.stringify(res.errors)}`);

  // a role catalog rejects must be absent from capabilities, and vice versa
  for (const r of ROLES) assert.ok(capRoles.has(r), `capabilities missing role ${r}`);
  assert.equal(capRoles.size, ROLES.length, "capabilities has roles outside the vocabulary");

  const bad = validateCatalog([{ ...entry, roles: ["not-a-real-role"] }]);
  assert.ok(!bad.ok, "catalog must reject a role outside roles.js");
});
