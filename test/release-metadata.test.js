import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const root = new URL("../", import.meta.url);
const read = relative => readFile(new URL(relative, root), "utf8");
const json = async relative => JSON.parse(await read(relative));

test("0.6.0 release metadata is synchronized across published manifests", async () => {
  const expectedVersion = "0.6.0";
  const manifests = [
    "package.json",
    "package-lock.json",
    "plugin.json",
    "plugin/.claude-plugin/plugin.json",
    "cowork/manifest.json",
  ];

  for (const manifestPath of manifests) {
    const manifest = await json(manifestPath);
    assert.equal(manifest.version, expectedVersion, `${manifestPath} must carry the release version`);
  }

  const lock = await json("package-lock.json");
  assert.equal(lock.packages[""].version, expectedVersion, "package-lock root package must carry the release version");
});

test("0.6.0 changelog metadata closes the release and opens a fresh Unreleased section", async () => {
  const changelog = await read("CHANGELOG.md");
  assert.match(changelog, /^## \[Unreleased\]\n\n## \[0\.6\.0\] - 2026-07-31$/m);
  assert.match(
    changelog,
    /^\[Unreleased\]: https:\/\/github\.com\/Adnova-Group\/muster\/compare\/v0\.6\.0\.\.\.HEAD$/m
  );
  assert.match(
    changelog,
    /^\[0\.6\.0\]: https:\/\/github\.com\/Adnova-Group\/muster\/compare\/v0\.5\.0\.\.\.v0\.6\.0$/m
  );
});
