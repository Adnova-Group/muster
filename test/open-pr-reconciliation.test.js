import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const EXPECTED_PRS = [
  145, 146, 147, 148, 149, 150, 151, 152,
  166, 167, 168, 169, 170, 171, 172, 173, 174, 175, 176, 185,
];

const ALLOWED_DISPOSITIONS = new Set([
  "merge",
  "close-with-rationale",
  "active-backlog-owner",
]);

test("open PR reconciliation owns every named PR and leaves none falsely completed", async () => {
  const ledger = JSON.parse(await readFile(
    new URL("../docs/decisions/open-pr-branch-reconciliation.json", import.meta.url),
    "utf8",
  ));

  assert.equal(ledger.itemId, "open-pr-branch-reconciliation");
  assert.equal(ledger.schemaVersion, 2);
  assert.equal(ledger.repository, "Adnova-Group/muster");
  assert.equal(ledger.baseCommit, "248f556c790ff1b9765c053c89a7d7e1669a4419");
  assert.match(ledger.observedAt, /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(ledger.externalMutationPerformed, false);
  assert.equal(ledger.externalActionCoordinator, "dispatcher");
  assert.equal(ledger.externalMutationActor, "human");
  assert.deepEqual(ledger.executionPreconditions, {
    liveHeadShaMustMatchObservedHeadSha: true,
    mergeChecksMustBeGreen: true,
    mergeReviewMustPassAtObservedHeadSha: true,
  });
  assert.deepEqual(ledger.prs.map(({ number }) => number), EXPECTED_PRS);
  assert.equal(new Set(ledger.prs.map(({ number }) => number)).size, EXPECTED_PRS.length);

  for (const pr of ledger.prs) {
    assert.equal(pr.observedState, "OPEN", `PR #${pr.number} observation drifted`);
    assert.equal(pr.backlogState, "awaiting-disposition", `PR #${pr.number} is falsely completed`);
    assert.ok(ALLOWED_DISPOSITIONS.has(pr.proposedDisposition), `PR #${pr.number} has no disposition`);
    assert.match(pr.rationale, /\S/, `PR #${pr.number} has no rationale`);
    assert.match(pr.evidence, /\S/, `PR #${pr.number} has no evidence`);
    assert.match(pr.observedHeadSha, /^[0-9a-f]{40}$/, `PR #${pr.number} head is not pinned`);
    assert.equal(pr.url, `https://github.com/${ledger.repository}/pull/${pr.number}`);
    assert.ok(["success", "not-green", "not-assessed"].includes(pr.checksState));
    assert.ok([
      "pass-at-observed-head",
      "revalidation-required",
      "not-gating-close",
    ].includes(pr.reviewState));
    assert.equal(pr.externalActionCoordinator, "dispatcher", `PR #${pr.number} coordination is unowned`);
    assert.equal(pr.externalMutationActor, "human", `PR #${pr.number} mutation actor is unsafe`);

    if (pr.proposedDisposition === "merge") {
      assert.equal(pr.checksState, "success", `PR #${pr.number} cannot merge without green checks`);
      assert.equal(pr.reviewState, "pass-at-observed-head", `PR #${pr.number} has no exact-head review`);
    }

    if (pr.proposedDisposition === "active-backlog-owner") {
      assert.match(pr.backlogOwner, /^@[a-z0-9-]+$/i, `PR #${pr.number} has no active owner`);
      assert.match(pr.nextAction, /\S/, `PR #${pr.number} has no owned next action`);
    } else {
      assert.equal(pr.backlogOwner, null, `PR #${pr.number} must have exactly one disposition`);
      assert.equal(pr.nextAction, null, `PR #${pr.number} must have exactly one disposition`);
    }
  }
});
