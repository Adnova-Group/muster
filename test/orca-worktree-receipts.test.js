import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  attachOrcaContextToManifest,
  attachOrcaContextToReceipt,
  compareOrcaWorktreeIdentity,
  discoverAndAttachOrcaContextToManifest,
  normalizeOrcaWorktreeMetadata,
  validateOrcaReceipt,
} from "../src/orca-worktree-receipts.js";
import { validateManifest } from "../src/manifest.js";
import { readFile as readFixtureFile } from "node:fs/promises";

const FIXTURE_ROOT = join(process.cwd(), "test/fixtures/orca-topology");
const validManifest = {
  outcome: "topology",
  successCriteria: ["receipt is bound"],
  crew: [{ stage: "implement", provider: "inline", source: "inline", rationale: "fixture", evidence: "fixture", fallback: "inline" }],
  recommendations: [],
  degradations: [],
  plan: [{ task: "topology", mode: "single" }],
};

async function fixture(name) {
  return JSON.parse(await readFile(join(FIXTURE_ROOT, `${name}.json`), "utf8"));
}

for (const name of ["local", "ssh", "server", "vm-cloud", "hibernated", "lineage-setup"]) {
  test(`topology fixture ${name} normalizes through the public JSON boundary`, async () => {
    const context = await fixture(name);
    const normalized = normalizeOrcaWorktreeMetadata(context);
    assert.equal(normalized.ok, true, normalized.error);
    const manifest = attachOrcaContextToManifest(validManifest, context);
    assert.equal(manifest.ok, true, manifest.error);
    assert.equal(validateManifest(manifest.value).ok, true);
    const receipt = attachOrcaContextToReceipt({ id: "r", itemId: "topology", phase: "implementation", status: "completed" }, context);
    assert.equal(receipt.ok, true, receipt.error);
    assert.equal(validateOrcaReceipt(receipt.value).ok, true);
  });
}

test("identity mismatches fail closed with the exact identity-mismatch reason", async () => {
  const context = await fixture("local");
  const mismatch = { ...context, orca_repo_id: "repo-other", orca_worktree_id: "repo-other::/workspace/other", worktree_path: "/workspace/other", remote_selector: "id:repo-other::/workspace/other" };
  const attached = attachOrcaContextToManifest({ ...validManifest, orca: context }, mismatch);
  assert.equal(attached.ok, false);
  assert.equal(attached.reason, "identity-mismatch");
  assert.deepEqual(compareOrcaWorktreeIdentity(context, mismatch).reason, "identity-mismatch");
});

test("hibernated topology keeps missing terminal/session explicit", async () => {
  const context = await fixture("hibernated");
  const normalized = normalizeOrcaWorktreeMetadata(context).metadata;
  assert.equal(normalized.terminal.connected, false);
  assert.equal(normalized.terminal.handle, null);
  assert.equal(normalized.terminal.session_id, null);
  assert.equal(normalized.terminal.state, "hibernated");
});

test("manifest attachment uses the integrated read-only adapter seam", async () => {
  const data = JSON.parse(await readFixtureFile(join(process.cwd(), "test/fixtures/orca-context/local.json"), "utf8"));
  const attached = await discoverAndAttachOrcaContextToManifest(validManifest, {
    env: data.env,
    runCommand: async ({ args }) => {
      if (args[0] === "agent-context") return data.agentContext;
      if (args[0] === "status") return data.status;
      if (args[0] === "worktree") return data.worktree;
      return data.terminals;
    },
  });
  assert.equal(attached.ok, true, attached.error);
  assert.equal(attached.value.orca.worktree_id, "repo-local::/workspace/app");
});
