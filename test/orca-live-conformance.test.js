import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { normalizeOrcaContext, parseOrcaJsonResponse } from "../src/orca-context-adapter.js";
import { normalizeOrcaWorktreeMetadata } from "../src/orca-worktree-receipts.js";
import { evaluateOrcaWorktreeCleanup } from "../src/orca-worktree-cleanup.js";

// Every other Orca fixture in this repo is self-authored, so the suite could
// only ever prove internal consistency. This one is captured verbatim from a
// live Orca 1.4.177 runtime -- `status`, `worktree list`, `agent-context`, and
// `terminal list` -- with machine identifiers replaced by stable placeholders
// and nothing else touched. It is the only fixture that can prove conformance,
// and three of its properties were surprises the hand-written fixtures missed:
//
//   - the worktree path is a UNC path (`\\wsl.localhost\...`), not POSIX;
//   - the branch is a fully-qualified ref (`refs/heads/main`), not `main`;
//   - a real worktree record carries no base ref or base SHA at all.

const LIVE = join(process.cwd(), "test/fixtures/orca-live/local-wsl-unc.json");

async function live() {
  return JSON.parse(await readFile(LIVE, "utf8"));
}

function contextFrom(captured) {
  return normalizeOrcaContext({
    status: parseOrcaJsonResponse(captured.status, "status"),
    worktree: { worktree: parseOrcaJsonResponse(captured.worktreeList, "worktree list").worktrees[0] },
    terminals: parseOrcaJsonResponse(captured.terminalList, "terminal list").terminals ?? [],
    env: {},
    agentContext: captured.agentContext,
  });
}

test("the live capture is what it claims to be", async () => {
  const captured = await live();
  assert.equal(captured._capture.orca_version, "1.4.177");
  assert.equal(captured.agentContext.schemaVersion, 1);
  assert.equal(captured.agentContext.commandCount, captured.agentContext.commands.length);
  assert.equal(captured.status.ok, true);
});

test("real status --json carries the runtime and graph fields the adapter reads", async () => {
  const status = parseOrcaJsonResponse((await live()).status, "status");
  assert.equal(typeof status.runtime.reachable, "boolean");
  assert.equal(status.runtime.state, "ready");
  assert.equal(status.graph.state, "ready");
  assert.ok(status.runtime.runtimeId);
});

test("a live worktree record normalizes through the adapter and into receipt metadata", async () => {
  const context = contextFrom(await live());
  // UNC path, preserved verbatim rather than coerced to POSIX.
  assert.match(context.worktree_path, /^\\\\/);
  assert.equal(context.host, "local");
  assert.equal(context.remote_selector, `id:${context.orca_worktree_id}`);
  // Orca reports no base ref or SHA for this worktree. Requiring one would make
  // every real worktree unrecordable.
  assert.equal(context.base_sha, null);

  const metadata = normalizeOrcaWorktreeMetadata(context);
  assert.equal(metadata.ok, true, `receipts rejected live Orca output: ${metadata.error}`);
  assert.equal(metadata.metadata.worktree_path, context.worktree_path);
  assert.equal(metadata.metadata.is_main_worktree, true);
});

test("Orca reports a fully-qualified branch ref, and the protection guard honours it", async () => {
  const context = contextFrom(await live());
  assert.equal(context.branch, "refs/heads/main");

  const metadata = normalizeOrcaWorktreeMetadata(context).metadata;
  const identity = {
    worktreeId: metadata.worktree_id,
    repositoryId: metadata.repo_id,
    path: metadata.worktree_path,
    branch: metadata.branch,
    baseRef: metadata.base_ref,
    baseSha: "1111111111111111111111111111111111111111",
    host: metadata.host,
    environmentId: metadata.environment_id,
    remoteSelector: metadata.remote_selector,
  };
  const evidence = {
    approval: { approved: true, branchDeletion: true },
    terminalRelease: { released: true, active: false, observed: true },
    tree: { clean: true, statusPorcelain: "", observed: true },
    receipt: { id: "receipt-live", owner: "muster", status: "completed", durable: true },
    review: { verdict: "PASS" },
    ship: { approved: true, status: "merged" },
    merge: {
      merged: true,
      commitSha: "2222222222222222222222222222222222222222",
      targetSha: "3333333333333333333333333333333333333333",
      verified: true,
      isAncestor: true,
    },
  };

  // The primary checkout is barred outright...
  const primary = evaluateOrcaWorktreeCleanup({
    identity: { ...identity, isMainWorktree: true },
    observedIdentity: { ...identity, isMainWorktree: true },
    ...evidence,
  });
  assert.equal(primary.authorized, false);
  assert.equal(primary.reason, "primary-worktree");

  // ...and `refs/heads/main` is protected even when it is not the primary one.
  const protectedRef = evaluateOrcaWorktreeCleanup({
    identity, observedIdentity: { ...identity }, ...evidence,
  });
  assert.equal(protectedRef.authorized, false);
  assert.equal(protectedRef.reason, "protected-branch");
});

test("a fully-qualified feature ref on a non-primary worktree is still cleanable", async () => {
  const metadata = normalizeOrcaWorktreeMetadata(contextFrom(await live())).metadata;
  const identity = {
    worktreeId: metadata.worktree_id,
    repositoryId: metadata.repo_id,
    path: metadata.worktree_path,
    branch: "refs/heads/feature/orca-worker",
    baseRef: metadata.base_ref,
    baseSha: "1111111111111111111111111111111111111111",
    host: metadata.host,
    environmentId: metadata.environment_id,
    remoteSelector: metadata.remote_selector,
  };
  const decision = evaluateOrcaWorktreeCleanup({
    identity,
    observedIdentity: { ...identity },
    approval: { approved: true, branchDeletion: true },
    terminalRelease: { released: true, active: false, observed: true },
    tree: { clean: true, statusPorcelain: "", observed: true },
    receipt: { id: "receipt-live", owner: "muster", status: "completed", durable: true },
    review: { verdict: "PASS" },
    ship: { approved: true, status: "merged" },
    merge: {
      merged: true,
      commitSha: "2222222222222222222222222222222222222222",
      targetSha: "3333333333333333333333333333333333333333",
      verified: true,
      isAncestor: true,
    },
  });
  assert.equal(decision.authorized, true, `${decision.reason}: ${decision.errors?.join("; ")}`);
  assert.equal(decision.operations[0].args.at(-2), "--force");
});
