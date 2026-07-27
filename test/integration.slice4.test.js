import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpProject } from "../test-support/helpers.js";
import { detectProject } from "../src/detect.js";
import { scaffoldProject } from "../src/setup.js";
import { renderPlanChecklist } from "../src/checklist.js";
import { initializeProject, transitionNativeInit, acknowledgeNativeInitHandoff, finalizeInitialization } from "../src/init.js";

async function exists(p) { try { await stat(p); return true; } catch { return false; } }

test("greenfield dir becomes non-greenfield after scaffold", async () => {
  const dir = await tmpProject({});
  const before = await detectProject(dir);
  assert.equal(before.greenfield, true);
  await scaffoldProject(dir);
  const after = await detectProject(dir);
  assert.equal(after.greenfield, false);   // .git + files now exist
  assert.ok(await exists(join(dir, "docs/plan")));
});

test("checklist ticks as waves complete", async () => {
  const plan = [{ id: "a", task: "A", mode: "single" }, { id: "b", task: "B", mode: "tournament" }];
  assert.match(renderPlanChecklist(plan, []), /- \[ \] a/);
  assert.match(renderPlanChecklist(plan, ["a"]), /- \[x\] a/);
  assert.match(renderPlanChecklist(plan, ["a", "b"]), /- \[x\] b — B \(tournament\)/);
});

test("init keeps native handoff pending until explicit acknowledgement and finalizes deterministically", async () => {
  const dir = await tmpProject({});
  const prepared = await initializeProject(dir);
  assert.equal(prepared.receipt.classification, "greenfield");
  assert.equal(prepared.receipt.nativeInit.state, "not-requested");
  assert.equal(prepared.observedNativeEvidence, null);

  const handoff = await transitionNativeInit(dir, {
    to: "handoff", reason: "unavailable", expectedArtifacts: [],
  });
  assert.equal(handoff.receipt.nativeInit.state, "handoff");
  await assert.rejects(() => finalizeInitialization(dir), /native initialization is pending/);

  await acknowledgeNativeInitHandoff(dir, { reason: "unavailable" });
  const finalized = await finalizeInitialization(dir);
  assert.equal(finalized.receipt.phase, "finalized");
  assert.equal(finalized.receipt.nativeInit.state, "handoff");
  assert.ok(finalized.receipt.artifacts.created.includes("README.md"));
  assert.ok(finalized.receipt.artifacts.created.includes("docs/design/.gitkeep"));

  const rerun = await initializeProject(dir);
  assert.deepEqual(rerun, finalized);

  const clone = await tmpProject({
    "README.md": "User README\n",
    "AGENTS.md": "User instructions\n",
    "package.json": "{}\n",
  });
  await initializeProject(clone);
  await transitionNativeInit(clone, { to: "handoff", reason: "unavailable", expectedArtifacts: [] });
  await acknowledgeNativeInitHandoff(clone, { reason: "unavailable" });
  const preserved = await finalizeInitialization(clone);
  assert.deepEqual(preserved.receipt.artifacts.created, []);
  assert.equal(await readFile(join(clone, "README.md"), "utf8"), "User README\n");
  assert.equal(await exists(join(clone, "docs/design/.gitkeep")), false);
});
