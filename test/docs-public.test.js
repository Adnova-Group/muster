import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, access } from "node:fs/promises";

const root = new URL("../", import.meta.url);
const read = (p) => readFile(new URL(p, root), "utf8");
const exists = (p) => access(new URL(p, root)).then(() => true, () => false);

test("public OSS essentials are present", async () => {
  for (const f of ["README.md", "LICENSE", "NOTICE", "CONTRIBUTING.md", "docs/architecture.md"]) {
    assert.equal(await exists(f), true, `${f} must exist for a public repo`);
  }
});

test("README has no dead links to removed internal docs", async () => {
  const readme = await read("README.md");
  for (const dead of ["docs/design/", "docs/plan/", "followups-slice", "pipeline-research"]) {
    assert.ok(!readme.includes(dead), `README must not link removed ${dead}`);
  }
});

test("public prose carries no em-dashes (humanizer rule)", async () => {
  for (const f of ["README.md", "docs/architecture.md", "CONTRIBUTING.md"]) {
    const text = await read(f);
    assert.ok(!text.includes("—"), `${f} must be em-dash free`);
  }
});

test("package.json is npm-publish-ready", async () => {
  const pkg = JSON.parse(await read("package.json"));
  assert.ok(pkg.repository, "repository set");
  assert.ok(Array.isArray(pkg.keywords) && pkg.keywords.length > 0, "keywords set");
  assert.ok(Array.isArray(pkg.files) && pkg.files.length > 0, "files whitelist set");
  assert.ok(pkg.engines?.node, "engines.node set");
  assert.equal(pkg.license, "Apache-2.0");
});
