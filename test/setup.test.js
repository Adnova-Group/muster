import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpProject } from "./helpers.js";
import { scaffoldProject } from "../src/setup.js";

async function exists(p) { try { await stat(p); return true; } catch { return false; } }

test("scaffoldProject creates missing files on an empty dir", async () => {
  const dir = await tmpProject({});
  const r = await scaffoldProject(dir);
  assert.ok(r.created.includes("README.md"));
  assert.ok(r.created.includes(".gitignore"));
  assert.ok(r.created.includes("AGENTS.md"));
  assert.ok(await exists(join(dir, "docs/design")));
});

test("scaffoldProject never overwrites existing files", async () => {
  const dir = await tmpProject({ "README.md": "ORIGINAL" });
  const r = await scaffoldProject(dir);
  assert.ok(r.skipped.includes("README.md"));
  assert.equal(await readFile(join(dir, "README.md"), "utf8"), "ORIGINAL");
});

test("scaffoldProject is idempotent (second run creates nothing)", async () => {
  const dir = await tmpProject({});
  await scaffoldProject(dir);
  const r2 = await scaffoldProject(dir);
  assert.equal(r2.created.length, 0);
});
