import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { generateCodexProfiles, profileToml } from "../src/codex-release.js";
import { selectedPluginRoot } from "../test-support/codex-helpers.js";

const repoRoot = new URL("../", import.meta.url).pathname;
const runnerAgentPath = join(repoRoot, "plugin", "agents", "muster-runner.md");

test("runner source contract defines a side-effect-free build-review-only mode", async () => {
  const source = await readFile(runnerAgentPath, "utf8");
  const contract = source.slice(source.indexOf("## Dispatch contract"), source.indexOf("## Worktree bootstrap"));
  const disposition = source.slice(source.indexOf("6. Disposition:"), source.indexOf("7. Report back"));

  assert.match(contract, /runner mode.*full-lifecycle.*build-review-only/is);
  assert.match(contract, /full-lifecycle.*default/is);
  assert.match(contract, /build-review-only.*implementation.*review.*receipt/is);
  assert.match(disposition, /build-review-only/is);
  assert.match(disposition, /must not push/is);
  assert.match(disposition, /must not (?:open|create).*(?:PR|pull request)/is);
  assert.match(disposition, /must not (?:merge|integrate)/is);
  assert.match(disposition, /full-lifecycle.*push.*(?:PR|pull request)/is);
});

test("generated Codex runner profile preserves the build-review-only contract", async () => {
  const source = await readFile(runnerAgentPath, "utf8");
  const canonicalProfiles = await generateCodexProfiles(repoRoot);
  const canonicalRunner = canonicalProfiles.get("muster-runner.toml");
  const committedRunner = await readFile(join(repoRoot, ".codex", "agents", "muster-runner.toml"), "utf8");
  const profiles = [
    profileToml("muster-runner", source, { tier: "opus" }),
    await readFile(join(selectedPluginRoot, "agents", "muster-runner.toml"), "utf8"),
    committedRunner,
  ];

  assert.equal(committedRunner, canonicalRunner,
    "committed .codex runner profile must exactly match canonical generateCodexProfiles output");
  for (const profile of profiles) {
    assert.match(profile, /build-review-only/);
    assert.match(profile, /must not push/is);
    assert.match(profile, /must not (?:open|create).*(?:PR|pull request)/is);
    assert.match(profile, /must not (?:merge|integrate)/is);
    assert.match(profile, /implementation.*review.*receipt/is);
  }
});

test("scheduled Claude and Cowork legs select build-review-only, then disposition after the barrier", async () => {
  const goBacklog = await readFile(join(repoRoot, "plugin", "commands", "go-backlog.md"), "utf8");
  const cowork = await readFile(join(repoRoot, "cowork", "sprint-protocol.md"), "utf8");

  for (const [label, source] of [["go-backlog", goBacklog], ["Cowork", cowork]]) {
    const wave = source.slice(source.indexOf("**Wave mode**") >= 0
      ? source.indexOf("**Wave mode**")
      : source.indexOf("**Wave path"));
    assert.match(wave, /build-review-only/, `${label} must select the side-effect-free runner mode`);
    assert.match(wave, /(?:after|only after).*all-build-review-complete/is,
      `${label} must defer disposition until the barrier`);
    for (const disposition of ["pr", "keep", "merge-local", "merge-push"]) {
      assert.match(wave, new RegExp(`\\b${disposition}\\b`), `${label} must map ${disposition}`);
    }
  }
});

test("ordinary runner command remains full-lifecycle on source and generated Codex skill surfaces", async () => {
  const sourceCommand = await readFile(join(repoRoot, "plugin", "commands", "runner.md"), "utf8");
  const generatedCommand = await readFile(join(selectedPluginRoot, "commands", "runner.md"), "utf8");
  const generatedSkill = await readFile(join(selectedPluginRoot, "skills", "muster-runner", "SKILL.md"), "utf8");

  for (const [label, source] of [
    ["source command", sourceCommand],
    ["generated command", generatedCommand],
    ["generated skill", generatedSkill],
  ]) {
    assert.match(source, /full-lifecycle/, `${label} must select ordinary runner behavior`);
    assert.match(source, /push.*(?:PR|pull request)|(?:PR|pull request).*push/is,
      `${label} must retain the PR disposition lifecycle`);
  }
});
