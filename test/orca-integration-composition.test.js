import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { normalizeOrcaContext } from "../src/orca-context-adapter.js";
import { normalizeOrcaWorktreeMetadata } from "../src/orca-worktree-receipts.js";
import { buildOrcaStatusBridge } from "../src/orca-status-bridge.js";
import { evaluateOrcaWorktreeCleanup } from "../src/orca-worktree-cleanup.js";

// The per-module suites each build their own hand-written input shape, so the
// seams between them were never exercised. This suite only ever feeds one
// module the *verbatim output* of the module upstream of it: adapter ->
// receipts -> status bridge -> merge-gate cleanup. A shape that any single
// module invents on its own cannot pass here.

const CONTEXT_FIXTURES = join(process.cwd(), "test/fixtures/orca-context");
const CHAIN_FIXTURES = ["local", "ssh", "server", "vm", "windows"];

async function contextFixture(name) {
  return JSON.parse(await readFile(join(CONTEXT_FIXTURES, `${name}.json`), "utf8"));
}

function adapterContext(fixture) {
  return normalizeOrcaContext({
    status: fixture.status,
    worktree: fixture.worktree,
    terminals: fixture.terminals?.terminals ?? [],
    env: fixture.env ?? {},
    agentContext: fixture.agentContext,
  });
}

// Cleanup needs merge/review/ship evidence that Orca never supplies. Only the
// identity comes from upstream; everything else is a fixed, already-satisfied
// evidence bundle so that any denial is attributable to the seam under test.
function cleanupInputFor(metadata) {
  const headSha = /^[0-9a-f]{40}$/.test(metadata.head_sha ?? "")
    ? metadata.head_sha
    : "2222222222222222222222222222222222222222";
  const identity = {
    worktreeId: metadata.worktree_id,
    repositoryId: metadata.repo_id,
    path: metadata.worktree_path,
    branch: metadata.branch,
    baseRef: metadata.base_ref,
    // A merge disposition genuinely requires a base SHA; the adapter treats it
    // as optional, so the caller supplies one when Orca did not report it.
    baseSha: metadata.base_sha ?? "1111111111111111111111111111111111111111",
    headSha,
    host: metadata.host,
    environmentId: metadata.environment_id,
    remoteSelector: metadata.remote_selector,
  };
  return {
    identity,
    observedIdentity: { ...identity },
    approval: { approved: true, branchDeletion: true },
    terminalRelease: { id: "release-1", released: true, active: false, observed: true },
    tree: { clean: true, statusPorcelain: "", observed: true },
    receipt: { id: "receipt-1", owner: "muster", status: "completed", durable: true },
    review: { verdict: "PASS" },
    ship: { approved: true, status: "merged" },
    merge: {
      merged: true,
      commitSha: headSha,
      targetSha: "3333333333333333333333333333333333333333",
      verified: true,
      isAncestor: true,
    },
  };
}

for (const name of CHAIN_FIXTURES) {
  test(`${name}: adapter context normalizes into Orca receipt metadata unchanged`, async () => {
    const context = adapterContext(await contextFixture(name));
    const metadata = normalizeOrcaWorktreeMetadata(context);
    assert.equal(metadata.ok, true, `receipts rejected adapter output: ${metadata.error}`);
    assert.equal(metadata.metadata.worktree_id, context.orca_worktree_id);
    assert.equal(metadata.metadata.worktree_path, context.worktree_path);
    assert.equal(metadata.metadata.remote_selector, context.remote_selector);
    assert.equal(metadata.metadata.host, context.host);
  });

  test(`${name}: the status bridge accepts the adapter envelope and reports it available`, async () => {
    const fixture = await contextFixture(name);
    const context = adapterContext(fixture);
    const bridge = buildOrcaStatusBridge({
      context: { available: true, context },
      musterState: { item: { id: "item-1", state: "completed" } },
      capabilityProbe: { available: true, provider: "codex", profile: "codex", capabilities: {} },
    });
    assert.equal(bridge.availability, "available", `bridge diagnostics: ${bridge.diagnostics.join("; ")}`);
    assert.equal(bridge.orca.worktree.id, context.orca_worktree_id);
    assert.equal(bridge.readOnly, true);
  });

  test(`${name}: the merge-gate cleanup evaluator accepts the receipt identity it is given`, async () => {
    const context = adapterContext(await contextFixture(name));
    const metadata = normalizeOrcaWorktreeMetadata(context);
    assert.equal(metadata.ok, true, `receipts rejected adapter output: ${metadata.error}`);
    const decision = evaluateOrcaWorktreeCleanup(cleanupInputFor(metadata.metadata));
    assert.equal(
      decision.authorized,
      true,
      `cleanup rejected upstream identity (${decision.reason}): ${decision.errors?.join("; ")}`,
    );
    assert.equal(decision.operations[0].selector, metadata.metadata.remote_selector);
  });
}

test("a canonical topology fixture is a valid merge-gate cleanup identity", async () => {
  const topology = JSON.parse(
    await readFile(join(process.cwd(), "test/fixtures/orca-topology/local.json"), "utf8"),
  );
  const metadata = normalizeOrcaWorktreeMetadata(topology);
  assert.equal(metadata.ok, true, metadata.error);
  const decision = evaluateOrcaWorktreeCleanup(cleanupInputFor(metadata.metadata));
  assert.equal(
    decision.authorized,
    true,
    `cleanup rejected the canonical local topology fixture (${decision.reason})`,
  );
});

test("an Orca worktree without a reported base SHA is still recordable as receipt metadata", async () => {
  const fixture = await contextFixture("local");
  delete fixture.worktree.worktree.baseSha;
  delete fixture.worktree.worktree.git.baseSha;
  const context = adapterContext(fixture);
  assert.equal(context.base_sha, null);
  const metadata = normalizeOrcaWorktreeMetadata(context);
  assert.equal(metadata.ok, true, `receipts required a base SHA Orca never reported: ${metadata.error}`);
  assert.equal(metadata.metadata.base_sha, null);
});
