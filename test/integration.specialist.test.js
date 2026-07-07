import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { loadCatalog } from "../src/catalog.js";
import { matchProviders } from "../src/match.js";
import { bareCapabilities } from "./test-support/capabilities-helpers.js";

const CATALOG = new URL("../catalog/", import.meta.url);
const bare = bareCapabilities();

test("description-search ranks a relevant specialist over the real catalog", async () => {
  const catalog = await loadCatalog(CATALOG);
  const ranked = matchProviders("audit this code for security vulnerabilities", catalog, bare);
  assert.ok(ranked.length > 0, "should surface specialists");
  // a security-relevant provider should be in the top few
  const ids = ranked.slice(0, 5).map(r => r.id);
  assert.ok(ids.some(id => /security|audit/.test(id)), `expected a security specialist in top 5, got ${ids.join(",")}`);
});

test("matching works via DESCRIPTION text, not just id/role (proves description-search)", async () => {
  // synthetic provider whose id/roles do NOT contain the term, only its description does
  const catalog = [
    { id: "zzz-provider", kind: "agent", roles: ["implement"], rank: 50,
      description: "Kubernetes cluster autoscaling and helm chart specialist", provenance: { license: "MIT" } }
  ];
  const ranked = matchProviders("help with kubernetes autoscaling", catalog, bare);
  assert.equal(ranked.length, 1, "the description term must match");
  assert.equal(ranked[0].id, "zzz-provider");
  assert.ok(ranked[0].matched.includes("kubernetes"), "matched via description token");
});

test("every agent catalog entry has a searchable description", async () => {
  const catalog = await loadCatalog(CATALOG);
  for (const e of catalog.filter(x => x.kind === "agent")) {
    assert.equal(typeof e.description, "string");
    assert.ok(e.description.length > 0, `${e.id} needs a description`);
  }
});

test("router skill + README document specialist matching", async () => {
  const router = await readFile(new URL("../plugin/skills/router/SKILL.md", import.meta.url), "utf8");
  assert.match(router, /muster match/, "router must use muster match");
  // public docs: README + architecture deep-dive document specialist/description-search
  const readme = await readFile(new URL("../README.md", import.meta.url), "utf8");
  const arch = await readFile(new URL("../docs/architecture.md", import.meta.url), "utf8");
  assert.match(readme + arch, /specialist/i, "public docs must document specialist matching");
  assert.match(readme + arch, /muster match|description-search/i, "public docs must mention the match ranker");
});
