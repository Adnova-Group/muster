import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readProfile } from "../src/profile.js";

describe("readProfile", () => {
  it("finds muster's own global profile at ~/.claude/muster/profile.md", async () => {
    const home = await mkdtemp(join(tmpdir(), "muster-home-"));
    const cwd = await mkdtemp(join(tmpdir(), "muster-cwd-"));
    const dir = join(home, ".claude", "muster");
    await mkdir(dir, { recursive: true });
    const content = "# Muster user profile\n\nRole: PM\n";
    await writeFile(join(dir, "profile.md"), content, "utf8");
    const result = await readProfile(home, cwd);
    assert.equal(result.found, true);
    assert.equal(result.content, content);
    assert.ok(result.path.endsWith("profile.md"));
  });

  it("project .muster/profile.md overrides the global one", async () => {
    const home = await mkdtemp(join(tmpdir(), "muster-home-"));
    const cwd = await mkdtemp(join(tmpdir(), "muster-cwd-"));
    await mkdir(join(home, ".claude", "muster"), { recursive: true });
    await writeFile(join(home, ".claude", "muster", "profile.md"), "global", "utf8");
    await mkdir(join(cwd, ".muster"), { recursive: true });
    await writeFile(join(cwd, ".muster", "profile.md"), "project", "utf8");
    const result = await readProfile(home, cwd);
    assert.equal(result.content, "project");
  });

  it("returns found:false when no profile exists", async () => {
    const home = await mkdtemp(join(tmpdir(), "muster-home-"));
    const cwd = await mkdtemp(join(tmpdir(), "muster-cwd-"));
    const result = await readProfile(home, cwd);
    assert.equal(result.found, false);
    assert.equal(result.path, null);
    assert.equal(result.content, "");
  });
});
