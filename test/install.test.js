import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { runInstall } from "../src/install.js";

const repoRoot = fileURLToPath(new URL("../", import.meta.url));

// The output style ships inside the plugin (force-for-plugin auto-apply), so
// install does NOT copy anything into ~/.claude. These tests pin that contract:
// install mutates nothing under home and only surfaces the registration steps.
describe("runInstall", () => {
  it("reports the style is plugin-shipped and auto-applied", async () => {
    const home = await mkdtemp(join(tmpdir(), "muster-install-"));
    const result = await runInstall({ home, repoRoot });
    assert.equal(result.outputStyle.source, "plugin");
    assert.equal(result.outputStyle.autoApplied, true);
  });

  it("does NOT write anything under ~/.claude (no global mutation)", async () => {
    const home = await mkdtemp(join(tmpdir(), "muster-install-"));
    await runInstall({ home, repoRoot });
    // home was created empty by mkdtemp; install must leave it that way.
    const entries = await readdir(home);
    assert.deepEqual(entries, [], "install must not create files under home");
  });

  it("surfaces the plugin registration steps, and no removed /output-style command", async () => {
    const home = await mkdtemp(join(tmpdir(), "muster-install-"));
    const { nextSteps } = await runInstall({ home, repoRoot });
    const joined = nextSteps.join("\n");
    assert.match(joined, /\/plugin marketplace add/, "must tell the user to add the marketplace");
    assert.match(joined, /\/plugin install muster@muster/, "must tell the user to install the plugin");
    assert.doesNotMatch(joined, /\/output-style/, "must not reference the removed /output-style command");
  });

  it("is idempotent — a second call is identical and still mutates nothing", async () => {
    const home = await mkdtemp(join(tmpdir(), "muster-install-"));
    const a = await runInstall({ home, repoRoot });
    const b = await runInstall({ home, repoRoot });
    assert.deepEqual(b, a);
    assert.deepEqual(await readdir(home), []);
  });

  it("ephemeral npx cache root (/_npx/) → recommends GitHub marketplace slug, not the ephemeral path", async () => {
    const home = await mkdtemp(join(tmpdir(), "muster-install-"));
    const ephemeralRoot = "/home/user/.npm/_npx/abc123def456/node_modules/@adnova-group/muster";
    const { nextSteps } = await runInstall({ home, repoRoot: ephemeralRoot });
    const joined = nextSteps.join("\n");
    // Must recommend the GitHub-hosted marketplace slug
    assert.match(joined, /\/plugin marketplace add Adnova-Group\/muster/, "must recommend the GitHub marketplace slug");
    // Must NOT recommend adding the ephemeral path as the marketplace target
    assert.doesNotMatch(joined, /\/plugin marketplace add \/home/, "must not tell the user to add the ephemeral path");
  });

  it("ephemeral npx cache root (Windows \\_npx\\) → recommends GitHub marketplace slug", async () => {
    const home = await mkdtemp(join(tmpdir(), "muster-install-"));
    const ephemeralRoot = "C:\\Users\\user\\AppData\\Roaming\\npm-cache\\_npx\\abc123\\node_modules\\@adnova-group\\muster";
    const { nextSteps } = await runInstall({ home, repoRoot: ephemeralRoot });
    const joined = nextSteps.join("\n");
    assert.match(joined, /\/plugin marketplace add Adnova-Group\/muster/, "must recommend the GitHub marketplace slug");
    assert.doesNotMatch(joined, /node_modules/, "must not mention the ephemeral node_modules path");
  });

  it("non-ephemeral checkout root → keeps local-path marketplace instruction", async () => {
    const home = await mkdtemp(join(tmpdir(), "muster-install-"));
    const { nextSteps } = await runInstall({ home, repoRoot });
    const joined = nextSteps.join("\n");
    // The real repoRoot is a normal checkout path, not under _npx — must use local path
    assert.match(joined, /\/plugin marketplace add /, "must tell the user to add the marketplace");
    assert.doesNotMatch(joined, /\/plugin marketplace add Adnova-Group\/muster/, "real checkout must use local path, not GitHub slug");
    assert.match(joined, new RegExp(`/plugin marketplace add ${repoRoot.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`), "must include the actual repo path");
  });
});
