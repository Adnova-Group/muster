import { test } from "node:test";
import assert from "node:assert/strict";
import { tmpProject } from "./helpers.js";
import { detectProject } from "../src/detect.js";
import { loadCatalog } from "../src/catalog.js";
import { readInstalled } from "../src/harness.js";
import { resolveCapabilities } from "../src/capabilities.js";
import { validateManifest } from "../src/manifest.js";

test("detect -> capabilities -> hand-built manifest validates (bare machine)", async () => {
  const proj = await tmpProject({ "package.json": { dependencies: { express: "4" } } });
  const home = await tmpProject({}); // nothing installed
  const profile = await detectProject(proj);
  const caps = resolveCapabilities(await loadCatalog(new URL("../catalog/", import.meta.url)), await readInstalled(home));

  assert.equal(profile.shape, "backend");
  // code-navigation has no vendored builtin; it falls to inline when serena is absent
  assert.ok(["builtin", "inline"].includes(caps.roles["code-navigation"].chosen.source));
  assert.ok(caps.roles["code-navigation"].recommendations.length >= 1);

  const manifest = {
    outcome: "Add rate limiting to the API",
    successCriteria: ["429 past N req/min/key", "tests green"],
    crew: [{
      stage: "implement",
      provider: caps.roles["implement"].chosen.id,
      source: caps.roles["implement"].chosen.source,
      rationale: "backend express service",
      evidence: `shape=${profile.shape}, express in deps`,
      fallback: "inline"
    }],
    recommendations: caps.roles["code-navigation"].recommendations,
    degradations: ["code-navigation fell to inline (no LSP server, no builtin)"],
    plan: [{ id: "middleware", task: "rate-limit middleware", mode: "single", deps: [] },
           { id: "store", task: "token-bucket store", mode: "tournament", deps: ["middleware"], note: "in-mem vs redis" }]
  };
  assert.deepEqual(validateManifest(manifest), { ok: true, errors: [] });
});
