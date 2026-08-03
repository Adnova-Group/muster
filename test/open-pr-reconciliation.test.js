import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const EXPECTED_PRS = [
  145, 146, 147, 148, 149, 150, 151, 152,
  166, 167, 168, 169, 170, 171, 172, 173, 174, 175, 176, 185,
];

const EXPECTED_COUNTS = { total: 20, merged: 10, closed: 10, current: 0, awaitingDisposition: 0 };

test("final PR reconciliation records one current disposition per PR and leaves none awaiting", async () => {
  const ledger = JSON.parse(await readFile(
    new URL("../docs/decisions/open-pr-branch-reconciliation.json", import.meta.url),
    "utf8",
  ));
  const narrative = await readFile(
    new URL("../docs/decisions/open-pr-branch-reconciliation.md", import.meta.url),
    "utf8",
  );

  assert.equal(ledger.itemId, "finalize-pr-reconciliation-truth");
  assert.equal(ledger.schemaVersion, 3);
  assert.equal(ledger.repository, "Adnova-Group/muster");
  assert.equal(ledger.baseCommit, "95b3bf9c2d6c8ffc75469b01b4b0c1ee94679be1");
  assert.match(ledger.observedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  assert.equal(new Date(ledger.observedAt).toISOString(), ledger.observedAt);
  assert.equal(ledger.externalMutationPerformed, false);
  assert.deepEqual(ledger.summary, EXPECTED_COUNTS);
  assert.deepEqual(ledger.prs.map(({ number }) => number), EXPECTED_PRS);
  assert.equal(new Set(ledger.prs.map(({ number }) => number)).size, EXPECTED_PRS.length);

  const computed = { total: ledger.prs.length, merged: 0, closed: 0, current: 0, awaitingDisposition: 0 };
  for (const pr of ledger.prs) {
    assert.ok(["merged", "closed", "current"].includes(pr.disposition), `PR #${pr.number} has no final disposition`);
    computed[pr.disposition] += 1;
    assert.equal(pr.backlogState, "complete", `PR #${pr.number} is still awaiting disposition`);
    assert.match(pr.evidence, /\S/, `PR #${pr.number} has no evidence`);
    assert.match(pr.observedHeadSha, /^[0-9a-f]{40}$/, `PR #${pr.number} head is not pinned`);
    assert.equal(pr.url, `https://github.com/${ledger.repository}/pull/${pr.number}`);
    assert.match(pr.closedAt, /^2026-08-03T/);

    if (pr.disposition === "merged") {
      assert.equal(pr.observedState, "MERGED");
      assert.match(pr.mergedAt, /^2026-08-03T/);
      assert.match(pr.mergeCommitSha, /^[0-9a-f]{40}$/);
    } else if (pr.disposition === "closed") {
      assert.equal(pr.observedState, "CLOSED");
      assert.equal(pr.mergedAt, null);
      assert.equal(pr.mergeCommitSha, null);
    }
  }

  assert.deepEqual(computed, EXPECTED_COUNTS);
  assert.doesNotMatch(JSON.stringify(ledger), /awaiting-disposition/i);
  assert.match(narrative, /10 merged, 10 closed, 0 current, and 0 awaiting disposition/i);
  assert.doesNotMatch(narrative, /awaiting-disposition/i);
  for (const number of EXPECTED_PRS) assert.match(narrative, new RegExp(`\\| ${number} \\|`));
});
