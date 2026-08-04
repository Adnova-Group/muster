// runKimiInstall / runKimiUninstall / probeKimiModels: the write side of the
// Kimi harness leg. Hermetic fixtures only -- a temp repoRoot supplies a plugin/
// tree, a temp home is the kimi data root; the probe uses an injected fetch and
// a temp credentials file. No real ~/.kimi-code and no live network are touched.
import { test } from "node:test";
import assert from "node:assert/strict";
import { closeSync, ftruncateSync, mkdtempSync, mkdirSync, openSync, writeFileSync, rmSync, existsSync, linkSync, readFileSync, readdirSync, renameSync, statSync, symlinkSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { runKimiInstall, runKimiUninstall, probeKimiModels, stampModelPreference, stampSkillName, KIMI_MANIFEST, KIMI_EXPECTED_MODEL_IDS, KIMI_PERMISSION_RULES, KIMI_RULES_MARKER_BEGIN, KIMI_RULES_MARKER_END, renderPermissionRulesBlock, mergePermissionRules, stripPermissionRules } from "../src/kimi-install.js";
import { readInstalledKimi } from "../src/harness.js";
import { KIMI_LANES, kimiLaneEnv, kimiModelPreferenceForTier, kimiPreferenceForAgentId } from "../src/kimi.js";
import { loadCatalog } from "../src/catalog.js";
import { resolveCapabilities } from "../src/capabilities.js";
import { matchFrontmatter } from "../src/frontmatter.js";
import { withCodexFileLock } from "../src/codex-lock.js";

function tmp() { return mkdtempSync(join(tmpdir(), "muster-kimi-install-")); }
function write(p, s) { mkdirSync(join(p, ".."), { recursive: true }); writeFileSync(p, s); }
function frontmatterName(path) {
  const text = readFileSync(path, "utf8");
  return matchFrontmatter(text)?.body.match(/^name[ \t]*:[ \t]*(.+)$/m)?.[1]?.trim();
}

// A minimal plugin/ tree: 2 agents + 2 skills (one with a sibling asset).
function fixtureRepo() {
  const repo = tmp();
  write(join(repo, "package.json"), JSON.stringify({ version: "9.9.9" }));
  write(join(repo, "plugin", "agents", "muster-builder.md"), "---\nname: muster-builder\nmodel: opus\n---\nbody");
  write(join(repo, "plugin", "agents", "muster-investigator.md"), "---\nname: muster-investigator\nmodel: haiku\n---\nbody");
  write(join(repo, "plugin", "skills", "orchestrator", "SKILL.md"), "---\nname: orchestrator\n---\nbody");
  write(join(repo, "plugin", "skills", "review-gate", "SKILL.md"), "---\nname: review-gate\n---\nbody");
  write(join(repo, "plugin", "skills", "review-gate", "verdict.schema.json"), "{}");
  // a non-skill dir (no SKILL.md) must be ignored
  write(join(repo, "plugin", "skills", "not-a-skill", "README.md"), "x");
  return repo;
}

test("runKimiInstall: writes agents + skills into the kimi root with an ownership manifest", async () => {
  const repo = fixtureRepo(), home = tmp();
  try {
    const r = await runKimiInstall({ home, repoRoot: repo });
    assert.equal(r.dest, join(home, ".kimi-code"));
    assert.equal(r.packageVersion, "9.9.9");
    assert.deepEqual(r.agents.sort(), ["muster-builder.md", "muster-investigator.md"]);
    assert.deepEqual(r.skills.sort(), ["orchestrator", "review-gate"]);

    const root = join(home, ".kimi-code");
    assert.ok(existsSync(join(root, "agents", "muster-builder.md")));
    assert.ok(existsSync(join(root, "skills", "orchestrator", "SKILL.md")));
    assert.ok(existsSync(join(root, "skills", "review-gate", "verdict.schema.json")));
    // the non-skill dir was skipped
    assert.ok(!existsSync(join(root, "skills", "not-a-skill")));

    // the inert Claude-Code `model:` field is left alone (Kimi ignores it), and
    // the field Kimi DOES honour is stamped in from the manifest tier.
    const builder = readFileSync(join(root, "agents", "muster-builder.md"), "utf8");
    assert.match(builder, /model: opus/);
    assert.match(builder, /^model_preference: primary$/m);
    assert.match(builder, /^body$/m); // body preserved

    const manifest = JSON.parse(readFileSync(join(root, "muster", KIMI_MANIFEST), "utf8"));
    assert.equal(manifest.owner, "muster");
    assert.equal(manifest.format, 1);
    assert.ok(manifest.agents.includes("agents/muster-builder.md"));
    assert.ok(manifest.skills.includes("skills/review-gate/verdict.schema.json"));
  } finally { rmSync(repo, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true }); }
});

test("runKimiInstall: fails loud when the source package version is missing", async () => {
  const repo = fixtureRepo(), home = tmp();
  try {
    writeFileSync(join(repo, "package.json"), JSON.stringify({ name: "fixture" }));
    await assert.rejects(
      runKimiInstall({ home, repoRoot: repo, dryRun: true }),
      /missing a coherent package version/
    );
  } finally { rmSync(repo, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true }); }
});

test("runKimiInstall: the installed root reads back through readInstalledKimi", async () => {
  const repo = fixtureRepo(), home = tmp();
  try {
    await runKimiInstall({ home, repoRoot: repo });
    const inv = await readInstalledKimi(home, { dir: join(home, ".kimi-code") });
    assert.deepEqual(inv.agents.sort(), ["muster-builder", "muster-investigator"]);
    assert.deepEqual(inv.skills.sort(), ["orchestrator", "review-gate"]);
  } finally { rmSync(repo, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true }); }
});

test("runKimiInstall: every builtin provider resolved by capabilities --kimi is dispatchable", async () => {
  const repo = fileURLToPath(new URL("../", import.meta.url)), home = tmp();
  try {
    const catalog = await loadCatalog(join(repo, "catalog"));
    const empty = { runtime: "kimi", agents: [], skills: [], plugins: [], mcpServers: [] };
    const caps = resolveCapabilities(catalog, empty, home, { kimi: true });

    await runKimiInstall({ home, repoRoot: repo });
    const installed = await readInstalledKimi(home, { dir: join(home, ".kimi-code") });
    const installedAgents = new Set(installed.agents);
    const installedSkills = new Set(installed.skills);
    const unreachable = [];

    for (const [role, { chosen }] of Object.entries(caps.roles)) {
      if (chosen.source !== "builtin") continue;
      if (chosen.kind === "agent") {
        if (!installedAgents.has(chosen.id)) {
          unreachable.push(`${role}:agent:${chosen.id}`);
        } else {
          const name = frontmatterName(join(home, ".kimi-code", "agents", `${chosen.id}.md`));
          if (name !== chosen.id) unreachable.push(`${role}:agent-name:${chosen.id}:${name || "<missing>"}`);
        }
      }
      if (chosen.kind === "skill" && !installedSkills.has(chosen.id)) unreachable.push(`${role}:skill:${chosen.id}`);
    }
    for (const skill of caps.skills) {
      if (skill.source !== "builtin") continue;
      if (!installedSkills.has(skill.id)) {
        unreachable.push(`skill:${skill.id}`);
        continue;
      }
      const name = frontmatterName(join(home, ".kimi-code", "skills", skill.id, "SKILL.md"));
      if (name !== skill.id) unreachable.push(`skill-name:${skill.id}:${name || "<missing>"}`);
    }

    assert.deepEqual(unreachable, []);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("runKimiInstall: reinstall is idempotent and prunes stale owned files", async () => {
  const repo = fixtureRepo(), home = tmp();
  try {
    await runKimiInstall({ home, repoRoot: repo });
    // drop an agent from the source, then reinstall
    rmSync(join(repo, "plugin", "agents", "muster-investigator.md"));
    const r = await runKimiInstall({ home, repoRoot: repo });
    assert.deepEqual(r.removedStale, ["agents/muster-investigator.md"]);
    const root = join(home, ".kimi-code");
    assert.ok(!existsSync(join(root, "agents", "muster-investigator.md")));
    assert.ok(existsSync(join(root, "agents", "muster-builder.md")));
  } finally { rmSync(repo, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true }); }
});

test("runKimiInstall: nested skill-asset subdirectories (references/) are walked, manifested, and stale-pruned", async () => {
  // walkFiles's isDirectory() recursion branch: every OTHER fixture asset is a
  // flat file, but the orchestrator's progressive-disclosure split ships
  // skills/orchestrator/references/*.md -- a nested subdirectory the install
  // copy, the ownership manifest, and the stale-prune path must all reach.
  const repo = tmp(), home = tmp();
  try {
    write(join(repo, "package.json"), JSON.stringify({ version: "9.9.9" }));
    write(join(repo, "plugin", "agents", "muster-builder.md"), "---\nname: muster-builder\nmodel: opus\n---\nbody");
    write(join(repo, "plugin", "skills", "orchestrator", "SKILL.md"), "---\nname: orchestrator\n---\nbody");
    write(join(repo, "plugin", "skills", "orchestrator", "references", "codex-dispatch.md"), "# codex dispatch\n");

    const r = await runKimiInstall({ home, repoRoot: repo });
    const root = join(home, ".kimi-code");
    // the nested file is copied, recreating its subdirectory
    assert.equal(readFileSync(join(root, "skills", "orchestrator", "references", "codex-dispatch.md"), "utf8"), "# codex dispatch\n");
    // ...and recorded in the ownership manifest with a POSIX-joined nested rel
    const manifest = JSON.parse(readFileSync(join(root, "muster", KIMI_MANIFEST), "utf8"));
    assert.ok(manifest.skills.includes("skills/orchestrator/references/codex-dispatch.md"));
    assert.equal(r.fileCount, 3); // 1 agent + SKILL.md + the nested reference

    // drop the nested file from the source, reinstall, and the stale-prune
    // path removes exactly it (the now-empty references/ dir goes with it)
    rmSync(join(repo, "plugin", "skills", "orchestrator", "references"), { recursive: true });
    const r2 = await runKimiInstall({ home, repoRoot: repo });
    assert.deepEqual(r2.removedStale, ["skills/orchestrator/references/codex-dispatch.md"]);
    assert.ok(!existsSync(join(root, "skills", "orchestrator", "references", "codex-dispatch.md")));
    assert.ok(existsSync(join(root, "skills", "orchestrator", "SKILL.md")));
  } finally { rmSync(repo, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true }); }
});

test("runKimiUninstall: removes exactly the owned files and leaves a user's own file", async () => {
  const repo = fixtureRepo(), home = tmp();
  try {
    await runKimiInstall({ home, repoRoot: repo });
    const root = join(home, ".kimi-code");
    // a user's own agent + skill living alongside muster's
    write(join(root, "agents", "my-own.md"), "mine");
    write(join(root, "skills", "my-skill", "SKILL.md"), "mine");

    const r = await runKimiUninstall({ home });
    assert.ok(r.removed.includes("agents/muster-builder.md"));
    assert.ok(!existsSync(join(root, "agents", "muster-builder.md")));
    assert.ok(!existsSync(join(root, "skills", "orchestrator")));
    // user files survive, and so does the agents/ dir (still non-empty)
    assert.ok(existsSync(join(root, "agents", "my-own.md")));
    assert.ok(existsSync(join(root, "skills", "my-skill", "SKILL.md")));
    // manifest gone
    assert.ok(!existsSync(join(root, "muster", KIMI_MANIFEST)));
  } finally { rmSync(repo, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true }); }
});

test("runKimiUninstall: a clean home reports nothing to remove", async () => {
  const home = tmp();
  try {
    const r = await runKimiUninstall({ home });
    assert.deepEqual(r.removed, []);
    assert.match(r.note, /no muster install/);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("runKimiUninstall: a manifest-owned target already missing is an idempotent skip", async () => {
  const home = tmp();
  try {
    const root = join(home, ".kimi-code");
    const manifestPath = join(root, "muster", KIMI_MANIFEST);
    write(manifestPath, JSON.stringify({
      owner: "muster",
      format: 1,
      agents: ["agents/already-gone.md"],
      skills: []
    }));

    const r = await runKimiUninstall({ home });
    assert.deepEqual(r.removed, []);
    assert.ok(!existsSync(manifestPath));
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("runKimiUninstall: platforms without directory-relative deletion fail closed", async () => {
  const home = tmp();
  try {
    const root = join(home, ".kimi-code");
    const managedAgent = join(root, "agents", "owned.md");
    const manifestPath = join(root, "muster", KIMI_MANIFEST);
    write(managedAgent, "managed agent bytes");
    write(manifestPath, JSON.stringify({
      owner: "muster",
      format: 1,
      agents: ["agents/owned.md"],
      skills: []
    }));

    await assert.rejects(
      runKimiUninstall({ home, _platform: "win32" }),
      /Safe Kimi uninstall is unavailable on win32/
    );
    assert.equal(readFileSync(managedAgent, "utf8"), "managed agent bytes");
    assert.ok(existsSync(manifestPath));
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("runKimiInstall --dry-run: reports the plan without writing", async () => {
  const repo = fixtureRepo(), home = tmp();
  try {
    const r = await runKimiInstall({ home, repoRoot: repo, dryRun: true });
    assert.equal(r.dryRun, true);
    assert.equal(r.fileCount, 5); // 2 agents + 3 skill files
    assert.ok(!existsSync(join(home, ".kimi-code")));
  } finally { rmSync(repo, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true }); }
});

test("runKimiInstall: refuses to write through a symlinked agents dir", async () => {
  const repo = fixtureRepo(), home = tmp(), elsewhere = tmp();
  try {
    mkdirSync(join(home, ".kimi-code"), { recursive: true });
    symlinkSync(elsewhere, join(home, ".kimi-code", "agents"));
    await assert.rejects(runKimiInstall({ home, repoRoot: repo }), /non-ordinary Kimi directory/);
  } finally { [repo, home, elsewhere].forEach(d => rmSync(d, { recursive: true, force: true })); }
});

test("runKimiInstall: refuses a nested skill symlink before mutating any managed file", async () => {
  const repo = fixtureRepo(), home = tmp(), elsewhere = tmp();
  try {
    const root = join(home, ".kimi-code");
    const existingAgent = join(root, "agents", "muster-builder.md");
    write(existingAgent, "existing agent bytes");
    write(join(elsewhere, "SKILL.md"), "outside skill sentinel");
    mkdirSync(join(root, "skills"), { recursive: true });
    symlinkSync(elsewhere, join(root, "skills", "orchestrator"));

    const agentBefore = readFileSync(existingAgent);
    const outsideBefore = readFileSync(join(elsewhere, "SKILL.md"));
    await assert.rejects(runKimiInstall({ home, repoRoot: repo }), /non-ordinary Kimi directory/);
    assert.deepEqual(readFileSync(existingAgent), agentBefore);
    assert.deepEqual(readFileSync(join(elsewhere, "SKILL.md")), outsideBefore);
    assert.ok(!existsSync(join(root, "muster", KIMI_MANIFEST)));
  } finally { [repo, home, elsewhere].forEach(d => rmSync(d, { recursive: true, force: true })); }
});

test("runKimiUninstall: refuses a nested agent symlink before deleting any managed file", async () => {
  const home = tmp(), elsewhere = tmp();
  try {
    const root = join(home, ".kimi-code");
    const ordinaryAgent = join(root, "agents", "muster-builder.md");
    const manifestPath = join(root, "muster", KIMI_MANIFEST);
    write(ordinaryAgent, "ordinary managed agent");
    write(join(elsewhere, "owned.md"), "outside agent sentinel");
    mkdirSync(join(root, "agents"), { recursive: true });
    symlinkSync(elsewhere, join(root, "agents", "nested"));
    write(manifestPath, JSON.stringify({
      owner: "muster",
      format: 1,
      agents: ["agents/muster-builder.md", "agents/nested/owned.md"],
      skills: []
    }));

    const agentBefore = readFileSync(ordinaryAgent);
    const outsideBefore = readFileSync(join(elsewhere, "owned.md"));
    const manifestBefore = readFileSync(manifestPath);
    await assert.rejects(runKimiUninstall({ home }), /non-ordinary Kimi directory/);
    assert.deepEqual(readFileSync(ordinaryAgent), agentBefore);
    assert.deepEqual(readFileSync(join(elsewhere, "owned.md")), outsideBefore);
    assert.deepEqual(readFileSync(manifestPath), manifestBefore);
  } finally { [home, elsewhere].forEach(d => rmSync(d, { recursive: true, force: true })); }
});

test("runKimiInstall: atomically replaces a hard-linked managed file without mutating its outside alias", async () => {
  const repo = fixtureRepo(), home = tmp(), elsewhere = tmp();
  try {
    const root = join(home, ".kimi-code");
    const outsideAlias = join(elsewhere, "agent-alias.md");
    const installedAgent = join(root, "agents", "muster-builder.md");
    write(outsideAlias, "outside hard-link sentinel");
    mkdirSync(join(root, "agents"), { recursive: true });
    linkSync(outsideAlias, installedAgent);

    const outsideBefore = readFileSync(outsideAlias);
    await runKimiInstall({ home, repoRoot: repo });

    assert.deepEqual(readFileSync(outsideAlias), outsideBefore);
    assert.notDeepEqual(readFileSync(installedAgent), outsideBefore);
    assert.match(readFileSync(installedAgent, "utf8"), /^model_preference: primary$/m);
  } finally { [repo, home, elsewhere].forEach(d => rmSync(d, { recursive: true, force: true })); }
});

test("runKimiInstall: an ancestor swapped after staging is rejected before managed-file publication", async () => {
  const repo = fixtureRepo(), home = tmp(), elsewhere = tmp();
  try {
    const root = join(home, ".kimi-code");
    const skillDir = join(root, "skills", "orchestrator");
    const parkedDir = join(root, "skills", "orchestrator-parked");
    const existingAgent = join(root, "agents", "muster-builder.md");
    write(existingAgent, "existing agent bytes");
    write(join(skillDir, "SKILL.md"), "existing managed skill");
    write(join(elsewhere, "SKILL.md"), "outside swap sentinel");
    const agentBefore = readFileSync(existingAgent);
    const outsideBefore = readFileSync(join(elsewhere, "SKILL.md"));
    let swapped = false;

    await assert.rejects(runKimiInstall({
      home,
      repoRoot: repo,
      _beforeManagedMutation: ({ operation, path }) => {
        if (operation !== "publish") return;
        if (swapped || path !== join(skillDir, "SKILL.md")) return;
        swapped = true;
        renameSync(skillDir, parkedDir);
        symlinkSync(elsewhere, skillDir);
      }
    }), /non-ordinary Kimi directory/);

    assert.equal(swapped, true);
    assert.deepEqual(readFileSync(existingAgent), agentBefore);
    assert.deepEqual(readFileSync(join(elsewhere, "SKILL.md")), outsideBefore);
    assert.equal(readFileSync(join(parkedDir, "SKILL.md"), "utf8"), "existing managed skill");
    assert.ok(!existsSync(join(root, "muster", KIMI_MANIFEST)));
  } finally { [repo, home, elsewhere].forEach(d => rmSync(d, { recursive: true, force: true })); }
});

test("runKimiUninstall: an ancestor swapped after validation is rejected before deletion", async () => {
  const home = tmp(), elsewhere = tmp();
  try {
    const root = join(home, ".kimi-code");
    const agentDir = join(root, "agents", "nested");
    const parkedDir = join(root, "agents", "nested-parked");
    const managedAgent = join(agentDir, "owned.md");
    const manifestPath = join(root, "muster", KIMI_MANIFEST);
    write(managedAgent, "managed agent bytes");
    write(join(elsewhere, "owned.md"), "outside delete sentinel");
    write(manifestPath, JSON.stringify({
      owner: "muster",
      format: 1,
      agents: ["agents/nested/owned.md"],
      skills: []
    }));
    const outsideBefore = readFileSync(join(elsewhere, "owned.md"));
    const manifestBefore = readFileSync(manifestPath);
    let swapped = false;

    await assert.rejects(runKimiUninstall({
      home,
      _beforeManagedMutation: ({ operation, path }) => {
        if (operation !== "delete" || swapped || path !== managedAgent) return;
        swapped = true;
        renameSync(agentDir, parkedDir);
        symlinkSync(elsewhere, agentDir);
      }
    }), /non-ordinary Kimi directory/);

    assert.equal(swapped, true);
    assert.equal(readFileSync(join(parkedDir, "owned.md"), "utf8"), "managed agent bytes");
    assert.deepEqual(readFileSync(join(elsewhere, "owned.md")), outsideBefore);
    assert.deepEqual(readFileSync(manifestPath), manifestBefore);
  } finally { [home, elsewhere].forEach(d => rmSync(d, { recursive: true, force: true })); }
});

test("runKimiUninstall: a final-window ancestor swap cannot redirect deletion", async () => {
  const home = tmp(), elsewhere = tmp();
  try {
    const root = join(home, ".kimi-code");
    const agentDir = join(root, "agents", "nested");
    const parkedDir = join(root, "agents", "nested-parked");
    const managedAgent = join(agentDir, "owned.md");
    const manifestPath = join(root, "muster", KIMI_MANIFEST);
    write(managedAgent, "managed agent bytes");
    write(join(elsewhere, "owned.md"), "outside delete sentinel");
    write(manifestPath, JSON.stringify({
      owner: "muster",
      format: 1,
      agents: ["agents/nested/owned.md"],
      skills: []
    }));
    const outsideBefore = readFileSync(join(elsewhere, "owned.md"));
    let swapped = false;

    await assert.rejects(runKimiUninstall({
      home,
      _beforeManagedMutation: ({ operation, path }) => {
        if (operation !== "delete-ready" || swapped || path !== managedAgent) return;
        swapped = true;
        renameSync(agentDir, parkedDir);
        symlinkSync(elsewhere, agentDir);
      }
    }), /changed during safe deletion|non-ordinary Kimi directory/);

    assert.equal(swapped, true);
    assert.equal(readFileSync(join(parkedDir, "owned.md"), "utf8"), "managed agent bytes");
    assert.deepEqual(readFileSync(join(elsewhere, "owned.md")), outsideBefore);
    assert.ok(existsSync(manifestPath));
  } finally { [home, elsewhere].forEach(d => rmSync(d, { recursive: true, force: true })); }
});

test("runKimiUninstall: a final-window ancestor rename is uncertainty, not a missing target", async () => {
  const home = tmp();
  try {
    const root = join(home, ".kimi-code");
    const agentDir = join(root, "agents", "nested");
    const parkedDir = join(root, "agents", "nested-parked");
    const managedAgent = join(agentDir, "owned.md");
    const manifestPath = join(root, "muster", KIMI_MANIFEST);
    write(managedAgent, "managed agent bytes");
    write(manifestPath, JSON.stringify({
      owner: "muster",
      format: 1,
      agents: ["agents/nested/owned.md"],
      skills: []
    }));
    let renamed = false;

    await assert.rejects(runKimiUninstall({
      home,
      _beforeManagedMutation: ({ operation, path }) => {
        if (operation !== "delete-ready" || renamed || path !== managedAgent) return;
        renamed = true;
        renameSync(agentDir, parkedDir);
      }
    }), /changed during safe deletion/);

    assert.equal(renamed, true);
    assert.equal(readFileSync(join(parkedDir, "owned.md"), "utf8"), "managed agent bytes");
    assert.ok(existsSync(manifestPath));
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("runKimiUninstall: a final-window replacement target is not deleted", async () => {
  const home = tmp();
  try {
    const root = join(home, ".kimi-code");
    const managedAgent = join(root, "agents", "owned.md");
    const parkedAgent = join(root, "agents", "owned-parked.md");
    const manifestPath = join(root, "muster", KIMI_MANIFEST);
    write(managedAgent, "managed agent bytes");
    write(manifestPath, JSON.stringify({
      owner: "muster",
      format: 1,
      agents: ["agents/owned.md"],
      skills: []
    }));
    let replaced = false;

    await assert.rejects(runKimiUninstall({
      home,
      _beforeManagedMutation: ({ operation, path }) => {
        if (operation !== "delete-ready" || replaced || path !== managedAgent) return;
        replaced = true;
        renameSync(managedAgent, parkedAgent);
        write(managedAgent, "replacement bytes");
      }
    }), /changed during safe deletion/);

    assert.equal(replaced, true);
    assert.equal(readFileSync(parkedAgent, "utf8"), "managed agent bytes");
    assert.equal(readFileSync(managedAgent, "utf8"), "replacement bytes");
    assert.ok(existsSync(manifestPath));
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("runKimiUninstall: a post-rename failure is reconciled on retry without deleting a user-recreated source", async () => {
  const home = tmp();
  try {
    const root = join(home, ".kimi-code");
    const managedAgent = join(root, "agents", "owned.md");
    const manifestPath = join(root, "muster", KIMI_MANIFEST);
    write(managedAgent, "managed agent bytes");
    write(manifestPath, JSON.stringify({
      owner: "muster",
      format: 1,
      agents: ["agents/owned.md"],
      skills: []
    }));
    let interrupted = false;

    await assert.rejects(runKimiUninstall({
      home,
      _beforeManagedMutation: ({ operation, path }) => {
        if (operation !== "delete-quarantined" || interrupted || path !== managedAgent) return;
        interrupted = true;
        throw new Error("injected post-rename failure");
      }
    }), /injected post-rename failure/);

    const interruptedManifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    assert.equal(interrupted, true);
    assert.equal(interruptedManifest.quarantines.length, 1);
    assert.deepEqual(
      readdirSync(join(root, "agents")).filter(name => name.startsWith(".muster-uninstall-")),
      [interruptedManifest.quarantines[0].directory]
    );
    write(managedAgent, "user recreated source");

    await runKimiUninstall({ home });

    assert.equal(readFileSync(managedAgent, "utf8"), "user recreated source");
    assert.ok(!existsSync(manifestPath));
    assert.deepEqual(
      readdirSync(join(root, "agents")).filter(name => name.startsWith(".muster-uninstall-")),
      []
    );
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("runKimiUninstall: a final manifest replaced during its delete hook survives", async () => {
  const home = tmp();
  try {
    const root = join(home, ".kimi-code");
    const managedAgent = join(root, "agents", "owned.md");
    const manifestPath = join(root, "muster", KIMI_MANIFEST);
    const parkedManifest = join(root, "muster", "muster-manifest-parked.json");
    write(managedAgent, "managed agent bytes");
    write(manifestPath, JSON.stringify({
      owner: "muster",
      format: 1,
      agents: ["agents/owned.md"],
      skills: []
    }));
    let replaced = false;

    await assert.rejects(runKimiUninstall({
      home,
      _beforeManagedMutation: ({ operation, path }) => {
        if (operation !== "delete" || path !== manifestPath || replaced) return;
        replaced = true;
        renameSync(manifestPath, parkedManifest);
        write(manifestPath, "user replacement manifest");
      }
    }), /changed during safe deletion/);

    assert.equal(replaced, true);
    assert.equal(readFileSync(manifestPath, "utf8"), "user replacement manifest");
    assert.ok(existsSync(parkedManifest));
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("runKimiUninstall: a final manifest replaced after its last publication survives", async () => {
  const home = tmp();
  try {
    const root = join(home, ".kimi-code");
    const managedAgent = join(root, "agents", "owned.md");
    const manifestPath = join(root, "muster", KIMI_MANIFEST);
    const parkedManifest = join(root, "muster", "muster-published-manifest.json");
    write(managedAgent, "managed agent bytes");
    write(manifestPath, JSON.stringify({
      owner: "muster",
      format: 1,
      agents: ["agents/owned.md"],
      skills: []
    }));
    let replaced = false;

    await assert.rejects(runKimiUninstall({
      home,
      _beforeManagedMutation: ({ operation, path }) => {
        if (operation !== "receipt-cleared" || path !== managedAgent || replaced) return;
        replaced = true;
        renameSync(manifestPath, parkedManifest);
        write(manifestPath, "replacement after final publication");
      }
    }), /changed during safe deletion/);

    assert.equal(replaced, true);
    assert.equal(readFileSync(manifestPath, "utf8"), "replacement after final publication");
    assert.ok(existsSync(parkedManifest));
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("runKimiUninstall: an empty receipted quarantine skips a recreated source with a different identity", async () => {
  const home = tmp();
  try {
    const root = join(home, ".kimi-code");
    const managedAgent = join(root, "agents", "owned.md");
    const manifestPath = join(root, "muster", KIMI_MANIFEST);
    const quarantine = ".muster-uninstall-0123456789abcdef01234567";
    write(managedAgent, "original managed bytes");
    const original = statSync(managedAgent);
    rmSync(managedAgent);
    mkdirSync(join(root, "agents", quarantine));
    write(managedAgent, "user recreated source");
    write(manifestPath, JSON.stringify({
      owner: "muster",
      format: 1,
      agents: ["agents/owned.md"],
      skills: [],
      quarantines: [{
        rel: "agents/owned.md",
        directory: quarantine,
        dev: String(original.dev),
        ino: String(original.ino)
      }]
    }));

    await runKimiUninstall({ home });

    assert.equal(readFileSync(managedAgent, "utf8"), "user recreated source");
    assert.ok(!existsSync(manifestPath));
    assert.ok(!existsSync(join(root, "agents", quarantine)));
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("runKimiUninstall: an empty receipted quarantine still removes a source matching the receipt", async () => {
  const home = tmp();
  try {
    const root = join(home, ".kimi-code");
    const managedAgent = join(root, "agents", "owned.md");
    const manifestPath = join(root, "muster", KIMI_MANIFEST);
    const quarantine = ".muster-uninstall-fedcba9876543210fedcba98";
    write(managedAgent, "original managed bytes");
    const original = statSync(managedAgent);
    mkdirSync(join(root, "agents", quarantine));
    write(manifestPath, JSON.stringify({
      owner: "muster",
      format: 1,
      agents: ["agents/owned.md"],
      skills: [],
      quarantines: [{
        rel: "agents/owned.md",
        directory: quarantine,
        dev: String(original.dev),
        ino: String(original.ino)
      }]
    }));

    await runKimiUninstall({ home });

    assert.ok(!existsSync(managedAgent));
    assert.ok(!existsSync(manifestPath));
    assert.ok(!existsSync(join(root, "agents", quarantine)));
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("runKimiUninstall: the receipt file and directory are durable before destructive rename", async () => {
  const home = tmp();
  try {
    const root = join(home, ".kimi-code");
    const managedAgent = join(root, "agents", "owned.md");
    const manifestPath = join(root, "muster", KIMI_MANIFEST);
    write(managedAgent, "managed agent bytes");
    write(manifestPath, JSON.stringify({
      owner: "muster",
      format: 1,
      agents: ["agents/owned.md"],
      skills: []
    }));
    const operations = [];

    await runKimiUninstall({
      home,
      _beforeManagedMutation: ({ operation, path }) => {
        if (path !== managedAgent || !["receipt-durable", "delete-quarantined"].includes(operation)) return;
        operations.push(operation);
        if (operation === "receipt-durable") {
          const receipt = JSON.parse(readFileSync(manifestPath, "utf8"));
          assert.equal(receipt.quarantines.length, 1);
          assert.equal(receipt.quarantines[0].rel, "agents/owned.md");
          assert.ok(existsSync(managedAgent), "the destructive rename has not happened yet");
        }
      }
    });

    assert.deepEqual(operations, ["receipt-durable", "delete-quarantined"]);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("runKimiInstall: a crashed final manifest quarantine is discovered before reinstall and gone after uninstall", async () => {
  const repo = fixtureRepo(), home = tmp();
  try {
    await runKimiInstall({ home, repoRoot: repo });
    const root = join(home, ".kimi-code");
    const manifestPath = join(root, "muster", KIMI_MANIFEST);
    let interrupted = false;

    await assert.rejects(runKimiUninstall({
      home,
      _beforeManagedMutation: ({ operation, path }) => {
        if (operation !== "delete-quarantined" || path !== manifestPath || interrupted) return;
        interrupted = true;
        throw new Error("injected manifest post-rename crash");
      }
    }), /injected manifest post-rename crash/);

    assert.equal(interrupted, true);
    assert.ok(!existsSync(manifestPath), "the ownership manifest is already quarantined");
    assert.equal(
      readdirSync(join(root, "muster")).filter(name => name.startsWith(".muster-uninstall-")).length,
      1,
      "the interrupted manifest quarantine exists"
    );

    await runKimiInstall({ home, repoRoot: repo });
    assert.ok(existsSync(manifestPath), "reinstall publishes a new ownership manifest");
    assert.deepEqual(
      readdirSync(join(root, "muster")).filter(name => name.startsWith(".muster-uninstall-")),
      [],
      "reinstall reconciles the discoverable final-manifest quarantine first"
    );

    await runKimiUninstall({ home });
    assert.ok(!existsSync(join(root, "muster")), "the subsequent uninstall leaves no manifest quarantine");
  } finally { [repo, home].forEach(path => rmSync(path, { recursive: true, force: true })); }
});

test("runKimiInstall: interrupted stale pruning is receipted before rename and reconciled before manifest replacement", async () => {
  const repo = fixtureRepo(), home = tmp();
  try {
    await runKimiInstall({ home, repoRoot: repo });
    const root = join(home, ".kimi-code");
    const stalePath = join(root, "agents", "muster-investigator.md");
    rmSync(join(repo, "plugin", "agents", "muster-investigator.md"));
    let interrupted = false;

    await assert.rejects(runKimiInstall({
      home,
      repoRoot: repo,
      _beforeManagedMutation: ({ operation, path }) => {
        if (operation !== "delete-quarantined" || path !== stalePath || interrupted) return;
        interrupted = true;
        throw new Error("injected stale-prune post-rename crash");
      }
    }), /injected stale-prune post-rename crash/);

    assert.equal(interrupted, true);
    write(stalePath, "user recreated stale path");
    const retried = await runKimiInstall({ home, repoRoot: repo });
    assert.deepEqual(retried.removedStale, ["agents/muster-investigator.md"]);
    assert.equal(readFileSync(stalePath, "utf8"), "user recreated stale path");
    assert.deepEqual(
      readdirSync(join(root, "agents")).filter(name => name.startsWith(".muster-uninstall-")),
      []
    );

    await runKimiUninstall({ home });
    assert.equal(readFileSync(stalePath, "utf8"), "user recreated stale path");
    assert.ok(!existsSync(join(root, "muster")));
  } finally { [repo, home].forEach(path => rmSync(path, { recursive: true, force: true })); }
});

test("runKimiUninstall: an EEXIST restore collision stays tracked and retry fails closed", async () => {
  const home = tmp();
  try {
    const root = join(home, ".kimi-code");
    const managedAgent = join(root, "agents", "owned.md");
    const parkedAgent = join(root, "agents", "owned-parked.md");
    const manifestPath = join(root, "muster", KIMI_MANIFEST);
    write(managedAgent, "managed agent bytes");
    write(manifestPath, JSON.stringify({
      owner: "muster",
      format: 1,
      agents: ["agents/owned.md"],
      skills: []
    }));
    let replaced = false;
    let recreated = false;

    await assert.rejects(runKimiUninstall({
      home,
      _beforeManagedMutation: ({ operation, path }) => {
        if (path !== managedAgent) return;
        if (operation === "delete-ready" && !replaced) {
          replaced = true;
          renameSync(managedAgent, parkedAgent);
          write(managedAgent, "raced replacement");
        } else if (operation === "delete-quarantined" && !recreated) {
          recreated = true;
          write(managedAgent, "user recreated source");
        }
      }
    }), /EEXIST|file already exists/);

    const collisionManifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    assert.equal(replaced, true);
    assert.equal(recreated, true);
    assert.equal(readFileSync(managedAgent, "utf8"), "user recreated source");
    assert.equal(readFileSync(parkedAgent, "utf8"), "managed agent bytes");
    assert.equal(collisionManifest.quarantines.length, 1);
    assert.deepEqual(
      readdirSync(join(root, "agents")).filter(name => name.startsWith(".muster-uninstall-")),
      [collisionManifest.quarantines[0].directory]
    );

    await assert.rejects(runKimiUninstall({ home }), /quarantine identity changed/);
    assert.ok(existsSync(manifestPath));
    assert.equal(readFileSync(managedAgent, "utf8"), "user recreated source");
    assert.deepEqual(
      readdirSync(join(root, "agents")).filter(name => name.startsWith(".muster-uninstall-")),
      collisionManifest.quarantines.map(record => record.directory)
    );
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("runKimiInstall: a stale manifest temp from a crashed install (pid recycled) never blocks the publish", async () => {
  const repo = fixtureRepo(), home = tmp();
  try {
    // The pre-fix temp name was pid-only with no random component
    // (`.<name>.tmp-<pid>`); atomicWrite opens O_EXCL, so a leftover temp from
    // a crashed install whose pid was later recycled threw EEXIST where the
    // old plain writeFile simply overwrote. Pre-create exactly that leftover.
    const staleDir = join(home, ".kimi-code", "muster");
    mkdirSync(staleDir, { recursive: true });
    writeFileSync(join(staleDir, `.${KIMI_MANIFEST}.tmp-${process.pid}`), "stale leftover");
    const r = await runKimiInstall({ home, repoRoot: repo });
    assert.ok(r.fileCount > 0);
    const manifest = JSON.parse(readFileSync(join(home, ".kimi-code", "muster", KIMI_MANIFEST), "utf8"));
    assert.equal(manifest.owner, "muster");
  } finally { [repo, home].forEach(d => rmSync(d, { recursive: true, force: true })); }
});

test("runKimiUninstall: a manifest entry resolving to the kimi root itself ('.') is refused, not contained", async () => {
  const home = tmp();
  try {
    write(join(home, ".kimi-code", "muster", KIMI_MANIFEST),
      JSON.stringify({ owner: "muster", format: 1, agents: ["."], skills: [] }));
    await assert.rejects(runKimiUninstall({ home }), /Refusing a Kimi path outside/);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

// --- model_preference: the two-lane dispatch bind ---------------------------

test("kimiModelPreferenceForTier: tiers fold onto the two configured lanes", () => {
  // K3 judgment family -> primary; K2.7 Coding execution family -> secondary.
  assert.equal(kimiModelPreferenceForTier("opus"), "primary");
  assert.equal(kimiModelPreferenceForTier("fable"), "primary");
  assert.equal(kimiModelPreferenceForTier("sonnet"), "secondary");
  assert.equal(kimiModelPreferenceForTier("haiku"), "secondary");
});

test("kimiPreferenceForAgentId: resolves real manifest agents, null for a non-agent", () => {
  assert.equal(kimiPreferenceForAgentId("muster-strategist"), "primary");   // fable
  assert.equal(kimiPreferenceForAgentId("muster-reviewer"), "primary");     // opus
  assert.equal(kimiPreferenceForAgentId("muster-surgeon"), "secondary");    // sonnet
  assert.equal(kimiPreferenceForAgentId("muster-investigator"), "secondary"); // haiku
  assert.equal(kimiPreferenceForAgentId("no-such-agent"), null);
});

test("KIMI_LANES stays consistent with the tier policy (no drift)", () => {
  // The lane map is derived from KIMI_TIERS, so every tier must land on a lane;
  // an unmapped model must fail loud rather than silently pick one.
  for (const tier of ["haiku", "sonnet", "opus", "fable"]) {
    assert.ok(Object.keys(KIMI_LANES).includes(kimiModelPreferenceForTier(tier)));
  }
});

test("stampModelPreference: appends, replaces, and preserves the rest byte-for-byte", () => {
  const src = "---\nname: a\ndescription: d\n---\nbody text\n";
  assert.match(stampModelPreference(src, "primary"), /^---\nname: a\ndescription: d\nmodel_preference: primary\n---\nbody text\n$/);
  // an existing line is REPLACED, not duplicated
  const already = "---\nname: a\nmodel_preference: secondary\n---\nb\n";
  const out = stampModelPreference(already, "primary");
  assert.equal(out.match(/model_preference:/g).length, 1);
  assert.match(out, /model_preference: primary/);
  // CRLF survives
  assert.match(stampModelPreference("---\r\nname: a\r\n---\r\nb\r\n", "primary"), /\r\nmodel_preference: primary\r\n/);
  // no frontmatter -> null (caller surfaces it rather than inventing a block)
  assert.equal(stampModelPreference("no frontmatter here\n", "primary"), null);
});

test("runKimiInstall: stamps each agent's lane and reports the required config", async () => {
  const repo = fixtureRepo(), home = tmp();
  try {
    const r = await runKimiInstall({ home, repoRoot: repo });
    // muster-builder = opus -> primary; muster-investigator = haiku -> secondary
    assert.equal(r.modelPreference.primary, 1);
    assert.equal(r.modelPreference.secondary, 1);
    assert.deepEqual(r.modelPreference.unstamped, []);
    assert.equal(r.modelPreference.requiredConfig.default_model, KIMI_LANES.primary);
    assert.match(r.modelPreference.requiredConfig.toml, /\[secondary_model\]/);
    // the preferred route mutates nothing shared: per-process env vars, from the
    // SAME single derivation the live `kimi -p` run loop binds with
    assert.deepEqual(r.modelPreference.requiredConfig.env, kimiLaneEnv());
    assert.equal(r.modelPreference.requiredConfig.env.KIMI_SECONDARY_MODEL, KIMI_LANES.secondary);
    assert.equal(r.modelPreference.requiredConfig.env.KIMI_CODE_EXPERIMENTAL_FLAG, "1");
    assert.match(r.modelPreference.note, /experimental/i);
    // the install output reports the ACTIVE lane binding, not just the delta:
    // the run loop sets the pair live, per process.
    assert.match(r.modelPreference.note, /kimiGoalInvocation/);
    assert.match(r.modelPreference.note, /KIMI_SECONDARY_MODEL/);

    const root = join(home, ".kimi-code");
    assert.match(readFileSync(join(root, "agents", "muster-investigator.md"), "utf8"), /^model_preference: secondary$/m);
  } finally { rmSync(repo, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true }); }
});

test("runKimiInstall: an agent with no manifest entry is copied through and SURFACED, not silently defaulted", async () => {
  const repo = fixtureRepo(), home = tmp();
  try {
    write(join(repo, "plugin", "agents", "not-in-manifest.md"), "---\nname: not-in-manifest\n---\nbody");
    const r = await runKimiInstall({ home, repoRoot: repo });
    assert.deepEqual(r.modelPreference.unstamped, [{ id: "not-in-manifest", reason: "no manifest entry" }]);
    // copied through unstamped -- never given a lane muster cannot justify
    const text = readFileSync(join(home, ".kimi-code", "agents", "not-in-manifest.md"), "utf8");
    assert.ok(!text.includes("model_preference"));
  } finally { rmSync(repo, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true }); }
});

test("probeKimiModels: managed plan (no cheaper model) confirms the policy, no remap", async () => {
  const home = tmp();
  try {
    write(join(home, ".kimi-code", "credentials", "kimi-code.json"), JSON.stringify({ access_token: "tok" }));
    const fetchImpl = async (url, opts) => {
      assert.match(url, /\/models$/);
      assert.equal(opts.headers.Authorization, "Bearer tok");
      return { ok: true, status: 200, json: async () => ({ data: KIMI_EXPECTED_MODEL_IDS.map(id => ({ id })) }) };
    };
    const r = await probeKimiModels({ home, fetchImpl });
    assert.equal(r.ok, true);
    assert.equal(r.matchesPolicy, true);
    assert.equal(r.remapHaiku, false);
    assert.deepEqual(r.cheaperCandidates, []);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("probeKimiModels: a served general model (k2.6) flags a haiku remap", async () => {
  const home = tmp();
  try {
    write(join(home, ".kimi-code", "credentials", "kimi-code.json"), JSON.stringify({ access_token: "tok" }));
    const fetchImpl = async () => ({ ok: true, status: 200, json: async () => ({ data: [{ id: "k3" }, { id: "kimi-for-coding" }, { id: "kimi-k2.6" }] }) });
    const r = await probeKimiModels({ home, fetchImpl });
    assert.equal(r.remapHaiku, true);
    assert.deepEqual(r.cheaperCandidates, ["kimi-k2.6"]);
    assert.equal(r.matchesPolicy, false);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("probeKimiModels: no token is a clean not-ok, never a throw", async () => {
  const home = tmp();
  try {
    const r = await probeKimiModels({ home, fetchImpl: async () => { throw new Error("must not be called"); } });
    assert.equal(r.ok, false);
    assert.equal(r.reason, "no-token");
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("probeKimiModels: an HTTP error is reported, not thrown", async () => {
  const home = tmp();
  try {
    write(join(home, ".kimi-code", "credentials", "kimi-code.json"), JSON.stringify({ access_token: "tok" }));
    const r = await probeKimiModels({ home, fetchImpl: async () => ({ ok: false, status: 401 }) });
    assert.equal(r.ok, false);
    assert.equal(r.reason, "http-401");
  } finally { rmSync(home, { recursive: true, force: true }); }
});

// --- Verbs: muster's entry points -------------------------------------------

test("stampSkillName: rewrites the frontmatter name, preserving everything else", () => {
  const src = "---\nname: go\ndescription: d\nargument-hint: x\n---\nbody\n";
  const out = stampSkillName(src, "muster-go");
  assert.match(out, /^name: muster-go$/m);
  assert.match(out, /^description: d$/m);
  assert.match(out, /^argument-hint: x$/m);
  assert.match(out, /^body$/m);
  assert.equal(out.match(/name:/g).length, 1); // replaced, not duplicated
  assert.equal(stampSkillName("no frontmatter\n", "muster-go"), null);
});

test("runKimiInstall: installs muster's VERBS as namespaced skills", async () => {
  const repo = fixtureRepo(), home = tmp();
  try {
    write(join(repo, "plugin", "commands", "go.md"), "---\nname: go\ndescription: hands-off lifecycle\n---\nverb body");
    write(join(repo, "plugin", "commands", "plan.md"), "---\nname: plan\ndescription: approve-first\n---\nverb body");

    const r = await runKimiInstall({ home, repoRoot: repo });
    assert.deepEqual(r.verbs.sort(), ["muster-go", "muster-plan"]);

    const root = join(home, ".kimi-code");
    const go = readFileSync(join(root, "skills", "muster-go", "SKILL.md"), "utf8");
    // Kimi registers a skill by its FRONTMATTER name, so the namespace must be
    // written into the file -- a renamed directory alone would still collide.
    assert.match(go, /^name: muster-go$/m);
    assert.match(go, /^description: hands-off lifecycle$/m);
    // `plan` is Kimi's own Plan-mode command; the prefix is what avoids it.
    assert.match(readFileSync(join(root, "skills", "muster-plan", "SKILL.md"), "utf8"), /^name: muster-plan$/m);
    assert.ok(!existsSync(join(root, "skills", "plan")));

    // verbs are manifest-owned, so uninstall reclaims them
    const manifest = JSON.parse(readFileSync(join(root, "muster", KIMI_MANIFEST), "utf8"));
    assert.ok(manifest.verbs.includes("skills/muster-go/SKILL.md"));
  } finally { rmSync(repo, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true }); }
});

test("runKimiInstall: auto-discovers the authoritative init verb", async () => {
  const repo = fixtureRepo(), home = tmp();
  try {
    write(join(repo, "plugin", "commands", "init.md"), "---\nname: init\ndescription: native init handoff\n---\ninit body");

    const r = await runKimiInstall({ home, repoRoot: repo });
    assert.ok(r.verbs.includes("muster-init"));
    const installed = readFileSync(join(home, ".kimi-code", "skills", "muster-init", "SKILL.md"), "utf8");
    assert.match(installed, /^name: muster-init$/m);
    assert.match(installed, /^init body$/m);
  } finally { rmSync(repo, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true }); }
});

test("runKimiUninstall: removes the installed verbs too", async () => {
  const repo = fixtureRepo(), home = tmp();
  try {
    write(join(repo, "plugin", "commands", "go.md"), "---\nname: go\ndescription: d\n---\nb");
    await runKimiInstall({ home, repoRoot: repo });
    const root = join(home, ".kimi-code");
    assert.ok(existsSync(join(root, "skills", "muster-go", "SKILL.md")));
    await runKimiUninstall({ home });
    assert.ok(!existsSync(join(root, "skills", "muster-go")));
  } finally { rmSync(repo, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true }); }
});

test("runKimiUninstall: a pre-verbs manifest (no verbs key) still uninstalls cleanly", async () => {
  const repo = fixtureRepo(), home = tmp();
  try {
    await runKimiInstall({ home, repoRoot: repo });
    const mPath = join(home, ".kimi-code", "muster", KIMI_MANIFEST);
    const m = JSON.parse(readFileSync(mPath, "utf8"));
    delete m.verbs;                                  // simulate the older manifest
    writeFileSync(mPath, JSON.stringify(m, null, 2));
    const r = await runKimiUninstall({ home });
    assert.ok(r.removed.length > 0);
  } finally { rmSync(repo, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true }); }
});

// --- Declarative action-class fence: [[permission.rules]] deny --------------

const ACTION_CLASSES = ["send", "sign", "submit", "publish", "purchase", "delete-remote"];

test("KIMI_PERMISSION_RULES: covers the same action classes the hook fence classifies", () => {
  // The fixed class set mirrored from plugin/hooks/action-guard.js (itself
  // mirrored from src/manifest.js's forbiddenActions enum).
  const covered = new Set(KIMI_PERMISSION_RULES.map(r => r.cls));
  for (const cls of ACTION_CLASSES) assert.ok(covered.has(cls), `missing class ${cls}`);
  // Bash surface: each of action-guard.js's BASH_PATTERNS has a declarative twin.
  for (const frag of ["git push*--delete", "git push* -d *", "gh release create", "npm publish", "git push", "curl", "gh pr merge"]) {
    assert.ok(KIMI_PERMISSION_RULES.some(r => r.pattern === `Bash({*,*/**}${frag}{*,*/**})` || r.pattern.includes(frag)), `missing Bash rule for ${frag}`);
  }
  // MCP surface: the five tool-name classes, each in both word-boundary shapes.
  for (const cls of ["send", "sign", "submit", "publish", "purchase"]) {
    const shapes = KIMI_PERMISSION_RULES.filter(r => r.cls === cls && r.pattern.startsWith("mcp__"));
    assert.equal(shapes.length, 2, `${cls} needs the mid-name and name-end shapes`);
    assert.ok(shapes.every(r => r.pattern.includes("[^a-zA-Z]")), `${cls} lost the word boundary`);
  }
  // every rule is a deny with a reason rendered into the block
  const block = renderPermissionRulesBlock();
  assert.equal(block.match(/\[\[permission\.rules\]\]/g).length, KIMI_PERMISSION_RULES.length);
  assert.equal(block.match(/decision = "deny"/g).length, KIMI_PERMISSION_RULES.length);
  assert.ok(block.startsWith(KIMI_RULES_MARKER_BEGIN));
  assert.ok(block.endsWith(KIMI_RULES_MARKER_END));
});

test("runKimiInstall --dry-run: reports the deny rules without writing", async () => {
  const repo = fixtureRepo(), home = tmp();
  try {
    const r = await runKimiInstall({ home, repoRoot: repo, dryRun: true });
    assert.equal(r.dryRun, true);
    assert.equal(r.permissionRules.created, true);
    assert.equal(r.permissionRules.config, join(home, ".kimi-code", "config.toml"));
    assert.equal(r.permissionRules.rules.length, KIMI_PERMISSION_RULES.length);
    assert.ok(r.permissionRules.rules.every(rule => rule.decision === "deny"));
    assert.ok(r.permissionRules.rules.some(rule => rule.cls === "delete-remote"));
    // nothing written, not even config.toml
    assert.ok(!existsSync(join(home, ".kimi-code")));
  } finally { rmSync(repo, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true }); }
});

test("runKimiInstall: writes the marker-delimited fence into a fresh config.toml, uninstall removes the file it created", async () => {
  const repo = fixtureRepo(), home = tmp();
  try {
    const r = await runKimiInstall({ home, repoRoot: repo });
    assert.equal(r.permissionRules.created, true);
    const configPath = join(home, ".kimi-code", "config.toml");
    const config = readFileSync(configPath, "utf8");
    assert.ok(config.includes(KIMI_RULES_MARKER_BEGIN));
    assert.ok(config.includes(`pattern = "Bash({*,*/**}git push{*,*/**})"`));
    const manifest = JSON.parse(readFileSync(join(home, ".kimi-code", "muster", KIMI_MANIFEST), "utf8"));
    assert.deepEqual(manifest.permissionRules, { created: true });

    const u = await runKimiUninstall({ home });
    assert.equal(u.permissionRules.configRemoved, true);
    assert.ok(!existsSync(configPath)); // muster made it, muster removes it
  } finally { rmSync(repo, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true }); }
});

test("runKimiInstall: merges into a pre-existing config without touching user entries; uninstall is a byte-identical round trip", async () => {
  const repo = fixtureRepo(), home = tmp();
  try {
    const root = join(home, ".kimi-code");
    mkdirSync(root, { recursive: true });
    const userConfig = "# my config\ndefault_plan_mode = true\n\n[[permission.rules]]\ndecision = \"allow\"\npattern = \"Read\"\n";
    writeFileSync(join(root, "config.toml"), userConfig);

    const r = await runKimiInstall({ home, repoRoot: repo });
    assert.equal(r.permissionRules.created, false);
    const merged = readFileSync(join(root, "config.toml"), "utf8");
    assert.ok(merged.startsWith(userConfig)); // user entries untouched, block appended

    const u = await runKimiUninstall({ home });
    assert.equal(u.permissionRules.configRemoved, false);
    assert.equal(readFileSync(join(root, "config.toml"), "utf8"), userConfig); // exact round trip
  } finally { rmSync(repo, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true }); }
});

test("runKimiInstall: reinstall is idempotent -- one block, user entries after the block survive, created receipt is sticky", async () => {
  const repo = fixtureRepo(), home = tmp();
  try {
    const root = join(home, ".kimi-code");
    const configPath = join(root, "config.toml");
    await runKimiInstall({ home, repoRoot: repo });
    // the user appends their own rule AFTER muster's block between installs
    const userTail = "\n# mine\n[[permission.rules]]\ndecision = \"ask\"\npattern = \"Bash\"\n";
    writeFileSync(configPath, readFileSync(configPath, "utf8") + userTail);

    const r = await runKimiInstall({ home, repoRoot: repo });
    const config = readFileSync(configPath, "utf8");
    assert.equal(config.split(KIMI_RULES_MARKER_BEGIN).length - 1, 1); // replaced, not duplicated
    assert.ok(config.endsWith(userTail)); // user tail untouched
    assert.equal(r.permissionRules.created, true); // sticky: muster still owns the file

    const u = await runKimiUninstall({ home });
    // the user's own tail is real content: the file survives, only muster's
    // block is stripped
    assert.equal(u.permissionRules.configRemoved, false);
    assert.equal(readFileSync(configPath, "utf8"), userTail);
  } finally { rmSync(repo, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true }); }
});

test("runKimiInstall: malformed fence markers fail loud instead of clobbering", async () => {
  const repo = fixtureRepo(), home = tmp();
  try {
    const root = join(home, ".kimi-code");
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, "config.toml"), `x = 1\n${KIMI_RULES_MARKER_BEGIN}\n`); // begin without end
    await assert.rejects(runKimiInstall({ home, repoRoot: repo }), /malformed Muster action-class fence markers/);
  } finally { rmSync(repo, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true }); }
});

test("runKimiInstall: refuses a symlinked config.toml without changing its target", async () => {
  const repo = fixtureRepo(), home = tmp(), outside = tmp();
  try {
    const root = join(home, ".kimi-code");
    const outsideConfig = join(outside, "config.toml");
    const original = "# outside\ndefault_plan_mode = true\n";
    mkdirSync(root, { recursive: true });
    writeFileSync(outsideConfig, original);
    symlinkSync(outsideConfig, join(root, "config.toml"));

    await assert.rejects(
      runKimiInstall({ home, repoRoot: repo }),
      /config\.toml|symlink|non-ordinary/i
    );
    assert.equal(readFileSync(outsideConfig, "utf8"), original);
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test("runKimiInstall: an ancestor swapped after config staging is rejected before publication", async () => {
  const repo = fixtureRepo(), home = tmp(), outside = tmp();
  const root = join(home, ".kimi-code"), movedRoot = join(home, ".kimi-code-moved");
  const outsideConfig = join(outside, "config.toml");
  try {
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, "config.toml"), "# mine\n");
    writeFileSync(outsideConfig, "# outside\n");

    await assert.rejects(runKimiInstall({
      home,
      repoRoot: repo,
      _beforeManagedMutation: ({ operation, path }) => {
        if (operation !== "publish" || path !== join(root, "config.toml")) return;
        renameSync(root, movedRoot);
        symlinkSync(outside, root);
      }
    }), /config\.toml|symlink|non-ordinary|ancestry|lock parent changed/i);
    assert.equal(readFileSync(outsideConfig, "utf8"), "# outside\n");
    assert.equal(readFileSync(join(movedRoot, "config.toml"), "utf8"), "# mine\n");
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test("runKimiInstall: a manifest publication fault rolls config.toml back byte-for-byte", async () => {
  const repo = fixtureRepo(), home = tmp();
  try {
    const root = join(home, ".kimi-code");
    const configPath = join(root, "config.toml");
    const original = Buffer.from("# mine\r\ndefault_plan_mode = true\r\n");
    mkdirSync(root, { recursive: true });
    writeFileSync(configPath, original);

    await assert.rejects(runKimiInstall({
      home,
      repoRoot: repo,
      _beforeManagedMutation: ({ operation, path }) => {
        if (operation === "publish" && path.endsWith(KIMI_MANIFEST)) {
          throw new Error("injected manifest publication fault");
        }
      }
    }), /injected manifest publication fault/);
    assert.deepEqual(readFileSync(configPath), original);
  } finally { rmSync(repo, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true }); }
});

test("runKimiInstall: live first-install rollback fsyncs manifest and config absence before cleanup", async () => {
  const repo = fixtureRepo(), home = tmp();
  let manifestAbsenceDurable = false, configAbsenceDurable = false;
  try {
    const root = join(home, ".kimi-code");
    const manifestPath = join(root, "muster", KIMI_MANIFEST);
    await assert.rejects(runKimiInstall({
      home,
      repoRoot: repo,
      _beforeManagedMutation: ({ operation }) => {
        if (operation === "manifest-durability") {
          rmSync(manifestPath, { force: true });
          throw new Error("injected missing-manifest fault");
        }
        if (operation === "manifest-rollback-absence-durable") manifestAbsenceDurable = true;
        if (operation === "config-rollback-absence-durable") configAbsenceDurable = true;
      }
    }), /injected missing-manifest fault/);
    assert.equal(manifestAbsenceDurable, true);
    assert.equal(configAbsenceDurable, true);
    assert.ok(!existsSync(join(root, "config.toml")));
    assert.ok(!existsSync(manifestPath));
  } finally { rmSync(repo, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true }); }
});

test("runKimiInstall: rollback fsyncs a concurrently restored prior manifest before cleanup", async () => {
  const repo = fixtureRepo(), home = tmp();
  let durable = false;
  try {
    await runKimiInstall({ home, repoRoot: repo });
    const root = join(home, ".kimi-code");
    const manifestPath = join(root, "muster", KIMI_MANIFEST);
    const priorLink = join(home, "prior-manifest-link");
    const before = readFileSync(manifestPath);
    linkSync(manifestPath, priorLink);
    await assert.rejects(runKimiInstall({
      home,
      repoRoot: repo,
      _beforeManagedMutation: ({ operation }) => {
        if (operation === "manifest-durability") {
          rmSync(manifestPath, { force: true });
          linkSync(priorLink, manifestPath);
          throw new Error("injected rollback");
        }
        if (operation === "manifest-rollback-already-restored-durable") durable = true;
      }
    }), /injected rollback/);
    assert.equal(durable, true);
    assert.deepEqual(readFileSync(manifestPath), before);
  } finally { rmSync(repo, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true }); }
});

test("runKimiInstall: a post-publication durability fault restores config.toml byte-for-byte", async () => {
  const repo = fixtureRepo(), home = tmp();
  try {
    const root = join(home, ".kimi-code"), configPath = join(root, "config.toml");
    const original = Buffer.from("# mine\ndefault_plan_mode = true\n");
    mkdirSync(root, { recursive: true });
    writeFileSync(configPath, original);

    await assert.rejects(runKimiInstall({
      home,
      repoRoot: repo,
      _beforeManagedMutation: ({ operation }) => {
        if (operation === "config-fsync") throw new Error("injected config durability fault");
      }
    }), /injected config durability fault/);
    assert.deepEqual(readFileSync(configPath), original);
    assert.ok(!existsSync(join(root, "muster", KIMI_MANIFEST)));
  } finally { rmSync(repo, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true }); }
});

test("runKimiInstall: an immediate post-link fault restores config.toml byte-for-byte", async () => {
  const repo = fixtureRepo(), home = tmp();
  try {
    const root = join(home, ".kimi-code"), configPath = join(root, "config.toml");
    const original = Buffer.from("# mine before link\n");
    mkdirSync(root, { recursive: true });
    writeFileSync(configPath, original);

    await assert.rejects(runKimiInstall({
      home,
      repoRoot: repo,
      _beforeManagedMutation: ({ operation }) => {
        if (operation === "config-linked") throw new Error("injected immediate post-link fault");
      }
    }), /injected immediate post-link fault/);
    assert.deepEqual(readFileSync(configPath), original);
    assert.ok(!existsSync(join(root, "muster", KIMI_MANIFEST)));
  } finally { rmSync(repo, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true }); }
});

test("runKimiInstall: an in-place edit after staging is preserved and aborts publication", async () => {
  const repo = fixtureRepo(), home = tmp();
  try {
    const root = join(home, ".kimi-code"), configPath = join(root, "config.toml");
    mkdirSync(root, { recursive: true });
    writeFileSync(configPath, "# original\n");
    await assert.rejects(runKimiInstall({
      home,
      repoRoot: repo,
      _beforeManagedMutation: ({ operation, path }) => {
        if (operation === "publish" && path === configPath) writeFileSync(configPath, "# same inode edit\n");
      }
    }), /changed during safe publication/);
    assert.equal(readFileSync(configPath, "utf8"), "# same inode edit\n");
  } finally { rmSync(repo, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true }); }
});

test("runKimiInstall: config retirement fsyncs a replacement before backup cleanup", async () => {
  const repo = fixtureRepo(), home = tmp();
  try {
    const root = join(home, ".kimi-code"), configPath = join(root, "config.toml");
    const concurrent = Buffer.from("# config retirement replacement\n");
    mkdirSync(root, { recursive: true });
    writeFileSync(configPath, "# original\n");
    let durable = false;
    await assert.rejects(runKimiInstall({
      home,
      repoRoot: repo,
      _beforeManagedMutation: ({ operation, path }) => {
        if (operation === "publish" && path === configPath) {
          renameSync(configPath, `${configPath}.prior`);
          writeFileSync(configPath, concurrent);
        }
        if (operation === "config-retire-replacement-durable") {
          assert.deepEqual(readFileSync(configPath), concurrent);
          durable = true;
          throw new Error("crash after config replacement fsync");
        }
      }
    }), /crash after config replacement fsync|rollback failed/);
    assert.equal(durable, true);
    assert.deepEqual(readFileSync(configPath), concurrent);
  } finally { rmSync(repo, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true }); }
});

test("runKimiInstall: an already-open descriptor edit after retirement is preserved", async () => {
  const repo = fixtureRepo(), home = tmp();
  let fd;
  try {
    const root = join(home, ".kimi-code"), configPath = join(root, "config.toml");
    mkdirSync(root, { recursive: true });
    writeFileSync(configPath, "# original descriptor\n");
    fd = openSync(configPath, "r+");
    await assert.rejects(runKimiInstall({
      home,
      repoRoot: repo,
      _beforeManagedMutation: ({ operation }) => {
        if (operation === "config-retired") {
          ftruncateSync(fd, 0);
          writeFileSync(fd, "# descriptor edit\n");
        }
      }
    }), /changed during safe publication/);
    assert.equal(readFileSync(configPath, "utf8"), "# descriptor edit\n");
  } finally {
    if (fd !== undefined) closeSync(fd);
    rmSync(repo, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test("runKimiInstall: an in-place edit of the linked config is preserved before manifest commit", async () => {
  const repo = fixtureRepo(), home = tmp();
  try {
    const root = join(home, ".kimi-code"), configPath = join(root, "config.toml");
    const original = Buffer.from("# original linked target\n");
    mkdirSync(root, { recursive: true });
    writeFileSync(configPath, original);
    const concurrent = Buffer.from("# concurrent linked edit\n");
    await assert.rejects(runKimiInstall({
      home,
      repoRoot: repo,
      _beforeManagedMutation: ({ operation }) => {
        if (operation === "config-fsync") writeFileSync(configPath, concurrent);
      }
    }), /rollback failed after publication failure/);
    assert.notDeepEqual(readFileSync(configPath), original);
    assert.deepEqual(readFileSync(configPath), concurrent);
    assert.ok(!existsSync(join(root, "muster", KIMI_MANIFEST)));
  } finally { rmSync(repo, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true }); }
});

test("runKimiInstall: an in-place config edit during manifest publication is preserved", async () => {
  const repo = fixtureRepo(), home = tmp();
  try {
    const root = join(home, ".kimi-code"), configPath = join(root, "config.toml");
    const original = Buffer.from("# original manifest window target\n");
    mkdirSync(root, { recursive: true });
    writeFileSync(configPath, original);
    const concurrent = Buffer.from("# concurrent manifest-window edit\n");
    await assert.rejects(runKimiInstall({
      home,
      repoRoot: repo,
      _beforeManagedMutation: ({ operation, path }) => {
        if (operation === "publish" && path.endsWith(KIMI_MANIFEST)) {
          writeFileSync(configPath, concurrent);
        }
      }
    }), /rollback failed after manifest publication failure/);
    assert.notDeepEqual(readFileSync(configPath), original);
    assert.deepEqual(readFileSync(configPath), concurrent);
    assert.ok(!existsSync(join(root, "muster", KIMI_MANIFEST)));
  } finally { rmSync(repo, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true }); }
});

test("runKimiInstall: a post-manifest config edit is preserved while the manifest rolls back", async () => {
  const repo = fixtureRepo(), home = tmp();
  try {
    await runKimiInstall({ home, repoRoot: repo });
    const root = join(home, ".kimi-code");
    const configPath = join(root, "config.toml");
    const manifestPath = join(root, "muster", KIMI_MANIFEST);
    const configBefore = readFileSync(configPath);
    const manifestBefore = readFileSync(manifestPath);

    const concurrent = Buffer.from("# post-manifest edit\n");
    await assert.rejects(runKimiInstall({
      home,
      repoRoot: repo,
      _beforeManagedMutation: ({ operation }) => {
        if (operation === "manifest-published") writeFileSync(configPath, concurrent);
      }
    }), /rollback failed after manifest publication failure/);
    assert.notDeepEqual(readFileSync(configPath), configBefore);
    assert.deepEqual(readFileSync(configPath), concurrent);
    assert.deepEqual(readFileSync(manifestPath), manifestBefore);
  } finally { rmSync(repo, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true }); }
});

test("runKimiInstall: a post-publication manifest edit is preserved instead of deleted by rollback", async () => {
  const repo = fixtureRepo(), home = tmp();
  try {
    await runKimiInstall({ home, repoRoot: repo });
    const root = join(home, ".kimi-code");
    const configPath = join(root, "config.toml");
    const manifestPath = join(root, "muster", KIMI_MANIFEST);
    const configBefore = readFileSync(configPath);
    const manifestBefore = readFileSync(manifestPath);

    const concurrentManifest = Buffer.from("{}\n");
    await assert.rejects(runKimiInstall({
      home,
      repoRoot: repo,
      _beforeManagedMutation: ({ operation }) => {
        if (operation === "manifest-published") writeFileSync(manifestPath, concurrentManifest);
      }
    }), /rollback failed after manifest publication failure/);
    assert.deepEqual(readFileSync(configPath), configBefore);
    assert.notDeepEqual(readFileSync(manifestPath), manifestBefore);
    assert.deepEqual(readFileSync(manifestPath), concurrentManifest);
  } finally { rmSync(repo, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true }); }
});

test("runKimiInstall: a pre-publication manifest edit wins the CAS and is preserved", async () => {
  const repo = fixtureRepo(), home = tmp();
  try {
    await runKimiInstall({ home, repoRoot: repo });
    const root = join(home, ".kimi-code");
    const configPath = join(root, "config.toml");
    const manifestPath = join(root, "muster", KIMI_MANIFEST);
    const configBefore = readFileSync(configPath);
    const concurrentManifest = Buffer.from("{\"concurrent\":true}\n");

    await assert.rejects(runKimiInstall({
      home,
      repoRoot: repo,
      _beforeManagedMutation: ({ operation, path }) => {
        if (operation === "publish" && path === manifestPath) writeFileSync(manifestPath, concurrentManifest);
      }
    }), /manifest changed during safe publication/);
    assert.deepEqual(readFileSync(configPath), configBefore);
    assert.deepEqual(readFileSync(manifestPath), concurrentManifest);
  } finally { rmSync(repo, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true }); }
});

test("runKimiInstall: a final-window manifest replacement wins and is not overwritten", async () => {
  const repo = fixtureRepo(), home = tmp();
  try {
    await runKimiInstall({ home, repoRoot: repo });
    const root = join(home, ".kimi-code"), manifestPath = join(root, "muster", KIMI_MANIFEST);
    const concurrent = Buffer.from("{\"concurrent-final\":true}\n");
    await assert.rejects(runKimiInstall({
      home,
      repoRoot: repo,
      _beforeManagedMutation: ({ operation }) => {
        if (operation === "manifest-retired") writeFileSync(manifestPath, concurrent);
      }
    }), /EEXIST|rollback failed|manifest changed/i);
    assert.deepEqual(readFileSync(manifestPath), concurrent);
  } finally { rmSync(repo, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true }); }
});

test("runKimiInstall: a replacement immediately before manifest retirement is restored", async () => {
  const repo = fixtureRepo(), home = tmp();
  try {
    await runKimiInstall({ home, repoRoot: repo });
    const root = join(home, ".kimi-code"), manifestPath = join(root, "muster", KIMI_MANIFEST);
    const concurrent = Buffer.from("{\"retire-race\":true}\n");
    let durable = false;
    await assert.rejects(runKimiInstall({
      home,
      repoRoot: repo,
      _beforeManagedMutation: ({ operation }) => {
        if (operation === "manifest-retire-ready") {
          renameSync(manifestPath, `${manifestPath}.prior`);
          writeFileSync(manifestPath, concurrent);
        }
        if (operation === "manifest-retire-replacement-durable") {
          assert.deepEqual(readFileSync(manifestPath), concurrent);
          durable = true;
        }
      }
    }), /manifest changed during safe publication|rollback failed/i);
    assert.equal(durable, true);
    assert.deepEqual(readFileSync(manifestPath), concurrent);
  } finally { rmSync(repo, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true }); }
});

test("runKimiInstall: a swapped manifest parent cannot redirect publication", async () => {
  const repo = fixtureRepo(), home = tmp(), outside = tmp();
  try {
    await runKimiInstall({ home, repoRoot: repo });
    const root = join(home, ".kimi-code");
    const manifestDir = join(root, "muster"), movedManifestDir = join(root, "muster-moved");
    const manifestPath = join(manifestDir, KIMI_MANIFEST);
    const manifestBefore = readFileSync(manifestPath);
    const outsideManifest = join(outside, KIMI_MANIFEST);
    writeFileSync(outsideManifest, "outside sentinel\n");
    await assert.rejects(runKimiInstall({
      home,
      repoRoot: repo,
      _beforeManagedMutation: ({ operation, path }) => {
        if (operation !== "publish" || path !== manifestPath) return;
        renameSync(manifestDir, movedManifestDir);
        symlinkSync(outside, manifestDir);
      }
    }), /symlink|ancestry|non-ordinary|rollback failed/i);
    assert.equal(readFileSync(outsideManifest, "utf8"), "outside sentinel\n");
    assert.deepEqual(readFileSync(join(movedManifestDir, KIMI_MANIFEST)), manifestBefore);
  } finally { rmSync(repo, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true }); rmSync(outside, { recursive: true, force: true }); }
});

test("runKimiInstall: an ambiguous post-rename manifest error rolls both files back", async () => {
  const repo = fixtureRepo(), home = tmp();
  try {
    await runKimiInstall({ home, repoRoot: repo });
    const root = join(home, ".kimi-code");
    const configPath = join(root, "config.toml");
    const manifestPath = join(root, "muster", KIMI_MANIFEST);
    const configBefore = readFileSync(configPath);
    const manifestBefore = readFileSync(manifestPath);

    await assert.rejects(runKimiInstall({
      home,
      repoRoot: repo,
      _beforeManagedMutation: ({ operation }) => {
        if (operation === "manifest-durability") throw new Error("injected post-rename durability error");
      }
    }), /injected post-rename durability error/);
    assert.deepEqual(readFileSync(configPath), configBefore);
    assert.deepEqual(readFileSync(manifestPath), manifestBefore);
  } finally { rmSync(repo, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true }); }
});

test("runKimiInstall: live manifest rollback restores a final-window replacement", async () => {
  const repo = fixtureRepo(), home = tmp();
  try {
    await runKimiInstall({ home, repoRoot: repo });
    const manifestPath = join(home, ".kimi-code", "muster", KIMI_MANIFEST);
    const concurrent = Buffer.from("{\"live-rollback-replacement\":true}\n");
    await assert.rejects(runKimiInstall({
      home,
      repoRoot: repo,
      _beforeManagedMutation: ({ operation }) => {
        if (operation === "manifest-durability") throw new Error("force live rollback");
        if (operation === "manifest-rollback-retire-ready") {
          renameSync(manifestPath, `${manifestPath}.prior`);
          writeFileSync(manifestPath, concurrent);
        }
      }
    }), /manifest changed|rollback failed/i);
    assert.deepEqual(readFileSync(manifestPath), concurrent);
  } finally { rmSync(repo, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true }); }
});

test("runKimiInstall: live manifest rollback preserves a final-window in-place edit", async () => {
  const repo = fixtureRepo(), home = tmp();
  try {
    await runKimiInstall({ home, repoRoot: repo });
    const manifestPath = join(home, ".kimi-code", "muster", KIMI_MANIFEST);
    const concurrent = Buffer.from("{\"live-rollback-edit\":true}\n");
    await assert.rejects(runKimiInstall({
      home,
      repoRoot: repo,
      _beforeManagedMutation: ({ operation }) => {
        if (operation === "manifest-durability") throw new Error("force live rollback");
        if (operation === "manifest-rollback-retire-ready") writeFileSync(manifestPath, concurrent);
      }
    }), /manifest changed|rollback failed/i);
    assert.deepEqual(readFileSync(manifestPath), concurrent);
  } finally { rmSync(repo, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true }); }
});

test("runKimiInstall: config rollback fsyncs a replacement before backup cleanup", async () => {
  const repo = fixtureRepo(), home = tmp();
  try {
    await runKimiInstall({ home, repoRoot: repo });
    const configPath = join(home, ".kimi-code", "config.toml");
    const concurrent = Buffer.from("# config rollback replacement\n");
    let durable = false;
    await assert.rejects(runKimiInstall({
      home,
      repoRoot: repo,
      _beforeManagedMutation: ({ operation }) => {
        if (operation === "manifest-durability") throw new Error("force config rollback");
        if (operation === "config-rollback-retire-ready") {
          renameSync(configPath, `${configPath}.prior`);
          writeFileSync(configPath, concurrent);
        }
        if (operation === "config-rollback-replacement-durable") {
          assert.deepEqual(readFileSync(configPath), concurrent);
          durable = true;
          throw new Error("crash after rollback replacement fsync");
        }
      }
    }), /crash after rollback replacement fsync|rollback failed/);
    assert.equal(durable, true);
    assert.deepEqual(readFileSync(configPath), concurrent);
  } finally { rmSync(repo, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true }); }
});

test("runKimiInstall: a missing staged manifest after retirement restores both prior files", async () => {
  const repo = fixtureRepo(), home = tmp();
  try {
    await runKimiInstall({ home, repoRoot: repo });
    const root = join(home, ".kimi-code");
    const configPath = join(root, "config.toml");
    const manifestPath = join(root, "muster", KIMI_MANIFEST);
    const configBefore = readFileSync(configPath);
    const manifestBefore = readFileSync(manifestPath);

    await assert.rejects(runKimiInstall({
      home,
      repoRoot: repo,
      _beforeManagedMutation: ({ operation, path, temporary }) => {
        if (operation === "publish" && path === manifestPath) rmSync(temporary);
      }
    }), /ENOENT|no such file/i);
    assert.deepEqual(readFileSync(configPath), configBefore);
    assert.deepEqual(readFileSync(manifestPath), manifestBefore);
  } finally { rmSync(repo, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true }); }
});

test("runKimiInstall: concurrent first installs preserve the created receipt", async () => {
  const repo = fixtureRepo(), home = tmp();
  let releaseFirst;
  let firstRetired;
  const firstPaused = new Promise(resolve => { firstRetired = resolve; });
  const release = new Promise(resolve => { releaseFirst = resolve; });
  let secondReady;
  const secondAtLock = new Promise(resolve => { secondReady = resolve; });
  try {
    const first = runKimiInstall({
      home,
      repoRoot: repo,
      _beforeManagedMutation: async ({ operation }) => {
        if (operation === "config-retired") { firstRetired(); await release; }
      }
    });
    await firstPaused;
    const second = runKimiInstall({
      home,
      repoRoot: repo,
      _beforeManagedMutation: ({ operation }) => {
        if (operation === "lifecycle-lock-ready") secondReady();
      }
    });
    await secondAtLock;
    releaseFirst();
    await Promise.all([first, second]);
    const root = join(home, ".kimi-code");
    const manifest = JSON.parse(readFileSync(join(root, "muster", KIMI_MANIFEST), "utf8"));
    assert.equal(manifest.permissionRules.created, true);
    await runKimiUninstall({ home });
    assert.ok(!existsSync(join(root, "config.toml")));
  } finally { rmSync(repo, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true }); }
});

test("runKimiInstall/runKimiUninstall: concurrent lifecycles serialize without orphaning files", async () => {
  const repo = fixtureRepo(), home = tmp();
  let releaseInstall;
  let installRetired;
  const installPaused = new Promise(resolve => { installRetired = resolve; });
  const release = new Promise(resolve => { releaseInstall = resolve; });
  let uninstallReady;
  const uninstallAtLock = new Promise(resolve => { uninstallReady = resolve; });
  try {
    const install = runKimiInstall({
      home,
      repoRoot: repo,
      _beforeManagedMutation: async ({ operation }) => {
        if (operation === "config-retired") { installRetired(); await release; }
      }
    });
    await installPaused;
    const uninstall = runKimiUninstall({
      home,
      _beforeManagedMutation: ({ operation }) => {
        if (operation === "lifecycle-lock-ready") uninstallReady();
      }
    });
    await uninstallAtLock;
    releaseInstall();
    await Promise.all([install, uninstall]);
    const root = join(home, ".kimi-code");
    assert.ok(!existsSync(join(root, "config.toml")));
    assert.ok(!existsSync(join(root, "muster", KIMI_MANIFEST)));
    assert.ok(!existsSync(join(root, "agents", "muster-builder.md")));
    assert.ok(!existsSync(join(root, "skills", "review-gate", "SKILL.md")));
    assert.ok(!readdirSync(root).some(name => name.startsWith(".muster-config-txn-")));
  } finally { rmSync(repo, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true }); }
});

test("runKimiInstall/runKimiUninstall: an absent-root uninstall still joins the lifecycle lock", async () => {
  const repo = fixtureRepo(), home = tmp();
  let releaseUninstall;
  let uninstallReady;
  const uninstallAtLock = new Promise(resolve => { uninstallReady = resolve; });
  const uninstallRelease = new Promise(resolve => { releaseUninstall = resolve; });
  let releaseInstall;
  let installRetired;
  const installPaused = new Promise(resolve => { installRetired = resolve; });
  const installRelease = new Promise(resolve => { releaseInstall = resolve; });
  try {
    const uninstall = runKimiUninstall({
      home,
      _beforeManagedMutation: async ({ operation }) => {
        if (operation === "lifecycle-lock-ready") { uninstallReady(); await uninstallRelease; }
      }
    });
    await uninstallAtLock;
    const install = runKimiInstall({
      home,
      repoRoot: repo,
      _beforeManagedMutation: async ({ operation }) => {
        if (operation === "config-retired") { installRetired(); await installRelease; }
      }
    });
    await installPaused;
    releaseUninstall();
    releaseInstall();
    await Promise.all([install, uninstall]);
    const root = join(home, ".kimi-code");
    assert.ok(!existsSync(join(root, "config.toml")));
    assert.ok(!existsSync(join(root, "muster", KIMI_MANIFEST)));
    assert.ok(!existsSync(join(root, "agents", "muster-builder.md")));
    assert.ok(!readdirSync(root).some(name => name.startsWith(".muster-config-txn-")));
  } finally { rmSync(repo, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true }); }
});

test("Kimi lifecycle lock never exposes a stalled partial acquisition", async () => {
  const home = tmp(), lockPath = join(home, "config.toml.muster-lock");
  let staged;
  const stagedReady = new Promise(resolve => { staged = resolve; });
  let active = 0, maxActive = 0;
  const enter = async () => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    await new Promise(resolve => setTimeout(resolve, 25));
    active -= 1;
  };
  try {
    const first = withCodexFileLock(lockPath, enter, {
      staleMs: 0,
      __beforeAcquirePublishHook: async () => {
        staged();
        await new Promise(resolve => setTimeout(resolve, 1_100));
      }
    });
    await stagedReady;
    const second = withCodexFileLock(lockPath, enter, { staleMs: 0 });
    await Promise.all([first, second]);
    assert.equal(maxActive, 1);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("Kimi lifecycle lock reconciles a dead private acquisition artifact", async () => {
  const home = tmp(), lockPath = join(home, "config.toml.muster-lock");
  try {
    const moduleUrl = new URL("../src/codex-lock.js", import.meta.url).href;
    const crash = `import { withCodexFileLock } from ${JSON.stringify(moduleUrl)}; await withCodexFileLock(${JSON.stringify(lockPath)}, () => {}, { __beforeAcquirePublishHook: () => process.exit(89) });`;
    assert.throws(
      () => execFileSync(process.execPath, ["--input-type=module", "-e", crash], { stdio: "ignore" }),
      error => error.status === 89
    );
    assert.ok(readdirSync(home).some(name => name.includes(".acquire-")));
    let entered = false;
    await withCodexFileLock(lockPath, () => { entered = true; });
    assert.equal(entered, true);
    assert.ok(!readdirSync(home).some(name => name.includes(".acquire-")));
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("Kimi lifecycle lock reconciles a crash-torn private acquisition artifact", async () => {
  const home = tmp(), lockPath = join(home, "config.toml.muster-lock");
  try {
    const moduleUrl = new URL("../src/codex-lock.js", import.meta.url).href;
    const crash = `import { withCodexFileLock } from ${JSON.stringify(moduleUrl)}; await withCodexFileLock(${JSON.stringify(lockPath)}, () => {}, { __afterAcquireOpenHook: () => process.exit(91) });`;
    assert.throws(
      () => execFileSync(process.execPath, ["--input-type=module", "-e", crash], { stdio: "ignore" }),
      error => error.status === 91
    );
    assert.ok(readdirSync(home).some(name => name.includes(".acquire-")));
    await withCodexFileLock(lockPath, () => {});
    assert.ok(!readdirSync(home).some(name => name.includes(".acquire-")));
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("Kimi lifecycle lock withdraws a published owner when private cleanup fails", async () => {
  const home = tmp(), lockPath = join(home, "config.toml.muster-lock");
  try {
    await assert.rejects(withCodexFileLock(lockPath, () => {
      assert.fail("failed acquisition must not enter its callback");
    }, {
      __beforeAcquireCleanupHook: () => { throw new Error("injected acquisition cleanup failure"); }
    }), /injected acquisition cleanup failure/);
    let entered = false;
    await withCodexFileLock(lockPath, () => { entered = true; });
    assert.equal(entered, true);
    assert.ok(!existsSync(lockPath));
    assert.ok(!readdirSync(home).some(name => name.includes(".acquire-")));
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("Kimi lifecycle lock rejects a replaced pinned parent before callback entry", async () => {
  const home = tmp(), moved = `${home}-moved`, lockPath = join(home, "config.toml.muster-lock");
  let firstEntered = false;
  try {
    await assert.rejects(withCodexFileLock(lockPath, () => { firstEntered = true; }, {
      __afterAcquireWriteHook: () => {
        renameSync(home, moved);
        mkdirSync(home);
      }
    }), /lock parent changed/);
    assert.equal(firstEntered, false);
    let secondEntered = false;
    await withCodexFileLock(lockPath, () => { secondEntered = true; });
    assert.equal(secondEntered, true);
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(moved, { recursive: true, force: true });
  }
});

test("Kimi lifecycle lock retires its pinned owner when the parent changes during callback", async () => {
  const home = tmp(), moved = `${home}-moved`, lockPath = join(home, "config.toml.muster-lock");
  try {
    await assert.rejects(withCodexFileLock(lockPath, () => {
      renameSync(home, moved);
      mkdirSync(home);
    }), /lock parent changed/);
    assert.ok(!existsSync(join(moved, "config.toml.muster-lock")));
    let entered = false;
    await withCodexFileLock(lockPath, () => { entered = true; }, { staleMs: 0 });
    assert.equal(entered, true);
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(moved, { recursive: true, force: true });
  }
});

test("Kimi lifecycle lock remains single-domain when .kimi-code is replaced during a callback", async () => {
  const repo = fixtureRepo(), home = tmp();
  const root = join(home, ".kimi-code"), movedRoot = join(home, ".kimi-code-moved");
  let second, secondEntered = false, swapped = false;
  try {
    await runKimiInstall({ home, repoRoot: repo });
    await assert.rejects(runKimiInstall({
      home,
      repoRoot: repo,
      _beforeManagedMutation: async ({ operation }) => {
        if (operation !== "config-retired" || swapped) return;
        swapped = true;
        renameSync(root, movedRoot);
        mkdirSync(root);
        second = runKimiInstall({
          home,
          repoRoot: repo,
          _beforeManagedMutation: ({ operation: secondOperation }) => {
            if (secondOperation === "config-lock-ready") secondEntered = true;
          }
        });
        await new Promise(resolve => setTimeout(resolve, 75));
        assert.equal(secondEntered, false, "replacement-root callback must remain behind the stable lifecycle lock");
      }
    }), /manifest ancestry changed/);
    await second;
    assert.equal(secondEntered, true);
  } finally {
    await second?.catch(() => {});
    rmSync(repo, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
    rmSync(movedRoot, { recursive: true, force: true });
  }
});

test("runKimiInstall: live transaction teardown preserves a final-window directory replacement", async () => {
  const repo = fixtureRepo(), home = tmp();
  let movedTransaction;
  try {
    await runKimiInstall({ home, repoRoot: repo });
    const root = join(home, ".kimi-code");
    await assert.rejects(runKimiInstall({
      home,
      repoRoot: repo,
      _beforeManagedMutation: ({ operation }) => {
        if (operation !== "config-txn-teardown-ready") return;
        const transaction = readdirSync(root).find(name => name.startsWith(".muster-config-txn-"));
        const transactionPath = join(root, transaction);
        movedTransaction = `${transactionPath}-owned`;
        renameSync(transactionPath, movedTransaction);
        mkdirSync(transactionPath);
      }
    }), /changed during safe publication/);
    assert.ok(existsSync(movedTransaction));
    assert.ok(readdirSync(root).some(name => name.startsWith(".muster-config-retired-")));
  } finally { rmSync(repo, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true }); }
});

test("runKimiInstall: recovery teardown preserves a final-window directory replacement", async () => {
  const repo = fixtureRepo(), home = tmp();
  const root = join(home, ".kimi-code"), transactionPath = join(root, ".muster-config-txn-empty");
  const movedTransaction = `${transactionPath}-owned`;
  try {
    mkdirSync(transactionPath, { recursive: true });
    await assert.rejects(runKimiInstall({
      home,
      repoRoot: repo,
      _beforeManagedMutation: ({ operation }) => {
        if (operation !== "config-recovery-txn-teardown-ready") return;
        renameSync(transactionPath, movedTransaction);
        mkdirSync(transactionPath);
      }
    }), /transaction changed/);
    assert.ok(existsSync(movedTransaction));
    assert.ok(readdirSync(root).some(name => name.startsWith(".muster-config-retired-")));
  } finally { rmSync(repo, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true }); }
});

test("runKimiUninstall: deletion transaction teardown preserves a final-window directory replacement", async () => {
  const repo = fixtureRepo(), home = tmp();
  let movedTransaction;
  try {
    const root = join(home, ".kimi-code");
    await runKimiInstall({ home, repoRoot: repo });
    await assert.rejects(runKimiUninstall({
      home,
      _beforeManagedMutation: ({ operation }) => {
        if (operation !== "config-delete-txn-teardown-ready") return;
        const transaction = readdirSync(root).find(name => name.startsWith(".muster-config-txn-"));
        const transactionPath = join(root, transaction);
        movedTransaction = `${transactionPath}-owned`;
        renameSync(transactionPath, movedTransaction);
        mkdirSync(transactionPath);
      }
    }), /changed during safe deletion/);
    assert.ok(existsSync(movedTransaction));
    assert.ok(readdirSync(root).some(name => name.startsWith(".muster-config-retired-")));
  } finally { rmSync(repo, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true }); }
});

test("runKimiInstall: restart recovers a process killed between retire and link", async () => {
  const repo = fixtureRepo(), home = tmp();
  try {
    const root = join(home, ".kimi-code"), configPath = join(root, "config.toml");
    const original = Buffer.from("# survives process death\n");
    mkdirSync(root, { recursive: true });
    writeFileSync(configPath, original);
    const moduleUrl = new URL("../src/kimi-install.js", import.meta.url).href;
    const script = `import { runKimiInstall } from ${JSON.stringify(moduleUrl)}; await runKimiInstall({ home: ${JSON.stringify(home)}, repoRoot: ${JSON.stringify(repo)}, _beforeManagedMutation: ({ operation }) => { if (operation === "config-retired") process.exit(73); } });`;
    assert.throws(
      () => execFileSync(process.execPath, ["--input-type=module", "-e", script], { stdio: "ignore" }),
      error => error.status === 73
    );
    assert.ok(!existsSync(configPath));
    assert.ok(readdirSync(root).some(name => name.startsWith(".muster-config-txn-")));

    await runKimiInstall({ home, repoRoot: repo });
    await runKimiUninstall({ home });
    assert.deepEqual(readFileSync(configPath), original);
    assert.ok(!readdirSync(root).some(name => name.startsWith(".muster-config-txn-")));
  } finally { rmSync(repo, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true }); }
});

for (const seam of ["config-linked", "config-fsync", "manifest-published", "config-cleanup-receipt-cleared"]) {
  test(`runKimiInstall: restart recovers a process killed at ${seam}`, async () => {
    const repo = fixtureRepo(), home = tmp();
    try {
      const root = join(home, ".kimi-code"), configPath = join(root, "config.toml");
      const original = Buffer.from(`# survives ${seam}\n`);
      mkdirSync(root, { recursive: true });
      writeFileSync(configPath, original);
      const moduleUrl = new URL("../src/kimi-install.js", import.meta.url).href;
      const script = `import { runKimiInstall } from ${JSON.stringify(moduleUrl)}; await runKimiInstall({ home: ${JSON.stringify(home)}, repoRoot: ${JSON.stringify(repo)}, _beforeManagedMutation: ({ operation }) => { if (operation === ${JSON.stringify(seam)}) process.exit(74); } });`;
      assert.throws(
        () => execFileSync(process.execPath, ["--input-type=module", "-e", script], { stdio: "ignore" }),
        error => error.status === 74
      );
      await runKimiInstall({ home, repoRoot: repo });
      await runKimiUninstall({ home });
      assert.deepEqual(readFileSync(configPath), original);
      assert.ok(!readdirSync(root).some(name => name.startsWith(".muster-config-txn-")));
    } finally { rmSync(repo, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true }); }
  });
}

test("runKimiInstall: recovery is idempotent when killed after restoring the original inode", async () => {
  const repo = fixtureRepo(), home = tmp();
  try {
    const root = join(home, ".kimi-code"), configPath = join(root, "config.toml");
    const original = Buffer.from("# survives recovery crash\n");
    mkdirSync(root, { recursive: true });
    writeFileSync(configPath, original);
    const moduleUrl = new URL("../src/kimi-install.js", import.meta.url).href;
    const crash = seam => `import { runKimiInstall } from ${JSON.stringify(moduleUrl)}; await runKimiInstall({ home: ${JSON.stringify(home)}, repoRoot: ${JSON.stringify(repo)}, _beforeManagedMutation: ({ operation }) => { if (operation === ${JSON.stringify(seam)}) process.exit(75); } });`;
    assert.throws(
      () => execFileSync(process.execPath, ["--input-type=module", "-e", crash("config-retired")], { stdio: "ignore" }),
      error => error.status === 75
    );
    assert.throws(
      () => execFileSync(process.execPath, ["--input-type=module", "-e", crash("config-recovery-restored")], { stdio: "ignore" }),
      error => error.status === 75
    );
    assert.deepEqual(readFileSync(configPath), original);

    await runKimiInstall({ home, repoRoot: repo });
    await runKimiUninstall({ home });
    assert.deepEqual(readFileSync(configPath), original);
    assert.ok(!readdirSync(root).some(name => name.startsWith(".muster-config-txn-")));
  } finally { rmSync(repo, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true }); }
});

test("runKimiInstall: restart completes an interrupted manifest rollback", async () => {
  const repo = fixtureRepo(), home = tmp();
  try {
    const root = join(home, ".kimi-code"), configPath = join(root, "config.toml");
    const original = Buffer.from("# survives manifest rollback crash\n");
    mkdirSync(root, { recursive: true });
    writeFileSync(configPath, original);
    await runKimiInstall({ home, repoRoot: repo });
    const moduleUrl = new URL("../src/kimi-install.js", import.meta.url).href;
    const script = `import { runKimiInstall } from ${JSON.stringify(moduleUrl)}; await runKimiInstall({ home: ${JSON.stringify(home)}, repoRoot: ${JSON.stringify(repo)}, _beforeManagedMutation: ({ operation }) => { if (operation === "manifest-durability") throw new Error("force rollback"); if (operation === "manifest-rollback-retired") process.exit(76); } });`;
    assert.throws(
      () => execFileSync(process.execPath, ["--input-type=module", "-e", script], { stdio: "ignore" }),
      error => error.status === 76
    );
    assert.ok(!existsSync(join(root, "muster", KIMI_MANIFEST)));

    await runKimiInstall({ home, repoRoot: repo });
    await runKimiUninstall({ home });
    assert.deepEqual(readFileSync(configPath), original);
    assert.ok(!readdirSync(root).some(name => name.startsWith(".muster-config-txn-")));
  } finally { rmSync(repo, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true }); }
});

test("runKimiInstall: restart restores a manifest retired before CAS publication", async () => {
  const repo = fixtureRepo(), home = tmp();
  try {
    const root = join(home, ".kimi-code"), configPath = join(root, "config.toml");
    const original = Buffer.from("# survives manifest retirement crash\n");
    mkdirSync(root, { recursive: true });
    writeFileSync(configPath, original);
    await runKimiInstall({ home, repoRoot: repo });
    const moduleUrl = new URL("../src/kimi-install.js", import.meta.url).href;
    const script = `import { runKimiInstall } from ${JSON.stringify(moduleUrl)}; await runKimiInstall({ home: ${JSON.stringify(home)}, repoRoot: ${JSON.stringify(repo)}, _beforeManagedMutation: ({ operation }) => { if (operation === "manifest-retired") process.exit(77); } });`;
    assert.throws(
      () => execFileSync(process.execPath, ["--input-type=module", "-e", script], { stdio: "ignore" }),
      error => error.status === 77
    );
    assert.ok(!existsSync(join(root, "muster", KIMI_MANIFEST)));

    await runKimiInstall({ home, repoRoot: repo });
    await runKimiUninstall({ home });
    assert.deepEqual(readFileSync(configPath), original);
    assert.ok(!readdirSync(root).some(name => name.startsWith(".muster-config-txn-")));
  } finally { rmSync(repo, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true }); }
});

test("runKimiInstall: recovery preserves an in-place edit of a published manifest", async () => {
  const repo = fixtureRepo(), home = tmp();
  try {
    const root = join(home, ".kimi-code"), configPath = join(root, "config.toml");
    const manifestPath = join(root, "muster", KIMI_MANIFEST);
    const original = Buffer.from("# survives corrupt committed recovery\n");
    mkdirSync(root, { recursive: true });
    writeFileSync(configPath, original);
    await runKimiInstall({ home, repoRoot: repo });
    const moduleUrl = new URL("../src/kimi-install.js", import.meta.url).href;
    const script = `import { runKimiInstall } from ${JSON.stringify(moduleUrl)}; await runKimiInstall({ home: ${JSON.stringify(home)}, repoRoot: ${JSON.stringify(repo)}, _beforeManagedMutation: ({ operation }) => { if (operation === "manifest-published") process.exit(78); } });`;
    assert.throws(
      () => execFileSync(process.execPath, ["--input-type=module", "-e", script], { stdio: "ignore" }),
      error => error.status === 78
    );
    const concurrent = Buffer.from("{}\n");
    writeFileSync(manifestPath, concurrent);

    await assert.rejects(runKimiInstall({ home, repoRoot: repo }), /manifest changed during config recovery/);
    assert.deepEqual(readFileSync(manifestPath), concurrent);
    assert.ok(readdirSync(root).some(name => name.startsWith(".muster-config-txn-")));
  } finally { rmSync(repo, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true }); }
});

test("runKimiInstall: recovery survives a second crash after manifest directory fsync", async () => {
  const repo = fixtureRepo(), home = tmp();
  try {
    const root = join(home, ".kimi-code"), configPath = join(root, "config.toml");
    const original = Buffer.from("# survives recovery durability crash\n");
    mkdirSync(root, { recursive: true });
    writeFileSync(configPath, original);
    await runKimiInstall({ home, repoRoot: repo });
    const moduleUrl = new URL("../src/kimi-install.js", import.meta.url).href;
    const crash = seam => `import { runKimiInstall } from ${JSON.stringify(moduleUrl)}; await runKimiInstall({ home: ${JSON.stringify(home)}, repoRoot: ${JSON.stringify(repo)}, _beforeManagedMutation: ({ operation }) => { if (operation === ${JSON.stringify(seam)}) process.exit(79); } });`;
    assert.throws(
      () => execFileSync(process.execPath, ["--input-type=module", "-e", crash("manifest-retired")], { stdio: "ignore" }),
      error => error.status === 79
    );
    assert.throws(
      () => execFileSync(process.execPath, ["--input-type=module", "-e", crash("config-recovery-manifest-durable")], { stdio: "ignore" }),
      error => error.status === 79
    );
    assert.throws(
      () => execFileSync(process.execPath, ["--input-type=module", "-e", crash("config-recovery-manifest-already-durable")], { stdio: "ignore" }),
      error => error.status === 79
    );

    await runKimiInstall({ home, repoRoot: repo });
    await runKimiUninstall({ home });
    assert.deepEqual(readFileSync(configPath), original);
    assert.ok(!readdirSync(root).some(name => name.startsWith(".muster-config-txn-")));
  } finally { rmSync(repo, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true }); }
});

test("runKimiInstall: first-install rollback fsyncs durable manifest absence before receipt cleanup", async () => {
  const repo = fixtureRepo(), home = tmp();
  try {
    const root = join(home, ".kimi-code");
    const manifestPath = join(root, "muster", KIMI_MANIFEST);
    const moduleUrl = new URL("../src/kimi-install.js", import.meta.url).href;
    const crash = seam => `import { runKimiInstall } from ${JSON.stringify(moduleUrl)}; await runKimiInstall({ home: ${JSON.stringify(home)}, repoRoot: ${JSON.stringify(repo)}, _beforeManagedMutation: ({ operation }) => { if (operation === ${JSON.stringify(seam)}) process.exit(90); } });`;
    assert.throws(
      () => execFileSync(process.execPath, ["--input-type=module", "-e", crash("manifest-published")], { stdio: "ignore" }),
      error => error.status === 90
    );
    rmSync(join(root, "config.toml"), { force: true });
    assert.throws(
      () => execFileSync(process.execPath, ["--input-type=module", "-e", crash("config-recovery-manifest-absence-durable")], { stdio: "ignore" }),
      error => error.status === 90
    );
    assert.ok(!existsSync(manifestPath));
    assert.ok(readdirSync(root).some(name => name.startsWith(".muster-config-txn-")));
    assert.throws(
      () => execFileSync(process.execPath, ["--input-type=module", "-e", crash("config-recovery-config-absence-durable")], { stdio: "ignore" }),
      error => error.status === 90
    );
    await runKimiInstall({ home, repoRoot: repo });
    assert.ok(existsSync(manifestPath));
    assert.ok(!readdirSync(root).some(name => name.startsWith(".muster-config-txn-")));
  } finally { rmSync(repo, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true }); }
});

test("runKimiInstall: already-restored names are fsynced before recovery cleanup", async () => {
  const repo = fixtureRepo(), home = tmp();
  try {
    const root = join(home, ".kimi-code"), configPath = join(root, "config.toml");
    const original = Buffer.from("# restored names stay durable\n");
    mkdirSync(root, { recursive: true });
    writeFileSync(configPath, original);
    await runKimiInstall({ home, repoRoot: repo });
    const moduleUrl = new URL("../src/kimi-install.js", import.meta.url).href;
    const crash = seam => `import { runKimiInstall } from ${JSON.stringify(moduleUrl)}; await runKimiInstall({ home: ${JSON.stringify(home)}, repoRoot: ${JSON.stringify(repo)}, _beforeManagedMutation: ({ operation }) => { if (operation === ${JSON.stringify(seam)}) process.exit(88); } });`;
    assert.throws(() => execFileSync(process.execPath, ["--input-type=module", "-e", crash("config-retired")], { stdio: "ignore" }), error => error.status === 88);
    assert.throws(() => execFileSync(process.execPath, ["--input-type=module", "-e", crash("config-recovery-restored")], { stdio: "ignore" }), error => error.status === 88);
    assert.throws(() => execFileSync(process.execPath, ["--input-type=module", "-e", crash("config-recovery-config-already-durable")], { stdio: "ignore" }), error => error.status === 88);
    await runKimiInstall({ home, repoRoot: repo });
    await runKimiUninstall({ home });
    assert.deepEqual(readFileSync(configPath), original);
  } finally { rmSync(repo, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true }); }
});

test("runKimiInstall: recovery cleanup stays bound to the pinned transaction directory", async () => {
  const repo = fixtureRepo(), home = tmp(), outside = tmp();
  try {
    const root = join(home, ".kimi-code"), configPath = join(root, "config.toml");
    const original = Buffer.from("# pinned transaction cleanup\n");
    mkdirSync(root, { recursive: true });
    writeFileSync(configPath, original);
    writeFileSync(join(outside, "original"), "outside sentinel\n");
    const moduleUrl = new URL("../src/kimi-install.js", import.meta.url).href;
    const crash = `import { runKimiInstall } from ${JSON.stringify(moduleUrl)}; await runKimiInstall({ home: ${JSON.stringify(home)}, repoRoot: ${JSON.stringify(repo)}, _beforeManagedMutation: ({ operation }) => { if (operation === "config-retired") process.exit(80); } });`;
    assert.throws(
      () => execFileSync(process.execPath, ["--input-type=module", "-e", crash], { stdio: "ignore" }),
      error => error.status === 80
    );
    const txnName = readdirSync(root).find(name => name.startsWith(".muster-config-txn-"));
    const txnPath = join(root, txnName), movedTxn = `${txnPath}-moved`;
    await assert.rejects(runKimiInstall({
      home,
      repoRoot: repo,
      _beforeManagedMutation: ({ operation }) => {
        if (operation !== "config-recovery-restored") return;
        renameSync(txnPath, movedTxn);
        symlinkSync(outside, txnPath);
      }
    }), /transaction changed/);
    assert.equal(readFileSync(join(outside, "original"), "utf8"), "outside sentinel\n");
    rmSync(txnPath);
    renameSync(movedTxn, txnPath);
    await runKimiInstall({ home, repoRoot: repo });
    await runKimiUninstall({ home });
    assert.deepEqual(readFileSync(configPath), original);
  } finally { rmSync(repo, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true }); rmSync(outside, { recursive: true, force: true }); }
});

test("runKimiInstall: live rollback stays bound to the pinned transaction directory", async () => {
  const repo = fixtureRepo(), home = tmp(), outside = tmp();
  try {
    const root = join(home, ".kimi-code"), configPath = join(root, "config.toml");
    const original = Buffer.from("# live pinned transaction rollback\n");
    mkdirSync(root, { recursive: true });
    writeFileSync(configPath, original);
    writeFileSync(join(outside, "original"), "outside live sentinel\n");
    let movedTxn;
    await assert.rejects(runKimiInstall({
      home,
      repoRoot: repo,
      _beforeManagedMutation: ({ operation }) => {
        if (operation !== "config-retired") return;
        const txnName = readdirSync(root).find(name => name.startsWith(".muster-config-txn-"));
        const txnPath = join(root, txnName);
        movedTxn = `${txnPath}-moved`;
        renameSync(txnPath, movedTxn);
        symlinkSync(outside, txnPath);
        throw new Error("injected live transaction swap");
      }
    }), /rollback failed|transaction swap/);
    assert.deepEqual(readFileSync(configPath), original);
    assert.equal(readFileSync(join(outside, "original"), "utf8"), "outside live sentinel\n");
    const retiredReplacement = readdirSync(root).find(name => name.startsWith(".muster-config-retired-"));
    assert.ok(retiredReplacement);
    rmSync(join(root, retiredReplacement));
    if (movedTxn) {
      const originalTxn = movedTxn.slice(0, -"-moved".length);
      renameSync(movedTxn, originalTxn);
    }
    await runKimiInstall({ home, repoRoot: repo });
    await runKimiUninstall({ home });
    assert.deepEqual(readFileSync(configPath), original);
  } finally { rmSync(repo, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true }); rmSync(outside, { recursive: true, force: true }); }
});

test("runKimiUninstall: restart accepts a durable config-only commit marker", async () => {
  const repo = fixtureRepo(), home = tmp();
  try {
    const root = join(home, ".kimi-code"), configPath = join(root, "config.toml");
    const original = Buffer.from("# config-only commit survives\n");
    mkdirSync(root, { recursive: true });
    writeFileSync(configPath, original);
    await runKimiInstall({ home, repoRoot: repo });
    const moduleUrl = new URL("../src/kimi-install.js", import.meta.url).href;
    const crash = `import { runKimiUninstall } from ${JSON.stringify(moduleUrl)}; await runKimiUninstall({ home: ${JSON.stringify(home)}, _beforeManagedMutation: ({ operation }) => { if (operation === "config-only-committed") process.exit(81); } });`;
    assert.throws(
      () => execFileSync(process.execPath, ["--input-type=module", "-e", crash], { stdio: "ignore" }),
      error => error.status === 81
    );
    await runKimiUninstall({ home });
    assert.deepEqual(readFileSync(configPath), original);
    assert.ok(!readdirSync(root).some(name => name.startsWith(".muster-config-txn-")));
  } finally { rmSync(repo, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true }); }
});

test("runKimiUninstall: restart reconciles a receipted created-config deletion", async () => {
  const repo = fixtureRepo(), home = tmp();
  try {
    await runKimiInstall({ home, repoRoot: repo });
    const root = join(home, ".kimi-code"), configPath = join(root, "config.toml");
    const moduleUrl = new URL("../src/kimi-install.js", import.meta.url).href;
    const crash = `import { runKimiUninstall } from ${JSON.stringify(moduleUrl)}; await runKimiUninstall({ home: ${JSON.stringify(home)}, _beforeManagedMutation: ({ operation }) => { if (operation === "config-delete-retired") process.exit(82); } });`;
    assert.throws(
      () => execFileSync(process.execPath, ["--input-type=module", "-e", crash], { stdio: "ignore" }),
      error => error.status === 82
    );
    await runKimiUninstall({ home });
    assert.ok(!existsSync(configPath));
    assert.ok(!readdirSync(root).some(name => name.startsWith(".muster-config-txn-")));
  } finally { rmSync(repo, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true }); }
});

test("runKimiUninstall: recovery restores an in-place edited deletion target", async () => {
  const repo = fixtureRepo(), home = tmp();
  try {
    await runKimiInstall({ home, repoRoot: repo });
    const root = join(home, ".kimi-code"), configPath = join(root, "config.toml");
    const moduleUrl = new URL("../src/kimi-install.js", import.meta.url).href;
    const crash = `import { runKimiUninstall } from ${JSON.stringify(moduleUrl)}; await runKimiUninstall({ home: ${JSON.stringify(home)}, _beforeManagedMutation: ({ operation }) => { if (operation === "config-delete-ready") process.exit(83); } });`;
    assert.throws(
      () => execFileSync(process.execPath, ["--input-type=module", "-e", crash], { stdio: "ignore" }),
      error => error.status === 83
    );
    writeFileSync(configPath, "# edited after deletion crash\n");
    await assert.rejects(runKimiUninstall({ home }), /deletion transaction changed/);
    assert.equal(readFileSync(configPath, "utf8"), "# edited after deletion crash\n");
    await runKimiUninstall({ home });
    assert.equal(readFileSync(configPath, "utf8"), "# edited after deletion crash\n");
  } finally { rmSync(repo, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true }); }
});

test("runKimiUninstall: recovery preserves a final-window deletion replacement", async () => {
  const repo = fixtureRepo(), home = tmp();
  try {
    await runKimiInstall({ home, repoRoot: repo });
    const root = join(home, ".kimi-code"), configPath = join(root, "config.toml");
    const moduleUrl = new URL("../src/kimi-install.js", import.meta.url).href;
    const crash = `import { runKimiUninstall } from ${JSON.stringify(moduleUrl)}; await runKimiUninstall({ home: ${JSON.stringify(home)}, _beforeManagedMutation: ({ operation }) => { if (operation === "config-delete-ready") process.exit(84); } });`;
    assert.throws(
      () => execFileSync(process.execPath, ["--input-type=module", "-e", crash], { stdio: "ignore" }),
      error => error.status === 84
    );
    await assert.rejects(runKimiUninstall({
      home,
      _beforeManagedMutation: ({ operation }) => {
        if (operation !== "config-delete-recovery-ready") return;
        renameSync(configPath, `${configPath}.prior`);
        writeFileSync(configPath, "# recovery replacement\n");
      }
    }), /deletion transaction changed/);
    assert.equal(readFileSync(configPath, "utf8"), "# recovery replacement\n");
  } finally { rmSync(repo, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true }); }
});

test("runKimiInstall: recovery preserves a final-window staged-config replacement", async () => {
  const repo = fixtureRepo(), home = tmp();
  try {
    const root = join(home, ".kimi-code"), configPath = join(root, "config.toml");
    mkdirSync(root, { recursive: true });
    writeFileSync(configPath, "# original staged recovery\n");
    const moduleUrl = new URL("../src/kimi-install.js", import.meta.url).href;
    const crash = `import { runKimiInstall } from ${JSON.stringify(moduleUrl)}; await runKimiInstall({ home: ${JSON.stringify(home)}, repoRoot: ${JSON.stringify(repo)}, _beforeManagedMutation: ({ operation }) => { if (operation === "config-linked") process.exit(85); } });`;
    assert.throws(
      () => execFileSync(process.execPath, ["--input-type=module", "-e", crash], { stdio: "ignore" }),
      error => error.status === 85
    );
    await assert.rejects(runKimiInstall({
      home,
      repoRoot: repo,
      _beforeManagedMutation: ({ operation }) => {
        if (operation !== "config-recovery-retire-ready") return;
        renameSync(configPath, `${configPath}.prior`);
        writeFileSync(configPath, "# staged recovery replacement\n");
      }
    }), /concurrent replacement/);
    assert.equal(readFileSync(configPath, "utf8"), "# staged recovery replacement\n");
  } finally { rmSync(repo, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true }); }
});

test("runKimiInstall: recovery rejects a swapped manifest parent without touching outside", async () => {
  const repo = fixtureRepo(), home = tmp(), outside = tmp();
  try {
    await runKimiInstall({ home, repoRoot: repo });
    const root = join(home, ".kimi-code"), manifestDir = join(root, "muster");
    const moduleUrl = new URL("../src/kimi-install.js", import.meta.url).href;
    const crash = `import { runKimiInstall } from ${JSON.stringify(moduleUrl)}; await runKimiInstall({ home: ${JSON.stringify(home)}, repoRoot: ${JSON.stringify(repo)}, _beforeManagedMutation: ({ operation }) => { if (operation === "manifest-retired") process.exit(86); } });`;
    assert.throws(
      () => execFileSync(process.execPath, ["--input-type=module", "-e", crash], { stdio: "ignore" }),
      error => error.status === 86
    );
    const moved = `${manifestDir}-moved`;
    renameSync(manifestDir, moved);
    writeFileSync(join(outside, KIMI_MANIFEST), "outside recovery sentinel\n");
    symlinkSync(outside, manifestDir);
    await assert.rejects(runKimiInstall({ home, repoRoot: repo }), /ancestry changed|safe deletion/);
    assert.equal(readFileSync(join(outside, KIMI_MANIFEST), "utf8"), "outside recovery sentinel\n");
    rmSync(manifestDir);
    renameSync(moved, manifestDir);
    await runKimiInstall({ home, repoRoot: repo });
    await runKimiUninstall({ home });
  } finally { rmSync(repo, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true }); rmSync(outside, { recursive: true, force: true }); }
});

test("runKimiInstall: recovery restores a final-window manifest replacement", async () => {
  const repo = fixtureRepo(), home = tmp();
  try {
    await runKimiInstall({ home, repoRoot: repo });
    const root = join(home, ".kimi-code"), configPath = join(root, "config.toml");
    const manifestPath = join(root, "muster", KIMI_MANIFEST);
    const moduleUrl = new URL("../src/kimi-install.js", import.meta.url).href;
    const crash = `import { runKimiInstall } from ${JSON.stringify(moduleUrl)}; await runKimiInstall({ home: ${JSON.stringify(home)}, repoRoot: ${JSON.stringify(repo)}, _beforeManagedMutation: ({ operation }) => { if (operation === "manifest-published") process.exit(87); } });`;
    assert.throws(
      () => execFileSync(process.execPath, ["--input-type=module", "-e", crash], { stdio: "ignore" }),
      error => error.status === 87
    );
    writeFileSync(configPath, "# force recovery rollback\n");
    const concurrent = Buffer.from("{\"recovery-replacement\":true}\n");
    await assert.rejects(runKimiInstall({
      home,
      repoRoot: repo,
      _beforeManagedMutation: ({ operation }) => {
        if (operation !== "manifest-recovery-retire-ready") return;
        renameSync(manifestPath, `${manifestPath}.prior`);
        writeFileSync(manifestPath, concurrent);
      }
    }), /manifest changed during config recovery/);
    assert.deepEqual(readFileSync(manifestPath), concurrent);
  } finally { rmSync(repo, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true }); }
});

test("runKimiInstall: a writer winning the final publication window is never overwritten", async () => {
  const repo = fixtureRepo(), home = tmp();
  try {
    const root = join(home, ".kimi-code"), configPath = join(root, "config.toml");
    mkdirSync(root, { recursive: true });
    writeFileSync(configPath, "# original\n");

    await assert.rejects(runKimiInstall({
      home,
      repoRoot: repo,
      _beforeManagedMutation: ({ operation }) => {
        if (operation === "config-retired") writeFileSync(configPath, "# concurrent writer\n");
      }
    }), /changed during safe publication|rollback failed|EEXIST/);
    assert.equal(readFileSync(configPath, "utf8"), "# concurrent writer\n");
    assert.ok(!existsSync(join(root, "muster", KIMI_MANIFEST)));
  } finally { rmSync(repo, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true }); }
});

test("runKimiUninstall: a final-window config replacement is not deleted", async () => {
  const repo = fixtureRepo(), home = tmp();
  try {
    await runKimiInstall({ home, repoRoot: repo });
    const root = join(home, ".kimi-code"), configPath = join(root, "config.toml");
    await assert.rejects(runKimiUninstall({
      home,
      _beforeManagedMutation: ({ operation }) => {
        if (operation !== "config-delete-ready") return;
        renameSync(configPath, `${configPath}.prior`);
        writeFileSync(configPath, "# concurrent writer\n");
      }
    }), /changed during safe deletion/);
    assert.equal(readFileSync(configPath, "utf8"), "# concurrent writer\n");
    assert.ok(existsSync(join(root, "muster", KIMI_MANIFEST)));
  } finally { rmSync(repo, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true }); }
});

test("runKimiUninstall: a pre-fence manifest (no permissionRules key) leaves config.toml alone", async () => {
  const repo = fixtureRepo(), home = tmp();
  try {
    await runKimiInstall({ home, repoRoot: repo });
    const root = join(home, ".kimi-code");
    const configPath = join(root, "config.toml");
    const configBefore = readFileSync(configPath, "utf8");
    const mPath = join(root, "muster", KIMI_MANIFEST);
    const m = JSON.parse(readFileSync(mPath, "utf8"));
    delete m.permissionRules;                       // simulate the older manifest
    writeFileSync(mPath, JSON.stringify(m, null, 2));
    const u = await runKimiUninstall({ home });
    assert.equal(u.permissionRules, undefined);     // nothing claimed
    assert.equal(readFileSync(configPath, "utf8"), configBefore); // untouched
  } finally { rmSync(repo, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true }); }
});

test("mergePermissionRules / stripPermissionRules: unit round trips", () => {
  // null -> created; strip -> file should be deleted (null)
  const fresh = mergePermissionRules(null);
  assert.equal(fresh.created, true);
  assert.equal(stripPermissionRules(fresh.text, { created: true }), null);
  // existing content: append, then strip back to byte-identical
  const user = "a = 1\n";
  const merged = mergePermissionRules(user);
  assert.equal(merged.created, false);
  assert.deepEqual(stripPermissionRules(merged.text, { created: false }), { text: user });
  // merge over a prior block replaces in place
  const again = mergePermissionRules(merged.text);
  assert.equal(again.text.split(KIMI_RULES_MARKER_BEGIN).length - 1, 1);
  // no markers -> strip is a pass-through; half-markers throw
  assert.deepEqual(stripPermissionRules("a = 1\n", { created: false }), { text: "a = 1\n" });
  assert.throws(() => mergePermissionRules(`${KIMI_RULES_MARKER_END}\n`), /malformed/);
});

// The installed config must pass Kimi's OWN validation (`kimi doctor config`).
// Opt-in: skipped when no kimi binary is on PATH; everything else in this file
// stays hermetic.
test("the emitted fence config passes `kimi doctor config`", async (t) => {
  const { execFile: execFileCb } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const execFile = promisify(execFileCb);
  const repo = fixtureRepo(), home = tmp();
  try {
    await runKimiInstall({ home, repoRoot: repo });
    const configPath = join(home, ".kimi-code", "config.toml");
    try {
      await execFile("kimi", ["doctor", "config", configPath], { env: { ...process.env, KIMI_CODE_HOME: join(home, ".kimi-code") } });
    } catch (error) {
      if (error.code === "ENOENT") { t.skip("kimi binary not on PATH"); return; }
      throw error; // doctor ran and rejected the config -- a real failure
    }
  } finally { rmSync(repo, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true }); }
});
