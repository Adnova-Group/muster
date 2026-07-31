import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rename, rm, writeFile, cp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { syncCodexSkillAssets } from "../scripts/sync-codex-skill-assets.mjs";

const family = { id: "fixture-family", repository: "https://example.invalid/fixture", ref: "abc123" };
const selections = [{ vendorId: "fixture-vendor", familyId: family.id }];
const vendor = {
  sources: [{
    id: "fixture-vendor",
    items: [
      { id: "first-skill", from: "skills/first/SKILL.md" },
      { id: "second-skill", from: "skills/second/SKILL.md" }
    ]
  }]
};

async function fixture(t) {
  const parent = await mkdtemp(join(tmpdir(), "muster-sync-assets-test-"));
  const outputDir = join(parent, "skill-assets");
  await mkdir(outputDir);
  await writeFile(join(outputDir, "tracked.txt"), "original\n");
  t.after(() => rm(parent, { recursive: true, force: true }));
  return { parent, outputDir };
}

function fakeGit({ failFetch = false } = {}) {
  return async (_command, args) => {
    if (args[0] === "init") {
      const clone = args[1];
      await mkdir(join(clone, "skills", "first", "references"), { recursive: true });
      await mkdir(join(clone, "skills", "second", "references"), { recursive: true });
      await writeFile(join(clone, "skills", "first", "references", "one.md"), "first\n");
      await writeFile(join(clone, "skills", "second", "references", "two.md"), "second\n");
    }
    if (args.includes("fetch") && failFetch) throw new Error("mock fetch failure");
    if (args.includes("rev-parse")) return { stdout: `${family.ref}\n`, stderr: "" };
    return { stdout: "", stderr: "" };
  };
}

async function runSync(outputDir, overrides = {}) {
  return syncCodexSkillAssets({
    outputDir,
    upstreams: { families: [family] },
    vendor,
    selections,
    execFile: fakeGit(),
    stdout: { write() {} },
    ...overrides
  });
}

async function assertOriginalIntact(parent, outputDir) {
  assert.equal(await readFile(join(outputDir, "tracked.txt"), "utf8"), "original\n");
  assert.deepEqual((await readdir(parent)).sort(), ["skill-assets"]);
}

test("publishes a complete staged asset tree only after generation succeeds", async t => {
  const { parent, outputDir } = await fixture(t);

  await runSync(outputDir);

  await assert.rejects(readFile(join(outputDir, "tracked.txt"), "utf8"), { code: "ENOENT" });
  assert.match(await readFile(join(outputDir, "first-skill", "references", "one.md"), "utf8"), /prompt-lint-disable/);
  assert.match(await readFile(join(outputDir, "second-skill", "references", "two.md"), "utf8"), /prompt-lint-disable/);
  const manifest = JSON.parse(await readFile(join(outputDir, "manifest.json"), "utf8"));
  assert.deepEqual(manifest.sources, [{ id: family.id, repository: family.repository, ref: family.ref }]);
  assert.deepEqual(manifest.skills.map(skill => skill.id), ["first-skill", "second-skill"]);
  assert.deepEqual((await readdir(parent)).sort(), ["skill-assets"]);
});

test("keeps tracked assets intact when git fails", async t => {
  const { parent, outputDir } = await fixture(t);

  await assert.rejects(runSync(outputDir, { execFile: fakeGit({ failFetch: true }) }), /mock fetch failure/);

  await assertOriginalIntact(parent, outputDir);
});

test("keeps tracked assets intact when copying fails after partial staging", async t => {
  const { parent, outputDir } = await fixture(t);
  let copies = 0;
  const partialCopy = async (...args) => {
    copies += 1;
    if (copies === 2) throw new Error("mock copy failure after partial staging");
    return cp(...args);
  };

  await assert.rejects(runSync(outputDir, { copy: partialCopy }), /mock copy failure after partial staging/);

  assert.equal(copies, 2);
  await assertOriginalIntact(parent, outputDir);
});

test("rolls back tracked assets when the atomic staged publish fails", async t => {
  const { parent, outputDir } = await fixture(t);
  let renames = 0;
  const failedPublish = async (...args) => {
    renames += 1;
    if (renames === 2) {
      const error = new Error("mock staged publish failure");
      error.code = "EIO";
      throw error;
    }
    return rename(...args);
  };

  await assert.rejects(runSync(outputDir, { renamePath: failedPublish }), /mock staged publish failure/);

  assert.equal(renames, 3);
  await assertOriginalIntact(parent, outputDir);
});
