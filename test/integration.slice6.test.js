import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyFailure, buildDiagnoseManifest } from "../src/diagnose.js";
import { validateManifest } from "../src/manifest.js";
import { computeWaves } from "../src/wave.js";
import { loadCatalog } from "../src/catalog.js";
import { resolveCapabilities } from "../src/capabilities.js";
import { readInstalled } from "../src/harness.js";
import { tmpProject } from "../test-support/helpers.js";

test("a bug symptom seeds a valid, schedulable fix plan with a real debug provider", async () => {
  const home = await tmpProject({}); // bare machine
  const caps = resolveCapabilities(await loadCatalog(new URL("../catalog/", import.meta.url)), await readInstalled(home));
  assert.equal(caps.roles["debug"].chosen.source, "builtin");

  const m = buildDiagnoseManifest(classifyFailure("users report a null pointer on checkout"), caps);
  assert.deepEqual(validateManifest(m), { ok: true, errors: [] });
  const waves = computeWaves(m.plan).map(w => w.map(t => t.id));
  assert.deepEqual(waves, [["repro"], ["root-cause"], ["fix"], ["regression"], ["verify"]]);
  assert.equal(m.crew.find(c => c.stage === "debug").source, "builtin");
});
