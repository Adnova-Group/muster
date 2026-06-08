import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runUninstall } from "../src/install.js";

const stylePath = (home) => join(home, ".claude", "output-styles", "muster.md");
const exists = (p) => readFile(p, "utf8").then(() => true, () => false);

// Current install mutates nothing under ~/.claude (the style is plugin-shipped),
// so uninstall is mostly the inverse registration steps. It also cleans up a
// LEGACY home-copy that an older muster version may have left behind; we simulate
// that by writing the file directly.
async function seedLegacyCopy(home, content, { bak } = {}) {
  const dir = join(home, ".claude", "output-styles");
  await mkdir(dir, { recursive: true });
  await writeFile(stylePath(home), content, "utf8");
  if (bak !== undefined) await writeFile(`${stylePath(home)}.bak`, bak, "utf8");
}

describe("runUninstall", () => {
  it("is a clean no-op when nothing is installed (legacyStyle: absent)", async () => {
    const home = await mkdtemp(join(tmpdir(), "muster-uninstall-"));
    const result = await runUninstall({ home });
    assert.equal(result.outputStyle.legacyStyle, "absent");
  });

  it("removes a legacy home-copy with no backup (legacyStyle: removed)", async () => {
    const home = await mkdtemp(join(tmpdir(), "muster-uninstall-"));
    await seedLegacyCopy(home, "# legacy muster style copied by an older install\n");

    const result = await runUninstall({ home });
    assert.equal(result.outputStyle.legacyStyle, "removed");
    assert.equal(await exists(stylePath(home)), false, "legacy copy should be gone");
  });

  it("restores the displaced original when a .bak is present (legacyStyle: restored)", async () => {
    const home = await mkdtemp(join(tmpdir(), "muster-uninstall-"));
    const original = "# the user's own style, predating muster\n";
    await seedLegacyCopy(home, "# muster style\n", { bak: original });

    const result = await runUninstall({ home });
    assert.equal(result.outputStyle.legacyStyle, "restored");
    assert.equal(await readFile(stylePath(home), "utf8"), original, "pre-install file restored");
    assert.equal(await exists(`${stylePath(home)}.bak`), false, "the .bak is consumed");
  });

  it("surfaces the Claude Code removal steps it cannot perform itself", async () => {
    const home = await mkdtemp(join(tmpdir(), "muster-uninstall-"));
    const steps = (await runUninstall({ home })).nextSteps.join("\n");
    assert.match(steps, /\/plugin uninstall muster@muster/, "tells the user to uninstall the plugin");
    assert.match(steps, /\/plugin marketplace remove muster/, "tells the user to remove the marketplace");
    assert.doesNotMatch(steps, /\/output-style/, "must not reference the removed /output-style command");
  });
});
