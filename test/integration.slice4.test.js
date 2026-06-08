import { test } from "node:test";
import assert from "node:assert/strict";
import { stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpProject } from "../test-support/helpers.js";
import { detectProject } from "../src/detect.js";
import { scaffoldProject } from "../src/setup.js";
import { renderPlanChecklist } from "../src/checklist.js";

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
