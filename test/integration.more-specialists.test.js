import { test } from "node:test";
import assert from "node:assert/strict";
import { loadCatalog } from "../src/catalog.js";
import { matchProviders } from "../src/match.js";
import { bareCapabilities } from "./test-support/capabilities-helpers.js";

const CATALOG = new URL("../catalog/", import.meta.url);
const bare = bareCapabilities();

// The expanded multi-domain specialist roster is reachable via description-search,
// even where the task doesn't map to a fixed role.

const cases = [
  { task: "analyze our data pipeline and warehouse metrics", want: /data-engineer|data-scientist/ },
  { task: "write a go-to-market content marketing plan", want: /content-marketer/ },
  { task: "do a business case analysis with KPIs", want: /business-analyst/ },
  { task: "troubleshoot a kubernetes deploy incident", want: /devops|cloud/ }
];

for (const { task, want } of cases) {
  test(`match surfaces a relevant specialist for: ${task}`, async () => {
    const catalog = await loadCatalog(CATALOG);
    const ranked = matchProviders(task, catalog, bare);
    const ids = ranked.slice(0, 5).map(r => r.id);
    assert.ok(ids.some(id => want.test(id)), `expected ${want} in top 5 for "${task}", got ${ids.join(",")}`);
  });
}

test("the vendored specialist roster grew past the original 8", async () => {
  const catalog = await loadCatalog(CATALOG);
  const vendored = catalog.filter(e => e.kind === "agent" && e.id.startsWith("wsh-"));
  assert.ok(vendored.length >= 16, `expected >=16 vendored agents, got ${vendored.length}`);
  for (const e of vendored) assert.ok(e.description?.length > 0, `${e.id} needs a description`);
});
