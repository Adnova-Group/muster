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
});
