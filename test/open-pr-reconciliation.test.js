import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

// Every PR this run of open-pr-branch-reconciliation is chartered to own.
const EXPECTED_PRS = [
  145, 146, 147, 148, 149, 150, 151, 152,
  166, 167, 168, 169, 170, 171, 172, 173, 174, 175, 176, 185,
];

const ALLOWED_DISPOSITIONS = new Set([
  "merged",
  "close-with-rationale",
  "active-with-owner",
]);

const EXPECTED_MERGED = [167, 168, 169, 170, 171, 172, 173, 174, 175, 176];
const EXPECTED_CLOSE_WITH_RATIONALE = [145, 146, 147, 148, 149, 150, 151, 152, 166, 185];
const EXPECTED_ACTIVE_WITH_OWNER = [];

// PRs whose promised functionality this reconciliation confirmed is NOT present on
// main under any name, despite the PR itself being terminally closed unmerged --
// a real capability gap, not a clean supersede, and the honest reason a fresh
// backlog item (not this closed PR) must carry the outcome forward.
const EXPECTED_GAP_FLAGGED = [145, 166];

test("open PR reconciliation records one current-state disposition per PR and leaves no open PR unowned", async () => {
  const ledger = JSON.parse(await readFile(
    new URL("../docs/decisions/open-pr-branch-reconciliation.json", import.meta.url),
    "utf8",
  ));
  const narrative = await readFile(
    new URL("../docs/decisions/open-pr-branch-reconciliation.md", import.meta.url),
    "utf8",
  );

  assert.equal(ledger.itemId, "open-pr-branch-reconciliation");
  assert.equal(ledger.schemaVersion, 4);
  assert.equal(ledger.repository, "Adnova-Group/muster");
  assert.equal(ledger.baseCommit, "95b3bf9c2d6c8ffc75469b01b4b0c1ee94679be1");
  assert.match(ledger.observedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  assert.equal(new Date(ledger.observedAt).toISOString(), ledger.observedAt);
  assert.equal(ledger.externalMutationPerformed, false);
  assert.match(ledger.verificationMethod, /\S/);

  // Exactly the 20 named PRs, each appearing exactly once.
  assert.deepEqual(ledger.prs.map(({ number }) => number), EXPECTED_PRS);
  assert.equal(new Set(ledger.prs.map(({ number }) => number)).size, EXPECTED_PRS.length);

  const computed = { total: ledger.prs.length, merged: 0, closeWithRationale: 0, activeWithOwner: 0 };
  const openWithoutOwner = [];

  for (const pr of ledger.prs) {
    assert.ok(ALLOWED_DISPOSITIONS.has(pr.disposition), `PR #${pr.number} has no disposition`);
    if (pr.disposition === "merged") computed.merged += 1;
    else if (pr.disposition === "close-with-rationale") computed.closeWithRationale += 1;
    else if (pr.disposition === "active-with-owner") computed.activeWithOwner += 1;

    assert.match(pr.rationale, /\S/, `PR #${pr.number} has no rationale`);
    assert.match(pr.evidence, /\S/, `PR #${pr.number} has no evidence`);
    assert.match(pr.observedHeadSha, /^[0-9a-f]{40}$/, `PR #${pr.number} head is not pinned`);
    assert.equal(pr.url, `https://github.com/${ledger.repository}/pull/${pr.number}`);
    assert.match(pr.head, /\S/, `PR #${pr.number} has no head branch recorded`);
    assert.ok(["OPEN", "CLOSED", "MERGED"].includes(pr.githubState), `PR #${pr.number} has no valid githubState`);

    // Exactly one disposition: the enum plus its exclusive companion fields.
    if (pr.disposition === "merged") {
      assert.equal(pr.githubState, "MERGED", `PR #${pr.number} disposition/state mismatch`);
      assert.match(pr.mergedAt, /^\d{4}-\d{2}-\d{2}T/, `PR #${pr.number} merged but has no mergedAt`);
      assert.match(pr.mergeCommitSha, /^[0-9a-f]{40}$/, `PR #${pr.number} merged but has no merge commit`);
      assert.equal(pr.mergeCommitReachableFromMain, true, `PR #${pr.number} merge commit not proven reachable from local main`);
      assert.equal(pr.owner, null, `PR #${pr.number} must have exactly one disposition`);
    } else if (pr.disposition === "close-with-rationale") {
      assert.equal(pr.githubState, "CLOSED", `PR #${pr.number} disposition/state mismatch`);
      assert.equal(pr.mergedAt, null, `PR #${pr.number} closed-unmerged but has a mergedAt`);
      assert.equal(pr.mergeCommitSha, null, `PR #${pr.number} closed-unmerged but has a merge commit`);
      assert.equal(pr.owner, null, `PR #${pr.number} must have exactly one disposition`);
    } else if (pr.disposition === "active-with-owner") {
      assert.equal(pr.githubState, "OPEN", `PR #${pr.number} disposition/state mismatch`);
      assert.match(pr.owner, /^@[a-z0-9-]+$/i, `PR #${pr.number} has no active owner`);
    }

    if (pr.githubState === "OPEN" && (pr.disposition !== "active-with-owner" || !pr.owner)) {
      openWithoutOwner.push(pr.number);
    }
  }

  assert.deepEqual(openWithoutOwner, [], "every open PR must have a named owner -- none may be left unowned");
  assert.deepEqual(computed, { total: 20, merged: 10, closeWithRationale: 10, activeWithOwner: 0 });
  assert.deepEqual(ledger.prs.filter(({ disposition }) => disposition === "merged").map(({ number }) => number), EXPECTED_MERGED);
  assert.deepEqual(ledger.prs.filter(({ disposition }) => disposition === "close-with-rationale").map(({ number }) => number), EXPECTED_CLOSE_WITH_RATIONALE);
  assert.deepEqual(ledger.prs.filter(({ disposition }) => disposition === "active-with-owner").map(({ number }) => number), EXPECTED_ACTIVE_WITH_OWNER);

  // Gap-flagged closed-unmerged PRs must say so honestly instead of a silent supersede claim.
  const gapFlagged = ledger.prs.filter(pr => pr.landedOnMain === false).map(({ number }) => number);
  assert.deepEqual(gapFlagged, EXPECTED_GAP_FLAGGED);
  for (const pr of ledger.prs) {
    if (EXPECTED_GAP_FLAGGED.includes(pr.number)) {
      assert.match(pr.rationale, /not (?:present|land|found)|gap|missing/i, `PR #${pr.number} gap must be stated honestly in its rationale`);
    }
  }

  // Narrative must agree with the ledger's counts and per-PR dispositions.
  assert.match(narrative, /10 merged.*10 closed with rationale.*0 active/i);
  for (const number of EXPECTED_MERGED) assert.match(narrative, new RegExp(`\\| ${number} \\| merged \\|`));
  for (const number of EXPECTED_CLOSE_WITH_RATIONALE) assert.match(narrative, new RegExp(`\\| ${number} \\| close-with-rationale \\|`));
});
