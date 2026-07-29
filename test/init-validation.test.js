import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initializeProject, readInitReceipt } from "../src/init.js";
import { trackedMkdtemp as mkdtemp } from "../test-support/helpers.js";

const tmp = () => mkdtemp(join(tmpdir(), "muster-init-validation-"));

async function assertMutationRejected(mutate, pattern) {
  const dir = await tmp();
  await initializeProject(dir);
  const profilePath = join(dir, ".muster/project-profile.json");
  const receiptPath = join(dir, ".muster/init-receipt.json");
  const profile = JSON.parse(await readFile(profilePath, "utf8"));
  const receipt = JSON.parse(await readFile(receiptPath, "utf8"));
  mutate(profile, receipt);
  await writeFile(profilePath, JSON.stringify(profile));
  await writeFile(receiptPath, JSON.stringify(receipt));
  await assert.rejects(() => readInitReceipt(dir), pattern);
}

const profileCases = [
  ["format", (p) => { p.format = "foreign"; }, /invalid project profile: format \(must be muster\.project-profile\)/],
  ["schemaVersion", (p) => { p.schemaVersion = 2; }, /invalid project profile: schemaVersion \(must be 1\)/],
  ["classification", (p) => { p.classification = "purple"; }, /invalid project profile: classification/],
  ["facts.shape", (p) => { p.facts.shape = "blob"; }, /invalid project profile: facts\.shape/],
  ["facts.frameworks", (p) => { p.facts.frameworks = [""]; }, /invalid project profile: facts\.frameworks/],
  ["facts.manifests", (p) => {
    p.facts.manifests = [{ bytes: 1, path: "x.txt", sha256: "nope" }];
  }, /invalid project profile: facts\.manifests/],
  ["facts.vcs.kind", (p) => { p.facts.vcs.kind = "svn"; }, /invalid project profile: facts\.vcs\.kind/],
  ["repositoryFingerprint.digest", (p) => {
    p.repositoryFingerprint.digest = "zz";
  }, /invalid project profile: repositoryFingerprint\.digest/],
];

for (const [name, mutate, pattern] of profileCases) {
  test(`profile validation names the failing field: ${name}`, async () => {
    await assertMutationRejected((profile) => mutate(profile), pattern);
  });
}

const receiptCases = [
  ["format", (r) => { r.format = "foreign"; }, /invalid init receipt: format \(must be muster\.init-receipt\)/],
  ["schemaVersion", (r) => { r.schemaVersion = 2; }, /invalid init receipt: schemaVersion \(must be 1\)/],
  ["classification", (r) => { r.classification = "purple"; }, /invalid init receipt: classification/],
  ["phase", (r) => { r.phase = "done"; }, /invalid init receipt: phase \(must be prepared or finalized\)/],
  ["profileDigest", (r) => { r.profileDigest = "zz"; }, /invalid init receipt: profileDigest/],
  ["artifacts.created", (r) => {
    r.artifacts.created = ["b.txt", "a.txt"];
  }, /invalid init receipt: artifacts\.created/],
  ["artifacts.skipped", (r) => {
    r.artifacts.skipped = [{ path: "x.txt", reason: "whatever" }];
  }, /invalid init receipt: artifacts\.skipped/],
  ["nativeInit.state", (r) => { r.nativeInit.state = "bogus"; }, /invalid init receipt: nativeInit\.state/],
  ["nativeInit.attemptId", (r) => {
    r.nativeInit.attemptId = "zz";
  }, /invalid init receipt: nativeInit\.attemptId/],
  ["nativeInit.handoffAcknowledged", (r) => {
    r.nativeInit.handoffAcknowledged = "yes";
  }, /invalid init receipt: nativeInit\.handoffAcknowledged/],
  ["nativeInit.evidence.kind", (r) => {
    r.nativeInit.evidence = { artifacts: [{ path: "AGENTS.md", sha256: "0".repeat(64) }], kind: "bogus" };
  }, /invalid init receipt: nativeInit\.evidence\.kind/],
  ["finalStateFingerprint.algorithm", (r) => {
    r.finalStateFingerprint.algorithm = "md5";
  }, /invalid init receipt: finalStateFingerprint\.algorithm/],
  ["inconsistent completed state", (r) => {
    r.nativeInit.state = "completed";
  }, /invalid init receipt: nativeInit \(state is inconsistent/],
];

for (const [name, mutate, pattern] of receiptCases) {
  test(`receipt validation names the failing field: ${name}`, async () => {
    await assertMutationRejected((profile, receipt) => mutate(receipt), pattern);
  });
}

test("unmutated owned init state still validates", async () => {
  const dir = await tmp();
  const { receipt } = await initializeProject(dir);
  assert.deepEqual(await readInitReceipt(dir), receipt);
});
