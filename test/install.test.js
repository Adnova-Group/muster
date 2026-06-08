import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { runInstall } from "../src/install.js";

const repoRoot = fileURLToPath(new URL("../", import.meta.url));
const sourceStyle = join(repoRoot, "output-styles", "muster.md");

describe("runInstall", () => {
  it("fresh install copies the style file (action: copied)", async () => {
    const home = await mkdtemp(join(tmpdir(), "muster-install-"));
    const result = await runInstall({ home, repoRoot });
    assert.equal(result.style.action, "copied");
    const dest = join(home, ".claude", "output-styles", "muster.md");
    assert.equal(result.style.dest, dest);
    const expected = await readFile(sourceStyle, "utf8");
    assert.equal(await readFile(dest, "utf8"), expected);
  });

  it("is idempotent — second call skips, no .bak created", async () => {
    const home = await mkdtemp(join(tmpdir(), "muster-install-"));
    await runInstall({ home, repoRoot });
    const result = await runInstall({ home, repoRoot });
    assert.equal(result.style.action, "skipped");
    const bak = join(home, ".claude", "output-styles", "muster.md.bak");
    await assert.rejects(() => readFile(bak, "utf8"));
  });

  it("differing dest is backed up and updated (action: updated)", async () => {
    const home = await mkdtemp(join(tmpdir(), "muster-install-"));
    const dir = join(home, ".claude", "output-styles");
    await mkdir(dir, { recursive: true });
    const dest = join(dir, "muster.md");
    const oldContent = "# stale custom style\n";
    await writeFile(dest, oldContent, "utf8");

    const result = await runInstall({ home, repoRoot });
    assert.equal(result.style.action, "updated");

    const bak = join(dir, "muster.md.bak");
    assert.equal(await readFile(bak, "utf8"), oldContent);

    const expected = await readFile(sourceStyle, "utf8");
    assert.equal(await readFile(dest, "utf8"), expected);
  });
});
