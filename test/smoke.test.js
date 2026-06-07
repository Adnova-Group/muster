import { test } from "node:test";
import assert from "node:assert/strict";
import { tmpProject } from "./helpers.js";

test("tmpProject writes files", async () => {
  const dir = await tmpProject({ "package.json": { name: "x" } });
  assert.ok(dir.includes("muster-test-"));
});
