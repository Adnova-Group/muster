import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readProfile } from "../src/profile.js";

describe("readProfile", () => {
  it("finds profile at .claude/.atomic/profile.md", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "muster-profile-"));
    const profileDir = join(tmp, ".claude", ".atomic");
    await mkdir(profileDir, { recursive: true });
    const content = "# User profile\n\n## Identity\nName: Test User\n";
    await writeFile(join(profileDir, "profile.md"), content, "utf8");
    const result = await readProfile(tmp);
    assert.equal(result.found, true, "should find profile");
    assert.equal(result.content, content, "content should match");
    assert.ok(result.path.endsWith("profile.md"), `unexpected path: ${result.path}`);
  });

  it("returns found:false for empty tmp dir with no profile", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "muster-profile-empty-"));
    const result = await readProfile(tmp);
    assert.equal(result.found, false, "should not find profile");
    assert.equal(result.path, null);
    assert.equal(result.content, "");
  });
});
