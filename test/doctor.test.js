import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, cp } from "node:fs/promises";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { runDoctor } from "../src/doctor.js";

const repoRoot = fileURLToPath(new URL("../", import.meta.url));

// Stub `gh` so real-repo integration tests below never depend on live network/gh-auth for
// the vendor-note-staleness check — that check's own network-dependent behaviour (ahead,
// diverged, offline) is exercised directly, with a per-scenario mocked exec, in its own
// describe block further down.
const noNetworkExec = async () => ({ stdout: "ahead\n" });

describe("runDoctor", () => {
  // B-C9: a root with NO catalog/ directory → catalog check ok:false
  it("B-C9: catalog check ok:false when catalog/ directory is absent", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "muster-doctor-nocatalog-"));
    // Intentionally leave tmp empty — no catalog/ dir at all.
    const result = await runDoctor({ root: tmp });
    const check = result.checks.find(c => c.name === "catalog");
    assert.ok(check, "catalog check must exist");
    assert.equal(check.ok, false, "missing catalog/ dir must cause ok:false");
    // detail should contain an error message (ENOENT or similar)
    assert.ok(check.detail && check.detail.length > 0, "detail must be non-empty");
  });

  it("returns ok:true against the real repo root", async () => {
    // Use an empty home dir so the plugin-staleness check doesn't flag a
    // stale real installation and make this structural integration test fail.
    const fakeHome = await mkdtemp(join(tmpdir(), "muster-doctor-clean-"));
    const result = await runDoctor({ root: new URL("../", import.meta.url), home: fakeHome, exec: noNetworkExec });
    assert.equal(result.ok, true, `not ok: ${JSON.stringify(result.checks)}`);
    const names = result.checks.map(c => c.name);
    assert.ok(names.includes("catalog"), "missing catalog check");
    assert.ok(names.includes("pipelines"), "missing pipelines check");
    assert.ok(names.includes("builtins"), "missing builtins check");
    assert.ok(names.includes("node>=20"), "missing node>=20 check");
    assert.ok(names.includes("hooks-integrity"), "missing hooks-integrity check");
    assert.ok(names.includes("vendor-note-staleness"), "missing vendor-note-staleness check");
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
    const result = await runDoctor({ root: repoRoot, home: fakeHome, exec: noNetworkExec });
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

  // B-C10: hook command lacking ${CLAUDE_PLUGIN_ROOT} → extractHookFilename returns null → skip → ok:true
  it("B-C10: hooks-integrity ok:true when hook command has no ${CLAUDE_PLUGIN_ROOT} (intentional skip)", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "muster-doctor-nopluginroot-"));
    await mkdir(join(tmp, "catalog"), { recursive: true });
    await mkdir(join(tmp, "pipelines"), { recursive: true });
    await mkdir(join(tmp, "plugin/builtins/dummy"), { recursive: true });
    await writeFile(join(tmp, "plugin/builtins/dummy/SKILL.md"), "# dummy");
    await mkdir(join(tmp, "plugin/hooks"), { recursive: true });
    // Hook command does NOT contain ${CLAUDE_PLUGIN_ROOT}/hooks/...
    // extractHookFilename returns null → file-existence check is skipped → no problems.
    const hooksWithoutPluginRoot = {
      hooks: {
        SessionStart: [
          { hooks: [{ type: "command", command: "echo hello" }] },
        ],
      },
    };
    await writeFile(join(tmp, "plugin/hooks/hooks.json"), JSON.stringify(hooksWithoutPluginRoot));

    const result = await runDoctor({ root: tmp });
    const check = result.checks.find(c => c.name === "hooks-integrity");
    assert.ok(check, "hooks-integrity check must exist");
    assert.equal(check.ok, true, "hook without CLAUDE_PLUGIN_ROOT must be skipped (ok:true)");
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

// ---------- pipeline/domain alignment ----------

describe("runDoctor domain-alignment check", () => {
  it("passes against the real repo (every pipeline domain is classifier-known)", async () => {
    const fakeHome = await mkdtemp(join(tmpdir(), "muster-doctor-domali-"));
    const result = await runDoctor({ root: repoRoot, home: fakeHome, exec: noNetworkExec });
    const check = result.checks.find(c => c.name === "domain-alignment");
    assert.ok(check, "domain-alignment check must exist");
    assert.equal(check.ok, true, `expected ok:true — detail: ${check.detail}`);
  });

  it("fails when a pipeline's domain is not in the classifier's vocabulary", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "muster-doctor-domali-bad-"));
    await mkdir(join(tmp, "catalog"), { recursive: true });
    await mkdir(join(tmp, "pipelines"), { recursive: true });
    await writeFile(join(tmp, "pipelines/bogus.yaml"), [
      "id: bogus-pipeline",
      "domain: not-a-real-domain",
      "phases:",
      "  - { id: draft, role: author }",
      "gate: { criteria: [clarity], floor: 1, pass_total: 1 }",
      "",
    ].join("\n"));

    const result = await runDoctor({ root: tmp });
    const check = result.checks.find(c => c.name === "domain-alignment");
    assert.ok(check, "domain-alignment check must exist");
    assert.equal(check.ok, false, "unknown pipeline domain must fail the check");
    assert.match(check.detail, /bogus-pipeline/, "detail must name the offending pipeline");
    assert.match(check.detail, /not-a-real-domain/, "detail must name the unknown domain");
  });

  it("skips (ok) when the pipelines/ dir itself fails to load", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "muster-doctor-domali-noload-"));
    // No pipelines/ dir at all -> loadPipelines throws -> domain-alignment has nothing to check.
    const result = await runDoctor({ root: tmp });
    const check = result.checks.find(c => c.name === "domain-alignment");
    assert.ok(check, "domain-alignment check must exist");
    assert.equal(check.ok, true, "missing pipelines/ dir should skip, not fail, domain-alignment");
  });
});

// ---------- skill doc references ----------

describe("runDoctor skill-doc-refs check", () => {
  it("passes against the real repo (every SKILL.md docs/ reference resolves)", async () => {
    const fakeHome = await mkdtemp(join(tmpdir(), "muster-doctor-skilldocs-"));
    const result = await runDoctor({ root: repoRoot, home: fakeHome, exec: noNetworkExec });
    const check = result.checks.find(c => c.name === "skill-doc-refs");
    assert.ok(check, "skill-doc-refs check must exist");
    assert.equal(check.ok, true, `expected ok:true — detail: ${check.detail}`);
  });

  it("fails when a plugin/skills SKILL.md cites a docs/ file that does not exist", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "muster-doctor-skilldocs-missing-"));
    await mkdir(join(tmp, "plugin/skills/example"), { recursive: true });
    await writeFile(
      join(tmp, "plugin/skills/example/SKILL.md"),
      "Read `docs/qa/GHOST.md` before starting.\n"
    );
    const result = await runDoctor({ root: tmp });
    const check = result.checks.find(c => c.name === "skill-doc-refs");
    assert.ok(check, "skill-doc-refs check must exist");
    assert.equal(check.ok, false, "missing referenced doc must fail the check");
    assert.match(check.detail, /docs\/qa\/GHOST\.md/, "detail must name the missing doc path");
  });

  it("passes when the referenced docs/ file exists on disk", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "muster-doctor-skilldocs-ok-"));
    await mkdir(join(tmp, "plugin/skills/example"), { recursive: true });
    await mkdir(join(tmp, "docs/qa"), { recursive: true });
    await writeFile(join(tmp, "docs/qa/RUNBOOK.md"), "# runbook\n");
    await writeFile(
      join(tmp, "plugin/skills/example/SKILL.md"),
      "Read `docs/qa/RUNBOOK.md` before starting.\n"
    );
    const result = await runDoctor({ root: tmp });
    const check = result.checks.find(c => c.name === "skill-doc-refs");
    assert.ok(check, "skill-doc-refs check must exist");
    assert.equal(check.ok, true, `expected ok:true — detail: ${check.detail}`);
  });

  it("ignores a docs/ path immediately preceded by 'default' (an output destination, not a required existing doc)", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "muster-doctor-skilldocs-default-"));
    await mkdir(join(tmp, "plugin/skills/example"), { recursive: true });
    await writeFile(
      join(tmp, "plugin/skills/example/SKILL.md"),
      "Write the roadmap doc — default `docs/roadmap.md`, or a user-named path.\n"
    );
    const result = await runDoctor({ root: tmp });
    const check = result.checks.find(c => c.name === "skill-doc-refs");
    assert.ok(check, "skill-doc-refs check must exist");
    assert.equal(check.ok, true, "a 'default docs/x' output-destination mention must not be required to exist");
  });

  it("ignores docs/ references from a vendored builtin (its docs/ refs point at the upstream repo, not this one)", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "muster-doctor-skilldocs-vendored-"));
    await mkdir(join(tmp, "plugin/builtins/gsd-execute-phase"), { recursive: true });
    await mkdir(join(tmp, "vendor"), { recursive: true });
    await writeFile(
      join(tmp, "plugin/builtins/gsd-execute-phase/SKILL.md"),
      "Reference: `docs/research/some-upstream-doc.md`.\n"
    );
    await writeFile(
      join(tmp, "vendor/manifest.yaml"),
      [
        "sources:",
        "  - id: gsd",
        "    kind: github",
        "    repo: open-gsd/gsd-core",
        "    ref: 0000000000000000000000000000000000000000",
        "    license: MIT",
        "    items:",
        "      - from: gsd-core/workflows/execute-phase.md",
        "        id: gsd-execute-phase",
        "        roles: [implement]",
        "",
      ].join("\n")
    );
    const result = await runDoctor({ root: tmp });
    const check = result.checks.find(c => c.name === "skill-doc-refs");
    assert.ok(check, "skill-doc-refs check must exist");
    assert.equal(check.ok, true, "a vendored builtin's docs/ reference must not be checked against this repo");
  });

  it("reports ok:true with 'absent (created on first use)' when a create-on-first-use convention doc is missing (postfix 'if present' wording)", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "muster-doctor-skilldocs-cofu-postfix-"));
    await mkdir(join(tmp, "plugin/skills/example"), { recursive: true });
    // No docs/ tree at all — matches the npm-packed install, which never ships docs/.
    await writeFile(
      join(tmp, "plugin/skills/example/SKILL.md"),
      "Before testing, read `docs/qa/RUNBOOK.md` if present (check-before-test).\n"
    );
    const result = await runDoctor({ root: tmp });
    const check = result.checks.find(c => c.name === "skill-doc-refs");
    assert.ok(check, "skill-doc-refs check must exist");
    assert.equal(check.ok, true, `expected ok:true — detail: ${check.detail}`);
    assert.match(check.detail, /absent \(created on first use\)/, "detail must say absent (created on first use)");
    assert.match(check.detail, /docs\/qa\/RUNBOOK\.md/, "detail must name the convention-layer doc");
  });

  it("reports ok:true with 'absent (created on first use)' when a create-on-first-use convention doc is missing (conditional-clause wording, no exists/missing keyword)", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "muster-doctor-skilldocs-cofu-clause-"));
    await mkdir(join(tmp, "plugin/builtins/example"), { recursive: true });
    await writeFile(
      join(tmp, "plugin/builtins/example/SKILL.md"),
      "If the artifact resolved a named voice profile from `docs/profiles/VOICE.md` during drafting, check against it.\n"
    );
    const result = await runDoctor({ root: tmp });
    const check = result.checks.find(c => c.name === "skill-doc-refs");
    assert.ok(check, "skill-doc-refs check must exist");
    assert.equal(check.ok, true, `expected ok:true — detail: ${check.detail}`);
    assert.match(check.detail, /absent \(created on first use\)/, "detail must say absent (created on first use)");
  });

  it("simulates the npm-packed install (real plugin/skills + plugin/builtins SKILLs, no docs/ tree at all) and stays ok:true", async () => {
    // This is the actual bug reproduction: `npm pack` never ships docs/ (see package.json
    // "files"), so a packed install's doctor run has plugin/**/SKILL.md referencing
    // docs/qa/RUNBOOK.md and docs/profiles/{VOICE,BRAND}.md with nothing on disk to back them.
    const tmp = await mkdtemp(join(tmpdir(), "muster-doctor-skilldocs-packed-"));
    await mkdir(join(tmp, "plugin"), { recursive: true });
    await cp(join(repoRoot, "plugin/skills"), join(tmp, "plugin/skills"), { recursive: true });
    await cp(join(repoRoot, "plugin/builtins"), join(tmp, "plugin/builtins"), { recursive: true });
    await mkdir(join(tmp, "vendor"), { recursive: true });
    await cp(join(repoRoot, "vendor/manifest.yaml"), join(tmp, "vendor/manifest.yaml"));
    // No docs/ directory at all — the packed-install condition.
    const result = await runDoctor({ root: tmp });
    const check = result.checks.find(c => c.name === "skill-doc-refs");
    assert.ok(check, "skill-doc-refs check must exist");
    assert.equal(check.ok, true, `packed install must stay ok:true — detail: ${check.detail}`);
  });
});

// ---------- plugin staleness ----------

describe("runDoctor plugin-staleness check", () => {
  it("passes against the real repo when no installed_plugins.json exists (dev machine skip)", async () => {
    // Use a temp home with no .claude dir at all.
    const fakeHome = await mkdtemp(join(tmpdir(), "muster-doctor-home-"));
    const result = await runDoctor({ root: repoRoot, home: fakeHome, exec: noNetworkExec });
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
    const result = await runDoctor({ root: repoRoot, home: fakeHome, exec: noNetworkExec });
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
    const result = await runDoctor({ root: repoRoot, home: fakeHome, exec: noNetworkExec });
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
    const result = await runDoctor({ root: repoRoot, home: fakeHome, exec: noNetworkExec });
    const check = result.checks.find(c => c.name === "plugin-staleness");
    assert.ok(check, "plugin-staleness check must exist");
    assert.equal(check.ok, true, `installed == repo (${repoVersion}) → ok`);
  });
});

// ---------- install-integrity ----------

describe("runDoctor install-integrity check", () => {
  it("skips (ok) when installed_plugins.json is absent", async () => {
    const fakeHome = await mkdtemp(join(tmpdir(), "muster-doctor-ii-"));
    const result = await runDoctor({ root: repoRoot, home: fakeHome, exec: noNetworkExec });
    const check = result.checks.find(c => c.name === "install-integrity");
    assert.ok(check, "install-integrity check must exist");
    assert.equal(check.ok, true, `expected ok:true (no install file) — detail: ${check.detail}`);
  });

  it("skips (ok) when muster has no entry in installed_plugins.json", async () => {
    const fakeHome = await mkdtemp(join(tmpdir(), "muster-doctor-ii-"));
    await mkdir(join(fakeHome, ".claude/plugins"), { recursive: true });
    await writeFile(
      join(fakeHome, ".claude/plugins/installed_plugins.json"),
      JSON.stringify({ version: 2, plugins: { "other@official": [{}] } })
    );
    const result = await runDoctor({ root: repoRoot, home: fakeHome, exec: noNetworkExec });
    const check = result.checks.find(c => c.name === "install-integrity");
    assert.ok(check, "install-integrity check must exist");
    assert.equal(check.ok, true, "no muster entry → ok/skip");
  });

  it("fails when installPath directory does not exist", async () => {
    const fakeHome = await mkdtemp(join(tmpdir(), "muster-doctor-ii-nodir-"));
    const missingPath = join(fakeHome, "nonexistent-cache-dir");
    await mkdir(join(fakeHome, ".claude/plugins"), { recursive: true });
    await writeFile(
      join(fakeHome, ".claude/plugins/installed_plugins.json"),
      JSON.stringify({
        version: 2,
        plugins: { "muster@official": [{ version: "0.2.4", installPath: missingPath }] }
      })
    );
    const result = await runDoctor({ root: repoRoot, home: fakeHome, exec: noNetworkExec });
    const check = result.checks.find(c => c.name === "install-integrity");
    assert.ok(check, "install-integrity check must exist");
    assert.equal(check.ok, false, "missing installPath dir → should fail");
    assert.ok(check.detail.includes(missingPath), `detail must name the path; got: ${check.detail}`);
    assert.match(check.detail, /plugin cache is missing/i, "detail must mention 'plugin cache is missing'");
    assert.match(check.detail, /uninstall muster|reinstall|plugin install muster/i, "detail must include remediation");
  });

  it("fails when installPath exists but hooks/hooks.json is absent", async () => {
    const fakeHome = await mkdtemp(join(tmpdir(), "muster-doctor-ii-nohooks-"));
    const installPath = join(fakeHome, "plugin-cache-dir");
    await mkdir(join(installPath), { recursive: true });
    // hooks/ dir exists but hooks.json does not
    await mkdir(join(installPath, "hooks"), { recursive: true });
    await mkdir(join(fakeHome, ".claude/plugins"), { recursive: true });
    await writeFile(
      join(fakeHome, ".claude/plugins/installed_plugins.json"),
      JSON.stringify({
        version: 2,
        plugins: { "muster@official": [{ version: "0.2.4", installPath }] }
      })
    );
    const result = await runDoctor({ root: repoRoot, home: fakeHome, exec: noNetworkExec });
    const check = result.checks.find(c => c.name === "install-integrity");
    assert.ok(check, "install-integrity check must exist");
    assert.equal(check.ok, false, "missing hooks/hooks.json → should fail");
    assert.match(check.detail, /plugin cache is missing/i, "detail must mention 'plugin cache is missing'");
    assert.match(check.detail, /uninstall muster|reinstall|plugin install muster/i, "detail must include remediation");
  });

  it("passes when installPath exists with hooks/hooks.json present", async () => {
    const fakeHome = await mkdtemp(join(tmpdir(), "muster-doctor-ii-ok-"));
    const installPath = join(fakeHome, "plugin-cache-dir");
    await mkdir(join(installPath, "hooks"), { recursive: true });
    await writeFile(join(installPath, "hooks/hooks.json"), JSON.stringify({ hooks: {} }));
    await mkdir(join(fakeHome, ".claude/plugins"), { recursive: true });
    await writeFile(
      join(fakeHome, ".claude/plugins/installed_plugins.json"),
      JSON.stringify({
        version: 2,
        plugins: { "muster@official": [{ version: "0.2.4", installPath }] }
      })
    );
    const result = await runDoctor({ root: repoRoot, home: fakeHome, exec: noNetworkExec });
    const check = result.checks.find(c => c.name === "install-integrity");
    assert.ok(check, "install-integrity check must exist");
    assert.equal(check.ok, true, `installPath and hooks/hooks.json present → should pass; detail: ${check.detail}`);
  });
});

// ---------- version-parity ----------

// ---------- vendor-note-staleness ----------

describe("runDoctor vendor-note-staleness check", () => {
  it("ok:true (skip) when vendor/manifest.yaml is absent", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "muster-doctor-vns-nomanifest-"));
    const result = await runDoctor({ root: tmp });
    const check = result.checks.find(c => c.name === "vendor-note-staleness");
    assert.ok(check, "vendor-note-staleness check must exist");
    assert.equal(check.ok, true, `expected ok:true — detail: ${check.detail}`);
    assert.match(check.detail, /no vendor\/manifest\.yaml/);
  });

  it("does not hit the network when the only referenced sha is a prefix of the pinned ref itself", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "muster-doctor-vns-trivial-"));
    await mkdir(join(tmp, "vendor"), { recursive: true });
    await writeFile(join(tmp, "vendor/manifest.yaml"), [
      "sources:",
      "  - id: acme",
      "    kind: github",
      "    repo: acme/tool",
      "    # historical: this already rolled up to commit abc1234, no divergence",
      "    ref: abc1234567890abc1234567890abc1234567890",
      "    license: MIT",
      "    items:",
      "      - from: skills/example/SKILL.md",
      "        id: acme-example",
      "        roles: [implement]",
      "",
    ].join("\n"));
    const exec = async () => { throw new Error("must not be called — trivial prefix match needs no network"); };
    const result = await runDoctor({ root: tmp, exec });
    const check = result.checks.find(c => c.name === "vendor-note-staleness");
    assert.ok(check, "vendor-note-staleness check must exist");
    assert.equal(check.ok, true, `expected ok:true — detail: ${check.detail}`);
    assert.match(check.detail, /no commit-sha notes found/);
  });

  it("fails when a note-sha's compare status is not ahead/identical (stale/diverged note)", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "muster-doctor-vns-stale-"));
    await mkdir(join(tmp, "vendor"), { recursive: true });
    await writeFile(join(tmp, "vendor/manifest.yaml"), [
      "sources:",
      "  - id: acme",
      "    kind: github",
      "    repo: acme/tool",
      "    # rolled mechanism note referencing commit deadbeef1",
      "    ref: 0123456789abcdef0123456789abcdef01234567",
      "    license: MIT",
      "    items:",
      "      - from: skills/example/SKILL.md",
      "        id: acme-example",
      "        roles: [implement]",
      "",
    ].join("\n"));
    const exec = async (cmd, args) => {
      assert.equal(cmd, "gh");
      assert.match(args.join(" "), /compare\/deadbeef1\.\.\.0123456789abcdef0123456789abcdef01234567/);
      return { stdout: "diverged\n" };
    };
    const result = await runDoctor({ root: tmp, exec });
    const check = result.checks.find(c => c.name === "vendor-note-staleness");
    assert.ok(check, "vendor-note-staleness check must exist");
    assert.equal(check.ok, false, "diverged note-sha must fail the check");
    assert.match(check.detail, /deadbeef1/);
    assert.match(check.detail, /acme/);
  });

  it("passes when the note-sha's compare status is ahead of the pinned ref", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "muster-doctor-vns-ok-"));
    await mkdir(join(tmp, "vendor"), { recursive: true });
    await writeFile(join(tmp, "vendor/manifest.yaml"), [
      "sources:",
      "  - id: acme",
      "    kind: github",
      "    repo: acme/tool",
      "    # rolled mechanism note referencing commit deadbeef1",
      "    ref: 0123456789abcdef0123456789abcdef01234567",
      "    license: MIT",
      "    items:",
      "      - from: skills/example/SKILL.md",
      "        id: acme-example",
      "        roles: [implement]",
      "",
    ].join("\n"));
    const exec = async () => ({ stdout: "ahead\n" });
    const result = await runDoctor({ root: tmp, exec });
    const check = result.checks.find(c => c.name === "vendor-note-staleness");
    assert.ok(check, "vendor-note-staleness check must exist");
    assert.equal(check.ok, true, `expected ok:true — detail: ${check.detail}`);
  });

  it("reports skipped (offline) rather than failing when gh/network is unavailable", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "muster-doctor-vns-offline-"));
    await mkdir(join(tmp, "vendor"), { recursive: true });
    await writeFile(join(tmp, "vendor/manifest.yaml"), [
      "sources:",
      "  - id: acme",
      "    kind: github",
      "    repo: acme/tool",
      "    # rolled mechanism note referencing commit deadbeef1",
      "    ref: 0123456789abcdef0123456789abcdef01234567",
      "    license: MIT",
      "    items:",
      "      - from: skills/example/SKILL.md",
      "        id: acme-example",
      "        roles: [implement]",
      "",
    ].join("\n"));
    const exec = async () => { throw new Error("spawn gh ENOENT"); };
    const result = await runDoctor({ root: tmp, exec });
    const check = result.checks.find(c => c.name === "vendor-note-staleness");
    assert.ok(check, "vendor-note-staleness check must exist");
    assert.equal(check.ok, true, "offline must be reported as ok:true (skip), not a failure");
    assert.match(check.detail, /offline/i);
  });

  it("extracts real vendor/manifest.yaml notes and passes when gh reports every note-sha ahead of its pin", async () => {
    const exec = async () => ({ stdout: "ahead\n" });
    const result = await runDoctor({ root: repoRoot, exec });
    const check = result.checks.find(c => c.name === "vendor-note-staleness");
    assert.ok(check, "vendor-note-staleness check must exist");
    assert.equal(check.ok, true, `expected ok:true — detail: ${check.detail}`);
    // Sanity: the real manifest does carry commit-sha rolled-mechanism notes, so this
    // must not silently short-circuit to the "no commit-sha notes found" empty case.
    assert.doesNotMatch(check.detail, /no commit-sha notes found/);
  });
});

describe("runDoctor version-parity check", () => {
  it("passes against the real repo (package.json and plugin.json versions match)", async () => {
    const fakeHome = await mkdtemp(join(tmpdir(), "muster-doctor-vp-"));
    const result = await runDoctor({ root: repoRoot, home: fakeHome, exec: noNetworkExec });
    const check = result.checks.find(c => c.name === "version-parity");
    assert.ok(check, "version-parity check must exist");
    assert.equal(check.ok, true, `expected ok:true — detail: ${check.detail}`);
  });

  // B-C11: installed version NEWER than repo → ok:true (is current; semverCompare > 0 → else branch)
  it("B-C11: ok:true when installed version is newer than repo version", async () => {
    const { readJson } = await import("../src/fs-util.js");
    const manifest = await readJson(join(repoRoot, "plugin/.claude-plugin/plugin.json"));
    const repoVersion = manifest.version;
    // Build a version one major bump ahead of the repo version so it is definitely newer.
    const [maj, min, pat] = repoVersion.split(".").map(Number);
    const newerVersion = `${maj + 1}.${min}.${pat}`;

    const fakeHome = await mkdtemp(join(tmpdir(), "muster-doctor-newer-"));
    await mkdir(join(fakeHome, ".claude/plugins"), { recursive: true });
    await writeFile(
      join(fakeHome, ".claude/plugins/installed_plugins.json"),
      JSON.stringify({ version: 2, plugins: { "muster@official": [{ version: newerVersion }] } }),
    );
    const result = await runDoctor({ root: repoRoot, home: fakeHome, exec: noNetworkExec });
    const check = result.checks.find(c => c.name === "plugin-staleness");
    assert.ok(check, "plugin-staleness check must exist");
    assert.equal(check.ok, true, `installed ${newerVersion} > repo ${repoVersion} → ok:true (current)`);
    assert.match(check.detail, /is current/, "detail must say 'is current'");
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
