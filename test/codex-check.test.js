// Split from the former test/codex.test.js monolith: scripts/check-codex.mjs
// validation coherence (hooks.json presence/absence, machine-specific leaks,
// reasoning accept-list parity) and the live-inventory manifest-validate gate.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile, repoRoot, selectedPluginRoot } from "../test-support/codex-helpers.js";

test("Codex validation accepts removal of the obsolete static profile files", async () => {
  const { stdout } = await execFile("node", ["scripts/check-codex.mjs"], { cwd: repoRoot });
  assert.match(stdout, /"ok": true/);
});

// Both hooks.json tests below must tolerate hooks.json being ABSENT before
// they run -- a fresh clone or CI checkout never has it (it is
// install-generated and gitignored) -- and restore whatever the prior state
// actually was (present-with-content, or absent), not assume presence.
const readHooksConfigBackup = async hooksConfigPath => readFile(hooksConfigPath, "utf8").catch(error => {
  if (error.code === "ENOENT") return null;
  throw error;
});
const restoreHooksConfig = async (hooksConfigPath, backup) => {
  if (backup === null) await rm(hooksConfigPath).catch(error => { if (error.code !== "ENOENT") throw error; });
  else await writeFile(hooksConfigPath, backup);
};

test("Codex validation skips the hooks.json coherence check when it is absent (fresh clone pre-install)", async () => {
  const hooksConfigPath = join(repoRoot, ".codex", "hooks.json");
  const backup = await readHooksConfigBackup(hooksConfigPath);
  await rm(hooksConfigPath).catch(error => { if (error.code !== "ENOENT") throw error; });
  try {
    const { stdout } = await execFile("node", ["scripts/check-codex.mjs"], { cwd: repoRoot });
    assert.match(stdout, /"ok": true/);
    assert.match(stdout, /hooks\.json is absent/);
  } finally {
    await restoreHooksConfig(hooksConfigPath, backup);
  }
});

test("Codex validation rejects a tracked project hooks.json baked for a different checkout", async () => {
  const hooksConfigPath = join(repoRoot, ".codex", "hooks.json");
  const backup = await readHooksConfigBackup(hooksConfigPath);
  const base = backup ? JSON.parse(backup) : { hooks: { SessionStart: [{ hooks: [{ type: "command", command: "node 'placeholder'" }] }] } };
  for (const groups of Object.values(base.hooks)) for (const group of groups) for (const hook of group.hooks || []) {
    hook.command = "node '/some/other/checkout/.codex/muster/hooks/muster-hook.mjs'";
  }
  await writeFile(hooksConfigPath, JSON.stringify(base, null, 2));
  try {
    await assert.rejects(
      () => execFile("node", ["scripts/check-codex.mjs"], { cwd: repoRoot }),
      error => /points outside this checkout/.test(error.stderr || error.message)
    );
  } finally {
    await restoreHooksConfig(hooksConfigPath, backup);
  }
});

test("Codex validation guard rejects any tracked .codex file that embeds a machine-specific absolute path", async () => {
  const targetPath = join(repoRoot, ".codex", "agents", "muster-surgeon.toml");
  const backup = await readFile(targetPath, "utf8");
  await writeFile(targetPath, `${backup}\n# leaked path: "/home/example/leak"\n`);
  try {
    await assert.rejects(
      () => execFile("node", ["scripts/check-codex.mjs"], { cwd: repoRoot }),
      error => /machine-specific absolute path/.test(error.stderr || error.message)
    );
  } finally {
    await writeFile(targetPath, backup);
  }
});

test("Codex reasoning accept-list stays in single-source-of-truth parity with the frozen profileToml generator", async () => {
  // src/codex-release.js is FROZEN this wave, so its profileToml override
  // accept-list can't be refactored into a shared export; this parses both
  // literals directly and asserts check-codex.mjs never accepts a reasoning
  // override profileToml would reject (which would otherwise pass
  // validation and then crash profile generation).
  const extractAcceptList = (source, label) => {
    const match = source.match(/\[((?:\s*"[a-z]+"\s*,?)+)\]\.includes\(config\.reasoning\)/);
    if (!match) throw new Error(`could not locate the ${label} reasoning accept-list literal`);
    return match[1].match(/"[a-z]+"/g).map(entry => entry.slice(1, -1));
  };
  const checkCodexSource = await readFile(join(repoRoot, "scripts", "check-codex.mjs"), "utf8");
  const releaseSource = await readFile(join(repoRoot, "src", "codex-release.js"), "utf8");
  const checkCodexList = extractAcceptList(checkCodexSource, "check-codex.mjs");
  const releaseList = extractAcceptList(releaseSource, "codex-release.js profileToml");
  for (const value of checkCodexList) {
    assert.ok(releaseList.includes(value), `check-codex.mjs accepts reasoning override ${JSON.stringify(value)} that profileToml would reject`);
  }
  assert.deepEqual(new Set(checkCodexList), new Set(releaseList), "check-codex.mjs and profileToml reasoning accept-lists have diverged");
});

test("Codex manifest validation fails closed on a bound skill absent from live Codex inventory", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "muster-codex-manifest-"));
  const file = join(tmp, "manifest.json");
  await writeFile(file, JSON.stringify({
    outcome: "Verify one result",
    successCriteria: ["One check passes"],
    crew: [{ stage: "code-review", provider: "inline", source: "inline", rationale: "Review", evidence: "One check", fallback: "inline" }],
    recommendations: [],
    degradations: [],
    plan: [{ id: "t1", task: "Verify", mode: "single", deps: [], skills: [{ id: "definitely-not-installed", rationale: "Dogfood guard" }] }]
  }));
  const runtime = join(selectedPluginRoot, "runtime", "muster.mjs");
  await assert.rejects(
    () => execFile("node", [runtime, "manifest", "validate", "--codex", file], { cwd: tmp, env: { ...process.env, CODEX_HOME: join(tmp, "home") } }),
    error => error.code === 2 && /definitely-not-installed/.test(error.stdout)
  );
});
