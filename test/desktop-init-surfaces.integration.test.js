import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";

import { resolveDesktopHarness } from "../src/desktop-harness.js";
import { canonicalInitJson } from "../src/init.js";
import {
  createNativeInitSurfaceFixture,
  fixtureState,
  runMusterInit,
} from "../test-support/native-init-surface-fixture.js";

const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const fixtureDigest = (surface) => ({
  kind: "file",
  bytes: Buffer.byteLength(`native init fixture: ${surface}\n`),
  sha256: sha256(`native init fixture: ${surface}\n`),
});

function withReceipt(state, receipt) {
  const expected = structuredClone(state);
  expected["project/.muster/init-receipt.json"] = { kind: "json", value: receipt };
  return expected;
}

function handoffReceipt(prepared, contract) {
  const expectedArtifacts = contract.init.expectedArtifacts;
  return {
    receipt: {
      ...prepared.receipt,
      nativeInit: {
        state: "handoff",
        reason: contract.init.reason,
        expectedArtifacts,
        baseline: expectedArtifacts.map((path) => ({ bytes: null, path, sha256: null })),
        attemptId: sha256(canonicalInitJson({
          expectedArtifacts,
          profileDigest: prepared.receipt.profileDigest,
        })),
        handoffAcknowledged: false,
        evidence: null,
      },
    },
    observedNativeEvidence: null,
  };
}

for (const surface of ["chatgpt-desktop", "gpt-work"]) {
  test(`${surface} executes an unavailable native-init handoff with exact receipts and no extra files`, async () => {
    const fixture = await createNativeInitSurfaceFixture(surface);
    assert.deepEqual(await fixtureState(fixture.sandbox), {
      "home/": { kind: "directory" },
      "project/": { kind: "directory" },
      "project/fixture.txt": fixtureDigest(surface),
      "tmp/": { kind: "directory" },
    });
    const prepared = await runMusterInit(fixture, fixture.dir);
    assert.deepEqual(JSON.parse(await readFile(join(fixture.dir, ".muster/init-receipt.json"), "utf8")), prepared.receipt);
    const preparedState = await fixtureState(fixture.sandbox);
    assert.deepEqual(Object.keys(preparedState), [
      "home/", "project/", "project/.muster/", "project/.muster/init-receipt.json",
      "project/.muster/project-profile.json", "project/fixture.txt", "tmp/",
    ]);
    assert.deepEqual(preparedState["project/fixture.txt"], fixtureDigest(surface));

    const contract = resolveDesktopHarness(surface);
    const handoff = await runMusterInit(
      fixture,
      "transition", fixture.dir,
      "--to", contract.init.state,
      "--reason", contract.init.reason,
      "--expect", contract.init.expectedArtifacts.join(","),
    );
    const expectedHandoff = handoffReceipt(prepared, contract);
    assert.deepEqual(handoff, expectedHandoff);
    assert.deepEqual(JSON.parse(await readFile(join(fixture.dir, ".muster/init-receipt.json"), "utf8")), expectedHandoff.receipt);
    assert.deepEqual(await fixtureState(fixture.sandbox), withReceipt(preparedState, expectedHandoff.receipt));

    const acknowledged = await runMusterInit(
      fixture,
      "acknowledge", fixture.dir, "--reason", "unavailable",
    );
    const expectedAcknowledged = {
      receipt: {
        ...expectedHandoff.receipt,
        nativeInit: {
          ...expectedHandoff.receipt.nativeInit,
          handoffAcknowledged: true,
        },
      },
      observedNativeEvidence: null,
    };
    assert.deepEqual(acknowledged, expectedAcknowledged);
    assert.deepEqual(await fixtureState(fixture.sandbox), withReceipt(preparedState, expectedAcknowledged.receipt));
  });
}

test("codex-desktop executes native artifact completion with exact receipts and no extra files", async () => {
  const fixture = await createNativeInitSurfaceFixture("codex-desktop");
  const prepared = await runMusterInit(fixture, fixture.dir);
  const preparedState = await fixtureState(fixture.sandbox);
  assert.deepEqual(Object.keys(preparedState), [
    "home/", "project/", "project/.muster/", "project/.muster/init-receipt.json",
    "project/.muster/project-profile.json", "project/fixture.txt", "tmp/",
  ]);
  assert.deepEqual(preparedState["project/fixture.txt"], fixtureDigest(fixture.surface));

  const contract = resolveDesktopHarness(fixture.surface);
  const handoff = await runMusterInit(
    fixture,
    "transition", fixture.dir,
    "--to", contract.init.state,
    "--reason", contract.init.reason,
    "--expect", contract.init.expectedArtifacts.join(","),
  );
  const expectedHandoff = handoffReceipt(prepared, contract);
  assert.deepEqual(handoff, expectedHandoff);
  assert.deepEqual(await fixtureState(fixture.sandbox), withReceipt(preparedState, expectedHandoff.receipt));

  const nativeArtifact = "# Codex Desktop native instructions\n";
  await writeFile(join(fixture.dir, "AGENTS.md"), nativeArtifact);
  const completed = await runMusterInit(
    fixture,
    "transition", fixture.dir, "--to", "completed", "--evidence", "artifact-delta",
  );
  const expectedCompleted = {
    receipt: {
      ...expectedHandoff.receipt,
      nativeInit: {
        ...expectedHandoff.receipt.nativeInit,
        state: "completed",
        evidence: {
          kind: "artifact-delta",
          artifacts: [{
            after: sha256(nativeArtifact),
            before: null,
            path: "AGENTS.md",
          }],
        },
      },
    },
    observedNativeEvidence: null,
  };
  assert.deepEqual(completed, expectedCompleted);
  assert.deepEqual(JSON.parse(await readFile(join(fixture.dir, ".muster/init-receipt.json"), "utf8")), expectedCompleted.receipt);
  const completedState = withReceipt(preparedState, expectedCompleted.receipt);
  completedState["project/AGENTS.md"] = {
    kind: "file",
    bytes: Buffer.byteLength(nativeArtifact),
    sha256: sha256(nativeArtifact),
  };
  assert.deepEqual(await fixtureState(fixture.sandbox), completedState);
});
