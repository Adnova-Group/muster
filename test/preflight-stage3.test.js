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
