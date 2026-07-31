import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpProject } from "../test-support/helpers.js";
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

test("scaffoldProject preserves every existing instruction-file combination", async () => {
  const cases = [
    { name: "none", files: {}, agents: "# Agents\n\nThis repository is managed with muster.\n", claude: "# Claude Code\n\n@AGENTS.md\n" },
    { name: "AGENTS only", files: { "AGENTS.md": "USER AGENTS\n" }, agents: "USER AGENTS\n", claude: "# Claude Code\n\n@AGENTS.md\n" },
    { name: "CLAUDE only", files: { "CLAUDE.md": "USER CLAUDE\n" }, agents: null, claude: "USER CLAUDE\n" },
    { name: "canonical pair", files: { "AGENTS.md": "USER AGENTS\n", "CLAUDE.md": "# Claude Code\n\n@AGENTS.md\n" }, agents: "USER AGENTS\n", claude: "# Claude Code\n\n@AGENTS.md\n" },
    { name: "conflicting pair", files: { "AGENTS.md": "USER AGENTS\n", "CLAUDE.md": "USER CLAUDE\n" }, agents: "USER AGENTS\n", claude: "USER CLAUDE\n" },
  ];

  for (const fixture of cases) {
    const dir = await tmpProject(fixture.files);
    const result = await scaffoldProject(dir);
    if (fixture.agents === null) {
      assert.equal(await exists(join(dir, "AGENTS.md")), false, fixture.name);
      assert.ok(result.skipped.includes("AGENTS.md"), fixture.name);
    } else {
      assert.equal(await readFile(join(dir, "AGENTS.md"), "utf8"), fixture.agents, fixture.name);
    }
    assert.equal(await readFile(join(dir, "CLAUDE.md"), "utf8"), fixture.claude, fixture.name);
  }
});
