import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, cp } from "node:fs/promises";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { runDoctor } from "../src/doctor.js";

const repoRoot = fileURLToPath(new URL("../", import.meta.url));

describe("runDoctor", () => {
  it("returns ok:true against the real repo root", async () => {
    // Use an empty home dir so the plugin-staleness check doesn't flag a
    // stale real installation and make this structural integration test fail.
    const fakeHome = await mkdtemp(join(tmpdir(), "muster-doctor-clean-"));
    const result = await runDoctor({ root: new URL("../", import.meta.url), home: fakeHome });
    assert.equal(result.ok, true, `not ok: ${JSON.stringify(result.checks)}`);
    const names = result.checks.map(c => c.name);
    assert.ok(names.includes("catalog"), "missing catalog check");
    assert.ok(names.includes("pipelines"), "missing pipelines check");
    assert.ok(names.includes("builtins"), "missing builtins check");
    assert.ok(names.includes("node>=20"), "missing node>=20 check");
    assert.ok(names.includes("hooks-integrity"), "missing hooks-integrity check");
    assert.ok(names.includes("plugin-staleness"), "missing plugin-staleness check");
    assert.ok(names.includes("version-parity"), "missing version-parity check");
    const catalogCheck = result.checks.find(c => c.name === "catalog");
    assert.ok(catalogCheck.detail.includes("entries"), `catalog detail should mention entries: ${catalogCheck.detail}`);
  });
});

// ---------- hooks integrity ----------

describe("runDoctor hooks-integrity check", () => {
  it("passes against the real repo (hooks.json is valid)", async () => {
    const fakeHome = await mkdtemp(join(tmpdir(), "muster-doctor-hooksi-"));
    const result = await runDoctor({ root: repoRoot, home: fakeHome });
    const check = result.checks.find(c => c.name === "hooks-integrity");
    assert.ok(check, "hooks-integrity check must exist");
    assert.equal(check.ok, true, `expected ok:true — detail: ${check.detail}`);
  });

  it("fails when hooks.json contains an unknown event name", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "muster-doctor-hooks-"));
    // minimal valid repo structure
    await mkdir(join(tmp, "catalog"), { recursive: true });
    await mkdir(join(tmp, "pipelines"), { recursive: true });
    await mkdir(join(tmp, "plugin/builtins/dummy"), { recursive: true });
    await writeFile(join(tmp, "plugin/builtins/dummy/SKILL.md"), "# dummy");
    // hooks dir with a bad event name
    await mkdir(join(tmp, "plugin/hooks"), { recursive: true });
    await writeFile(join(tmp, "plugin/hooks/my-hook.js"), "// hook");
    const badHooks = {
      hooks: {
        NotARealEvent: [
          { hooks: [{ type: "command", command: "node \"${CLAUDE_PLUGIN_ROOT}/hooks/my-hook.js\"" }] }
        ]
      }
    };
    await writeFile(join(tmp, "plugin/hooks/hooks.json"), JSON.stringify(badHooks));

    const result = await runDoctor({ root: tmp });
    const check = result.checks.find(c => c.name === "hooks-integrity");
    assert.ok(check, "hooks-integrity check must exist");
    assert.equal(check.ok, false, "should fail on unknown event name");
    assert.match(check.detail, /NotARealEvent/, "detail must name the bad event");
  });

  it("fails when a hook command references a .js file that does not exist", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "muster-doctor-hooks-missing-"));
    await mkdir(join(tmp, "catalog"), { recursive: true });
    await mkdir(join(tmp, "pipelines"), { recursive: true });
    await mkdir(join(tmp, "plugin/builtins/dummy"), { recursive: true });
    await writeFile(join(tmp, "plugin/builtins/dummy/SKILL.md"), "# dummy");
    await mkdir(join(tmp, "plugin/hooks"), { recursive: true });
    // hooks.json references a file that does NOT exist
    const hooksWithMissing = {
      hooks: {
        SessionStart: [
          { hooks: [{ type: "command", command: "node \"${CLAUDE_PLUGIN_ROOT}/hooks/ghost.js\"" }] }
        ]
      }
    };
    await writeFile(join(tmp, "plugin/hooks/hooks.json"), JSON.stringify(hooksWithMissing));

    const result = await runDoctor({ root: tmp });
    const check = result.checks.find(c => c.name === "hooks-integrity");
    assert.ok(check, "hooks-integrity check must exist");
    assert.equal(check.ok, false, "should fail on missing hook script");
    assert.match(check.detail, /ghost\.js/, "detail must mention the missing file");
  });
});

// ---------- plugin staleness ----------

describe("runDoctor plugin-staleness check", () => {
  it("passes against the real repo when no installed_plugins.json exists (dev machine skip)", async () => {
    // Use a temp home with no .claude dir at all.
    const fakeHome = await mkdtemp(join(tmpdir(), "muster-doctor-home-"));
    const result = await runDoctor({ root: repoRoot, home: fakeHome });
    const check = result.checks.find(c => c.name === "plugin-staleness");
    assert.ok(check, "plugin-staleness check must exist");
    assert.equal(check.ok, true, `expected ok:true (no install) — detail: ${check.detail}`);
  });

  it("passes when muster entry is absent from installed_plugins.json", async () => {
    const fakeHome = await mkdtemp(join(tmpdir(), "muster-doctor-home-"));
    await mkdir(join(fakeHome, ".claude/plugins"), { recursive: true });
    await writeFile(
      join(fakeHome, ".claude/plugins/installed_plugins.json"),
      JSON.stringify({ version: 2, plugins: { "other@official": [{}] } })
    );
    const result = await runDoctor({ root: repoRoot, home: fakeHome });
    const check = result.checks.find(c => c.name === "plugin-staleness");
    assert.ok(check, "plugin-staleness check must exist");
    assert.equal(check.ok, true, "no muster entry → ok/skip");
  });

  it("flags staleness when installed version is older than repo version", async () => {
    const fakeHome = await mkdtemp(join(tmpdir(), "muster-doctor-stale-"));
    await mkdir(join(fakeHome, ".claude/plugins"), { recursive: true });
    // installed at 0.2.0; repo ships 0.2.3+
    await writeFile(
      join(fakeHome, ".claude/plugins/installed_plugins.json"),
      JSON.stringify({ version: 2, plugins: { "muster@official": [{ version: "0.2.0" }] } })
    );
    const result = await runDoctor({ root: repoRoot, home: fakeHome });
    const check = result.checks.find(c => c.name === "plugin-staleness");
    assert.ok(check, "plugin-staleness check must exist");
    assert.equal(check.ok, false, "installed 0.2.0 < repo → should be flagged");
    assert.match(check.detail, /0\.2\.0/, "detail must mention installed version");
    assert.match(check.detail, /plugin marketplace update|plugin update muster/i, "detail must include remediation");
  });

  it("passes when installed version matches repo version", async () => {
    // Read the current repo version dynamically so the test stays valid
    // even after a version bump.
    const { readJson } = await import("../src/fs-util.js");
    const manifest = await readJson(join(repoRoot, "plugin/.claude-plugin/plugin.json"));
    const repoVersion = manifest.version;

    const fakeHome = await mkdtemp(join(tmpdir(), "muster-doctor-current-"));
    await mkdir(join(fakeHome, ".claude/plugins"), { recursive: true });
    await writeFile(
      join(fakeHome, ".claude/plugins/installed_plugins.json"),
      JSON.stringify({ version: 2, plugins: { "muster@official": [{ version: repoVersion }] } })
    );
    const result = await runDoctor({ root: repoRoot, home: fakeHome });
    const check = result.checks.find(c => c.name === "plugin-staleness");
    assert.ok(check, "plugin-staleness check must exist");
    assert.equal(check.ok, true, `installed == repo (${repoVersion}) → ok`);
  });
});

// ---------- version-parity ----------

describe("runDoctor version-parity check", () => {
  it("passes against the real repo (package.json and plugin.json versions match)", async () => {
    const fakeHome = await mkdtemp(join(tmpdir(), "muster-doctor-vp-"));
    const result = await runDoctor({ root: repoRoot, home: fakeHome });
    const check = result.checks.find(c => c.name === "version-parity");
    assert.ok(check, "version-parity check must exist");
    assert.equal(check.ok, true, `expected ok:true — detail: ${check.detail}`);
  });

  it("fails and reports both versions when package.json and plugin.json versions differ", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "muster-doctor-vp-mismatch-"));
    // Set up minimal repo structure by copying real files and patching versions
    await mkdir(join(tmp, "catalog"), { recursive: true });
    await mkdir(join(tmp, "pipelines"), { recursive: true });
    await mkdir(join(tmp, "plugin/builtins/dummy"), { recursive: true });
    await writeFile(join(tmp, "plugin/builtins/dummy/SKILL.md"), "# dummy");
    await mkdir(join(tmp, "plugin/hooks"), { recursive: true });
    // Copy valid hooks.json from real repo so other checks pass
    const { readJson } = await import("../src/fs-util.js");
    const realHooks = await readJson(join(repoRoot, "plugin/hooks/hooks.json"));
    await writeFile(join(tmp, "plugin/hooks/hooks.json"), JSON.stringify(realHooks));
    // Copy hook scripts referenced by hooks.json
    const hooksDir = join(repoRoot, "plugin/hooks");
    await cp(hooksDir, join(tmp, "plugin/hooks"), { recursive: true });
    // Write a package.json with version 1.0.0
    await writeFile(join(tmp, "package.json"), JSON.stringify({ version: "1.0.0" }));
    // Write plugin.json with a different version 2.0.0
    await mkdir(join(tmp, "plugin/.claude-plugin"), { recursive: true });
    await writeFile(join(tmp, "plugin/.claude-plugin/plugin.json"), JSON.stringify({ version: "2.0.0" }));

    const fakeHome = await mkdtemp(join(tmpdir(), "muster-doctor-vp-home-"));
    const result = await runDoctor({ root: tmp, home: fakeHome });
    const check = result.checks.find(c => c.name === "version-parity");
    assert.ok(check, "version-parity check must exist");
    assert.equal(check.ok, false, "mismatched versions must fail");
    assert.match(check.detail, /1\.0\.0/, "detail must include package.json version");
    assert.match(check.detail, /2\.0\.0/, "detail must include plugin.json version");
  });
});
