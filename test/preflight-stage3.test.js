// Revival stage 3 preflight additions: seat tiers, specialist/skill candidates, and the
// warnings for silent seat overrides (findings F8) and remote-default worktrees (F1).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { trackedMkdtemp } from "../test-support/helpers.js";
import { SEATS, SEAT_OVERRIDE_ENV, preflightWarnings, seatModels, worktreeBaseRef } from "../src/preflight.js";

test("seat tiers: planner, checker and verifier on prime; executor and reviewer on core", () => {
  assert.deepEqual(Object.fromEntries(Object.entries(SEATS).map(([k, v]) => [k, v.tier])), {
    planner: "prime", checker: "prime", executor: "core", reviewer: "core", verifier: "prime",
  });
  const prev = process.env.MUSTER_MAX_TIER;
  delete process.env.MUSTER_MAX_TIER;
  try {
    const m = seatModels();
    assert.equal(m.planner.model, "opus");
    assert.equal(m.checker.model, "opus");
    assert.equal(m.verifier.model, "opus");
    assert.equal(m.executor.model, "sonnet");
    assert.equal(m.executor.effort, "medium");
    assert.equal(m.planner.effort, "high");
  } finally {
    if (prev !== undefined) process.env.MUSTER_MAX_TIER = prev;
  }
});

test("worktreeBaseRef: local settings beat project beat user; default fresh", async () => {
  const cwd = await trackedMkdtemp(join(tmpdir(), "muster-wbr-"));
  const home = await trackedMkdtemp(join(tmpdir(), "muster-wbr-home-"));
  assert.equal(await worktreeBaseRef(cwd, home), "fresh");
  await mkdir(join(home, ".claude"), { recursive: true });
  await writeFile(join(home, ".claude", "settings.json"), JSON.stringify({ worktree: { baseRef: "head" } }));
  assert.equal(await worktreeBaseRef(cwd, home), "head");
  await mkdir(join(cwd, ".claude"), { recursive: true });
  await writeFile(join(cwd, ".claude", "settings.json"), JSON.stringify({ worktree: { baseRef: "fresh" } }));
  assert.equal(await worktreeBaseRef(cwd, home), "fresh");
  await writeFile(join(cwd, ".claude", "settings.local.json"), JSON.stringify({ worktree: { baseRef: "head" } }));
  assert.equal(await worktreeBaseRef(cwd, home), "head");
});

test("preflightWarnings: env seat overrides and a fresh baseRef with a remote are reported", () => {
  assert.deepEqual(preflightWarnings({ env: {}, baseRef: "fresh", hasRemote: false }), []);
  assert.deepEqual(preflightWarnings({ env: {}, baseRef: "head", hasRemote: true }), []);
  const w = preflightWarnings({ env: { CLAUDE_CODE_WORKFLOW_SUBAGENT_MODEL: "haiku" }, baseRef: "fresh", hasRemote: true });
  assert.equal(w.length, 2);
  assert.match(w[0], /CLAUDE_CODE_WORKFLOW_SUBAGENT_MODEL=haiku/);
  assert.match(w[1], /worktree\.baseRef/);
  assert.equal(SEAT_OVERRIDE_ENV.length, 4);
});

// Live e2e 2026-11-10: in a repo that does not gitignore .muster/, preflight.json made the tree
// dirty and /muster:go's step-2 dirty-tree check refused the run preflight had just started.
test("preflight leaves a git repo without a .muster/ ignore rule clean", async () => {
  const { execFileSync } = await import("node:child_process");
  const { readFile } = await import("node:fs/promises");
  const { runPreflight, RUN_DIR_GITIGNORE } = await import("../src/preflight.js");
  const cwd = await trackedMkdtemp(join(tmpdir(), "muster-pf-clean-"));
  const git = (...a) => execFileSync("git", a, { cwd, encoding: "utf8" });
  git("init", "-q", "-b", "main");
  await writeFile(join(cwd, "package.json"), JSON.stringify({ name: "x", version: "1.0.0" }));
  git("add", "-A");
  git("-c", "user.name=t", "-c", "user.email=t@example.invalid", "commit", "-qm", "init");
  await runPreflight({
    outcome: "add a --json flag to the report command with tests",
    cwd, home: await trackedMkdtemp(join(tmpdir(), "muster-pf-clean-home-")), runId: "clean1",
    catalogDir: new URL("../catalog", import.meta.url).pathname,
    env: { MUSTER_CACHE_DIR: await trackedMkdtemp(join(tmpdir(), "muster-pf-clean-cache-")) },
  });
  assert.equal(git("status", "--porcelain"), "", "preflight's own output must not dirty the tree");
  assert.equal(await readFile(join(cwd, ".muster/runs/clean1/.gitignore"), "utf8"), RUN_DIR_GITIGNORE);
  // The commands still record the run with git add -f; the files a run never commits stay out.
  await writeFile(join(cwd, ".muster/runs/clean1/PLAN.md"), "# plan\n");
  assert.equal(git("status", "--porcelain"), "?? .muster/\n", "PLAN.md is not ignored");
});
