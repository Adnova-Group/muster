import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { profileToml } from "../src/codex-release.js";

// Contract test for the runner-worktree-bootstrap item: encodes the worktree
// node_modules bootstrap discipline ONCE in plugin/agents/muster-runner.md
// (the dispatchable runner's contract), then proves it flows through
// coherently into the Codex-generated equivalent -- the muster-runner agent
// profile TOML that codex/agents.manifest.json + src/codex-release.js's
// profileToml() generate from that same source file's body, verbatim (no
// per-agent prose transform exists for agent profiles, unlike commands/
// skills -- see profileToml's own "pure function" contract in
// test/codex-release.test.js). One source of truth, both surfaces.

const root = new URL("../", import.meta.url).pathname;
const runnerAgentPath = join(root, "plugin", "agents", "muster-runner.md");

test("muster-runner.md carries the Worktree bootstrap rule", async () => {
  const text = await readFile(runnerAgentPath, "utf8");
  assert.match(text, /Worktree bootstrap/, "must carry a Worktree bootstrap rule");
  assert.match(text, /node_modules/, "must name node_modules as the bootstrapped dependency");
  assert.match(text, /package-lock\.json/, "must condition the symlink on a byte-identical package-lock.json");
  assert.match(text, /symlink/i, "must name the symlink technique");
  assert.match(text, /npm ci/, "must name npm ci as the fallback");
  assert.match(text, /the repository the worktree was created from/, "must use harness-neutral phrasing, not Claude-only \"parent checkout\" jargon");
  assert.doesNotMatch(text, /parent checkout/, "must not use Claude-only \"parent checkout\" phrasing -- the same body ships verbatim to Codex");
  assert.match(text, /never committed|never commit/i, "must state the symlink is never committed");
  assert.match(text, /untracked/, "must state the untracked-only exception for the final clean-tree check");
});

test("muster-runner.md's Worktree bootstrap rule lands in the generated Codex runner agent profile, unchanged", async () => {
  const source = await readFile(runnerAgentPath, "utf8");
  const toml = profileToml("muster-runner", source, { tier: "opus" });
  assert.match(toml, /Worktree bootstrap/, "generated Codex profile must carry the same rule heading");
  assert.match(toml, /the repository the worktree was created from/, "generated Codex profile must carry the harness-neutral phrasing");
  assert.doesNotMatch(toml, /parent checkout/, "generated Codex profile must never see Claude-only \"parent checkout\" phrasing");
});
