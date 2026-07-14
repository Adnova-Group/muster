import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, symlink, lstat, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runUninstall } from "../src/install.js";

const stylePath = (home) => join(home, ".claude", "output-styles", "muster.md");
const exists = (p) => readFile(p, "utf8").then(() => true, () => false);
// Byte-exact style copied by the retired home installer (commit 8531e70).
const legacyOwnedStyle = `---
name: Muster
description: Glass-box, terse orchestration voice — lead with the outcome, show the crew/decisions/evidence concisely, tick checkboxes, no filler.
---

You are operating in Muster's glass-box voice. Be terse and decision-first; fragments are fine; drop
filler and throat-clearing. The reader is a busy operator who wants the reasoning visible, not buried.

- **Lead with the outcome + success criteria.** State what's being produced and how "done" is judged.
- **Show the glass box.** When you route, say which provider you chose for each role, *why*, on what
  evidence, and what you fell back from — one line each. Never a black box.
- **Tick progress.** Render plans/steps as \`- [ ]\` checkboxes; flip to \`- [x]\` as they complete.
- **Cite, don't assert.** Recommendations trace to evidence/sources. Flag assumptions as assumptions.
- **Surface, don't hide.** Report escalations, degradations, and gate failures plainly. "Done" means
  verified (a command ran), not hoped.
- **No marketing tone, no em-dash padding, no hedging.** Short sentences. Tables/bullets over prose.

This is Claude's TUI voice only; files Muster writes follow their own surface conventions.
`;

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
    await seedLegacyCopy(home, legacyOwnedStyle);

    const result = await runUninstall({ home });
    assert.equal(result.outputStyle.legacyStyle, "removed");
    assert.equal(await exists(stylePath(home)), false, "legacy copy should be gone");
  });

  it("restores the displaced original when a .bak is present (legacyStyle: restored)", async () => {
    const home = await mkdtemp(join(tmpdir(), "muster-uninstall-"));
    const original = "# the user's own style, predating muster\n";
    await seedLegacyCopy(home, legacyOwnedStyle, { bak: original });

    const result = await runUninstall({ home });
    assert.equal(result.outputStyle.legacyStyle, "restored");
    assert.equal(await readFile(stylePath(home), "utf8"), original, "pre-install file restored");
    assert.equal(await exists(`${stylePath(home)}.bak`), false, "the .bak is consumed");
  });

  it("preserves an unowned same-name file and its backup", async () => {
    const home = await mkdtemp(join(tmpdir(), "muster-uninstall-"));
    await seedLegacyCopy(home, "# the user's unrelated same-name style\n", { bak: "backup bytes\n" });

    const result = await runUninstall({ home });
    assert.equal(result.outputStyle.legacyStyle, "unowned");
    assert.equal(await readFile(stylePath(home), "utf8"), "# the user's unrelated same-name style\n");
    assert.equal(await readFile(`${stylePath(home)}.bak`, "utf8"), "backup bytes\n");
  });

  it("rejects a symlinked legacy destination without touching its victim", async (t) => {
    const home = await mkdtemp(join(tmpdir(), "muster-uninstall-"));
    const dir = join(home, ".claude", "output-styles");
    const victim = join(home, "victim.md");
    await mkdir(dir, { recursive: true });
    await writeFile(victim, legacyOwnedStyle);
    try { await symlink(victim, stylePath(home)); }
    catch (error) { t.skip(`symlinks unavailable: ${error.code}`); return; }

    const result = await runUninstall({ home });
    assert.equal(result.outputStyle.legacyStyle, "unsafe");
    assert.equal(await readFile(victim, "utf8"), legacyOwnedStyle);
    assert.equal((await lstat(stylePath(home))).isSymbolicLink(), true);
  });

  it("rejects symlinked output-style ancestry", async (t) => {
    const home = await mkdtemp(join(tmpdir(), "muster-uninstall-"));
    const outside = await mkdtemp(join(tmpdir(), "muster-uninstall-outside-"));
    await mkdir(join(home, ".claude"), { recursive: true });
    await writeFile(join(outside, "muster.md"), legacyOwnedStyle);
    try { await symlink(outside, join(home, ".claude", "output-styles"), "dir"); }
    catch (error) { await rm(outside, { recursive: true, force: true }); t.skip(`directory symlinks unavailable: ${error.code}`); return; }

    const result = await runUninstall({ home });
    assert.equal(result.outputStyle.legacyStyle, "unsafe");
    assert.equal(await readFile(join(outside, "muster.md"), "utf8"), legacyOwnedStyle);
    await rm(outside, { recursive: true, force: true });
  });

  it("rejects a symlinked backup without reading or consuming its victim", async (t) => {
    const home = await mkdtemp(join(tmpdir(), "muster-uninstall-"));
    const victim = join(home, "backup-victim");
    await seedLegacyCopy(home, legacyOwnedStyle);
    await writeFile(victim, Buffer.from([0xff, 0x41]));
    try { await symlink(victim, `${stylePath(home)}.bak`); }
    catch (error) { t.skip(`symlinks unavailable: ${error.code}`); return; }

    const result = await runUninstall({ home });
    assert.equal(result.outputStyle.legacyStyle, "unsafe");
    assert.equal(await readFile(stylePath(home), "utf8"), legacyOwnedStyle);
    assert.deepEqual(await readFile(victim), Buffer.from([0xff, 0x41]));
    assert.equal((await lstat(`${stylePath(home)}.bak`)).isSymbolicLink(), true);
  });

  it("restores arbitrary backup bytes byte-identically and consumes the backup", async () => {
    const home = await mkdtemp(join(tmpdir(), "muster-uninstall-"));
    const original = Buffer.from([0x00, 0xff, 0x80, 0x41, 0x0a]);
    await seedLegacyCopy(home, legacyOwnedStyle, { bak: original });

    const result = await runUninstall({ home });
    assert.equal(result.outputStyle.legacyStyle, "restored");
    assert.deepEqual(await readFile(stylePath(home)), original);
    await assert.rejects(lstat(`${stylePath(home)}.bak`), { code: "ENOENT" });
  });

  it("surfaces the Claude Code removal steps it cannot perform itself", async () => {
    const home = await mkdtemp(join(tmpdir(), "muster-uninstall-"));
    const steps = (await runUninstall({ home })).nextSteps.join("\n");
    assert.match(steps, /\/plugin uninstall muster@muster/, "tells the user to uninstall the plugin");
    assert.match(steps, /\/plugin marketplace remove muster/, "tells the user to remove the marketplace");
    assert.doesNotMatch(steps, /\/output-style/, "must not reference the removed /output-style command");
  });
});
