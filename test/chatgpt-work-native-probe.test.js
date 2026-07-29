import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import {
  buildProbe,
  expectedRequest,
  expectedResult,
  buildIdentity,
  finalizeCleanup,
  gradeReceipt,
  retainGradeSnapshot,
  sha256,
} from "../scripts/chatgpt-work-native-probe.mjs";

const execFileP = promisify(execFile);
const script = new URL("../scripts/chatgpt-work-native-probe.mjs", import.meta.url).pathname;
const NONCE = "0123456789abcdef0123456789abcdef";
const CONNECTION_ID = "asdk_app_0123456789abcdef";
const APP_HASH = "a".repeat(64);
const TIMESTAMP = "2026-07-29T16:00:00.000Z";

function identity() {
  return {
    connectionIdSha256: sha256(CONNECTION_ID),
    pluginAppSha256: APP_HASH,
    pluginName: "muster",
    pluginVersion: "0.5.0",
    connectionLabel: "Muster ChatGPT Work",
  };
}

function attestation(nonce = NONCE) {
  return {
    attestationType: "muster-work-native-server-attestation",
    source: "server",
    nonce,
    tool: "muster_prioritize",
    request: expectedRequest(nonce),
    result: expectedResult(nonce),
    identity: identity(),
    serverInstanceId: "00000000-0000-4000-8000-000000000000",
    invocationCount: 1,
    timestamp: TIMESTAMP,
  };
}

function receipt(nonce = NONCE) {
  const server = attestation(nonce);
  return {
    receiptType: "operator-attested-native-tool-completed",
    nonce,
    timestamp: TIMESTAMP,
    identity: identity(),
    operatorEvidence: {
      source: "operator-observed-ui",
      mode: "Work",
      surface: "web",
      scanTools: "passed",
      tool: "muster_prioritize",
      status: "completed",
      request: expectedRequest(nonce),
      result: expectedResult(nonce),
    },
    serverEvidence: server,
    inventory: {
      before: { connection: "absent", tunnelProfile: "absent", plugin: "absent", marketplace: "absent", cache: "absent", ui: "absent" },
      during: { connection: "present", tunnelProfile: "present", plugin: "present", marketplace: "present", cache: "present", ui: "present" },
      after: { connection: "present", tunnelProfile: "present", plugin: "present", marketplace: "present", cache: "present", ui: "present" },
      ownership: "probe-owned-only",
      cleanup: "pending-after-evidence-grade",
    },
    artifacts: {
      tunnel: "stopped",
      screenshotsRetained: 0,
      logsRetained: 0,
      attestationRetained: 1,
      probeDirsRetained: 1,
    },
  };
}

test("buildProbe emits a nonce-bearing exact request and the required safety run sheet", () => {
  const appJson = JSON.stringify({ apps: { muster: { id: CONNECTION_ID } } }) + "\n";
  const args = { connectionId: CONNECTION_ID, appJson, pluginVersion: "0.5.0", connectionLabel: "Muster ChatGPT Work" };
  const first = buildProbe(args);
  const second = buildProbe(args);
  assert.match(first.nonce, /^[a-f0-9]{32}$/);
  assert.notEqual(first.nonce, second.nonce);
  assert.deepEqual(first.request, expectedRequest(first.nonce));
  assert.deepEqual(first.expectedResult, expectedResult(first.nonce));
  assert.equal(first.identity.connectionIdSha256, sha256(CONNECTION_ID));
  assert.match(first.instructions.join("\n"), /Scan Tools/i);
  assert.match(first.instructions.join("\n"), /HUMAN-HOLD/i);
  assert.match(first.instructions.join("\n"), /runtime\/chatgpt-work-server\.mjs/);
  assert.match(first.instructions.join("\n"), /MUSTER_CHATGPT_WORK_PROBE_NONCE/);
  assert.match(first.instructions.join("\n"), /MUSTER_CHATGPT_WORK_PROBE_ATTESTATION_PATH/);
  assert.match(first.instructions.join("\n"), /0700/);
  assert.match(first.instructions.join("\n"), /Windows/);
  assert.match(first.instructions.join("\n"), /Windows[\s\S]*always HUMAN-HOLD/i);
  assert.match(first.instructions.join("\n"), /no usable Windows attestation claim/i);
  assert.match(first.instructions.join("\n"), /exact.*nonce.*request/i);
  assert.match(first.instructions.join("\n"), /invocationCount=1/);
  assert.match(first.instructions.join("\n"), /operator attestation, not cryptographic provenance/i);
  assert.match(first.instructions.join("\n"), /Phase 1/);
  assert.match(first.instructions.join("\n"), /Phase 2/);
});

test("grader accepts only two independent matching sources and a clean lifecycle", () => {
  const r = receipt();
  assert.deepEqual(gradeReceipt(r, NONCE, attestation(NONCE), identity()), {
    ok: true, phase: "evidence-graded", cleanupRequired: true,
    nonce: NONCE, receiptType: "operator-attested-native-tool-completed",
  });
});

test("grader uses the schema's strict UUID expression and Windows cannot produce a usable claim", () => {
  const malformed = attestation();
  malformed.serverInstanceId = "00000000-0000-0000-0000-000000000000";
  const withMalformed = receipt();
  withMalformed.serverEvidence = malformed;
  assert.equal(gradeReceipt(withMalformed, NONCE, malformed, identity()).ok, false);
  assert.match(gradeReceipt(receipt(), NONCE, attestation(), identity(), "win32").errors.join("\n"), /HUMAN-HOLD.*Windows/i);
});

test("cleanup finalization is bound to a successful retained grade and deletes the exact retained directories", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "muster-native-cleanup-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const retainedDir = join(root, "retained");
  const pluginPath = join(root, "plugin");
  const tempPath = join(root, "probe-temp");
  const snapshotPath = join(retainedDir, "grade-snapshot.json");
  await Promise.all([mkdir(retainedDir, { mode: 0o700 }), mkdir(pluginPath), mkdir(tempPath)]);
  await chmod(retainedDir, 0o700);
  const grade = gradeReceipt(receipt(), NONCE, attestation(), identity());
  const retained = await retainGradeSnapshot({
    grade, nonce: NONCE, identity: identity(), serverAttestation: attestation(),
    ownedPaths: { plugin: pluginPath, temp: tempPath }, snapshotPath,
  });
  assert.equal(retained.ok, true);
  assert.match(retained.gradeDigest, /^[a-f0-9]{64}$/);
  const snapshot = JSON.parse(await readFile(snapshotPath, "utf8"));
  assert.equal(snapshot.ownedPaths.plugin, pluginPath);
  assert.equal(snapshot.serverAttestation.serverInstanceId, attestation().serverInstanceId);

  const cleanup = {
    cleanupType: "muster-work-native-cleanup-finalization",
    timestamp: TIMESTAMP,
    gradeDigest: retained.gradeDigest,
    ownedPaths: { plugin: pluginPath, temp: tempPath },
    inventory: { connection: "absent", tunnelProfile: "absent", plugin: "absent", marketplace: "absent", cache: "absent", ui: "absent" },
    artifacts: { tunnel: "stopped", screenshotsRetained: 0, logsRetained: 0, attestationRetained: 0, probeDirsRetained: 0 },
  };
  assert.deepEqual(await finalizeCleanup(cleanup, snapshot), {
    ok: true, phase: "cleanup-finalized", nonce: NONCE, gradeDigest: retained.gradeDigest,
  });
  await assert.rejects(lstat(pluginPath), { code: "ENOENT" });
  await assert.rejects(lstat(tempPath), { code: "ENOENT" });
  cleanup.inventory.plugin = "present";
  assert.equal((await finalizeCleanup(cleanup, snapshot)).ok, false);
});

test("cleanup rejects tampered grades, path mismatches, symlinks, and unowned-or-present replacements", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "muster-native-cleanup-reject-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const retainedDir = join(root, "retained");
  const pluginPath = join(root, "plugin");
  const tempPath = join(root, "probe-temp");
  const snapshotPath = join(retainedDir, "grade-snapshot.json");
  await Promise.all([mkdir(retainedDir, { mode: 0o700 }), mkdir(pluginPath), mkdir(tempPath)]);
  await chmod(retainedDir, 0o700);
  const retained = await retainGradeSnapshot({
    grade: gradeReceipt(receipt(), NONCE, attestation(), identity()),
    nonce: NONCE, identity: identity(), serverAttestation: attestation(),
    ownedPaths: { plugin: pluginPath, temp: tempPath }, snapshotPath,
  });
  const snapshot = JSON.parse(await readFile(snapshotPath, "utf8"));
  const cleanup = {
    cleanupType: "muster-work-native-cleanup-finalization", timestamp: TIMESTAMP,
    gradeDigest: retained.gradeDigest, ownedPaths: { plugin: pluginPath, temp: tempPath },
    inventory: { connection: "absent", tunnelProfile: "absent", plugin: "absent", marketplace: "absent", cache: "absent", ui: "absent" },
    artifacts: { tunnel: "stopped", screenshotsRetained: 0, logsRetained: 0, attestationRetained: 0, probeDirsRetained: 0 },
  };
  const tampered = structuredClone(snapshot);
  tampered.grade.ok = false;
  assert.match((await finalizeCleanup(cleanup, tampered)).errors.join("\n"), /digest|successful phase 1/i);
  const mismatch = structuredClone(cleanup);
  mismatch.ownedPaths.plugin = join(root, "other");
  assert.match((await finalizeCleanup(mismatch, snapshot)).errors.join("\n"), /path mismatch/i);
  const renamedPlugin = join(root, "renamed-plugin");
  await rename(pluginPath, renamedPlugin);
  assert.match((await finalizeCleanup(cleanup, snapshot)).errors.join("\n"), /present.*identity-checked deletion.*moved/i);
  await rename(renamedPlugin, pluginPath);
  const nestedUnderTemp = join(tempPath, "nested-plugin");
  await rename(pluginPath, nestedUnderTemp);
  assert.match((await finalizeCleanup(cleanup, snapshot)).errors.join("\n"), /present.*identity-checked deletion.*moved/i);
  await rename(nestedUnderTemp, pluginPath);
  const sibling = join(root, "sibling");
  const nestedPlugin = join(sibling, "nested-plugin");
  await mkdir(sibling);
  await rename(pluginPath, nestedPlugin);
  assert.match((await finalizeCleanup(cleanup, snapshot)).errors.join("\n"), /present.*identity-checked deletion.*moved/i);
  await rename(nestedPlugin, pluginPath);
  await rm(pluginPath, { recursive: true });
  await symlink(join(root, "missing-target"), pluginPath);
  assert.match((await finalizeCleanup(cleanup, snapshot)).errors.join("\n"), /symlink/i);

  const realOwned = join(root, "real-owned");
  const alias = join(root, "owned-alias");
  await Promise.all([
    mkdir(join(realOwned, "plugin"), { recursive: true }),
    mkdir(join(realOwned, "temp"), { recursive: true }),
  ]);
  await symlink(realOwned, alias);
  const aliased = await retainGradeSnapshot({
    grade: gradeReceipt(receipt(), NONCE, attestation(), identity()),
    nonce: NONCE,
    identity: identity(),
    serverAttestation: attestation(),
    ownedPaths: { plugin: join(alias, "plugin"), temp: join(alias, "temp") },
    snapshotPath: join(retainedDir, "aliased-snapshot.json"),
  });
  assert.equal(aliased.ok, false);
  assert.match(aliased.errors.join("\n"), /traverse a symlink/i);
});

test("cleanup rejects a pathname swap between inspection and quarantine without deleting either retained inode", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "muster-native-cleanup-race-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const retainedDir = join(root, "retained");
  const pluginPath = join(root, "plugin");
  const tempPath = join(root, "probe-temp");
  const movedTemp = join(root, "moved-temp");
  const snapshotPath = join(retainedDir, "grade-snapshot.json");
  await Promise.all([mkdir(retainedDir, { mode: 0o700 }), mkdir(pluginPath), mkdir(tempPath)]);
  await chmod(retainedDir, 0o700);
  const retained = await retainGradeSnapshot({
    grade: gradeReceipt(receipt(), NONCE, attestation(), identity()),
    nonce: NONCE, identity: identity(), serverAttestation: attestation(),
    ownedPaths: { plugin: pluginPath, temp: tempPath }, snapshotPath,
  });
  const snapshot = JSON.parse(await readFile(snapshotPath, "utf8"));
  const cleanup = {
    cleanupType: "muster-work-native-cleanup-finalization", timestamp: TIMESTAMP,
    gradeDigest: retained.gradeDigest, ownedPaths: { plugin: pluginPath, temp: tempPath },
    inventory: { connection: "absent", tunnelProfile: "absent", plugin: "absent", marketplace: "absent", cache: "absent", ui: "absent" },
    artifacts: { tunnel: "stopped", screenshotsRetained: 0, logsRetained: 0, attestationRetained: 0, probeDirsRetained: 0 },
  };
  const result = await finalizeCleanup(cleanup, snapshot, {
    beforeQuarantine: async () => {
      await rename(tempPath, movedTemp);
      await mkdir(tempPath);
    },
  });
  assert.equal(result.ok, false);
  assert.match(result.errors.join("\n"), /identity changed.*quarantine/i);
  assert.equal((await lstat(pluginPath)).ino, Number(snapshot.ownership.plugin.ino));
  assert.equal((await lstat(movedTemp)).ino, Number(snapshot.ownership.temp.ino));
});

test("cleanup quarantines each retained directory on its own parent filesystem", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "muster-native-cleanup-volumes-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const pluginParent = join(root, "plugin-parent");
  const tempParent = join(root, "temp-parent");
  const retainedDir = join(root, "retained");
  const pluginPath = join(pluginParent, "plugin");
  const tempPath = join(tempParent, "probe-temp");
  const snapshotPath = join(retainedDir, "grade-snapshot.json");
  await Promise.all([
    mkdir(pluginPath, { recursive: true }),
    mkdir(tempPath, { recursive: true }),
    mkdir(retainedDir, { mode: 0o700 }),
  ]);
  await chmod(retainedDir, 0o700);
  const retained = await retainGradeSnapshot({
    grade: gradeReceipt(receipt(), NONCE, attestation(), identity()),
    nonce: NONCE, identity: identity(), serverAttestation: attestation(),
    ownedPaths: { plugin: pluginPath, temp: tempPath }, snapshotPath,
  });
  const snapshot = JSON.parse(await readFile(snapshotPath, "utf8"));
  const cleanup = {
    cleanupType: "muster-work-native-cleanup-finalization", timestamp: TIMESTAMP,
    gradeDigest: retained.gradeDigest, ownedPaths: { plugin: pluginPath, temp: tempPath },
    inventory: { connection: "absent", tunnelProfile: "absent", plugin: "absent", marketplace: "absent", cache: "absent", ui: "absent" },
    artifacts: { tunnel: "stopped", screenshotsRetained: 0, logsRetained: 0, attestationRetained: 0, probeDirsRetained: 0 },
  };
  let renameCount = 0;
  const result = await finalizeCleanup(cleanup, snapshot, {
    renameDirectory: async (source, destination) => {
      renameCount += 1;
      assert.equal(dirname(destination), dirname(source), "quarantine move must stay within the retained parent filesystem");
      await rename(source, destination);
    },
  });
  assert.equal(result.ok, true);
  assert.equal(renameCount, 2);
});

test("cleanup cannot report success after an intermediate quarantine root is replaced by a symlink", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "muster-native-cleanup-root-swap-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const retainedDir = join(root, "retained");
  const pluginPath = join(root, "plugin");
  const tempPath = join(root, "probe-temp");
  const redirectTarget = join(root, "redirect-target");
  const movedQuarantine = join(root, "moved-quarantine");
  const snapshotPath = join(retainedDir, "grade-snapshot.json");
  await Promise.all([
    mkdir(retainedDir, { mode: 0o700 }),
    mkdir(pluginPath),
    mkdir(tempPath),
    mkdir(redirectTarget),
  ]);
  await chmod(retainedDir, 0o700);
  const retained = await retainGradeSnapshot({
    grade: gradeReceipt(receipt(), NONCE, attestation(), identity()),
    nonce: NONCE, identity: identity(), serverAttestation: attestation(),
    ownedPaths: { plugin: pluginPath, temp: tempPath }, snapshotPath,
  });
  const snapshot = JSON.parse(await readFile(snapshotPath, "utf8"));
  const cleanup = {
    cleanupType: "muster-work-native-cleanup-finalization", timestamp: TIMESTAMP,
    gradeDigest: retained.gradeDigest, ownedPaths: { plugin: pluginPath, temp: tempPath },
    inventory: { connection: "absent", tunnelProfile: "absent", plugin: "absent", marketplace: "absent", cache: "absent", ui: "absent" },
    artifacts: { tunnel: "stopped", screenshotsRetained: 0, logsRetained: 0, attestationRetained: 0, probeDirsRetained: 0 },
  };
  const result = await finalizeCleanup(cleanup, snapshot, {
    beforeQuarantine: async () => {
      const roots = (await readdir(root)).filter(name => name.startsWith(".muster-cleanup-"));
      assert.equal(roots.length, 1);
      const quarantineRoot = join(root, roots[0]);
      await rename(quarantineRoot, movedQuarantine);
      await symlink(redirectTarget, quarantineRoot);
    },
  });
  assert.equal(result.ok, false);
});

test("phase 1 rejects group/world-writable retained parent namespaces", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "muster-native-cleanup-writable-parent-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const retainedDir = join(root, "retained");
  const pluginPath = join(root, "plugin");
  const tempPath = join(root, "probe-temp");
  await Promise.all([
    mkdir(retainedDir, { mode: 0o700 }),
    mkdir(pluginPath),
    mkdir(tempPath),
  ]);
  await chmod(retainedDir, 0o700);
  await chmod(root, 0o777);
  const retained = await retainGradeSnapshot({
    grade: gradeReceipt(receipt(), NONCE, attestation(), identity()),
    nonce: NONCE, identity: identity(), serverAttestation: attestation(),
    ownedPaths: { plugin: pluginPath, temp: tempPath },
    snapshotPath: join(retainedDir, "grade-snapshot.json"),
  });
  assert.equal(retained.ok, false);
  assert.match(retained.errors.join("\n"), /parent.*group\/world-writable/i);
});

test("identity binding hashes the normalized connection ID and exact installed app bytes", () => {
  const appJson = '{"apps":{"muster":{"id":"asdk_app_0123456789abcdef"}}}\n';
  const bound = buildIdentity({ connectionId: "plugin_asdk_app_0123456789abcdef", appJson, pluginVersion: "0.5.0", connectionLabel: "Muster ChatGPT Work" });
  assert.equal(bound.connectionIdSha256, sha256(CONNECTION_ID));
  assert.equal(bound.pluginAppSha256, sha256(appJson));
  assert.throws(() => buildIdentity({
    connectionId: CONNECTION_ID,
    appJson: '{"apps":{"muster":{"id":"asdk_app_wrong"}}}',
    pluginVersion: "0.5.0",
    connectionLabel: "Muster ChatGPT Work",
  }), /shape.*match/i);
});

test("grader rejects missing separate attestation, prose, wrong tool, or mismatched request/result", () => {
  assert.equal(gradeReceipt(receipt(), NONCE).ok, false);
  for (const mutate of [
    (r) => { r.operatorEvidence.source = "assistant-prose"; },
    (r) => { r.operatorEvidence.mode = "Codex"; },
    (r) => { r.operatorEvidence.status = "started"; },
    (r) => { r.operatorEvidence.tool = "tools/list"; },
    (r) => { r.operatorEvidence.request.items[0].name = "other"; },
    (r) => { r.serverEvidence.invocationCount = 2; },
    (r) => { r.serverEvidence.tool = "tools/list"; },
    (r) => { r.serverEvidence.result[0].rank = 2; },
  ]) {
    const copy = structuredClone(receipt());
    mutate(copy);
    assert.equal(gradeReceipt(copy, NONCE, attestation(NONCE), identity()).ok, false);
  }
});

test("grader binds identity hashes and rejects collisions, incomplete cleanup, retained artifacts, and secret-like fields", () => {
  for (const [label, mutate] of [
    ["connection hash", (r) => { r.identity.connectionIdSha256 = "b".repeat(64); }],
    ["app hash", (r) => { r.identity.pluginAppSha256 = "b".repeat(64); }],
    ["version", (r) => { r.identity.pluginVersion = ""; }],
    ["before", (r) => { r.inventory.before.connection = "present"; }],
    ["during", (r) => { r.inventory.during.plugin = "absent"; }],
    ["after", (r) => { r.inventory.after.cache = "absent"; }],
    ["collision", (r) => { r.inventory.cleanup = "collision"; }],
    ["tunnel", (r) => { r.artifacts.tunnel = "running"; }],
    ["attestation", (r) => { r.artifacts.attestationRetained = 0; }],
    ["tunnel id", (r) => { r.tunnelId = "tunnel_secret"; }],
    ["api key", (r) => { r.apiKey = "sk-secret"; }],
    ["screenshot", (r) => { r.operatorEvidence.screenshotPath = "/tmp/proof.png"; }],
  ]) {
    const copy = structuredClone(receipt());
    mutate(copy);
    assert.equal(gradeReceipt(copy, NONCE, attestation(NONCE), identity()).ok, false, label);
  }
});

test("CLI retains phase-1 identity/evidence and identity-checks deletion during finalization", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "muster-native-probe-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const receiptPath = join(dir, "receipt.json");
  const pluginPath = join(dir, "owned-plugin");
  const tempPath = join(dir, "owned-temp");
  const retainedDir = join(dir, "retained");
  const attestationPath = join(tempPath, "server-attestation.json");
  const appPath = join(pluginPath, ".app.json");
  const snapshotPath = join(retainedDir, "grade-snapshot.json");
  const cleanupPath = join(dir, "cleanup.json");
  await Promise.all([mkdir(pluginPath), mkdir(tempPath), mkdir(retainedDir, { mode: 0o700 })]);
  await chmod(retainedDir, 0o700);
  const appJson = '{"apps":{"muster":{"id":"asdk_app_0123456789abcdef"}}}\n';
  const proofReceipt = receipt();
  proofReceipt.identity.pluginAppSha256 = sha256(appJson);
  proofReceipt.serverEvidence.identity.pluginAppSha256 = sha256(appJson);
  const proofAttestation = attestation();
  proofAttestation.identity.pluginAppSha256 = sha256(appJson);
  await writeFile(receiptPath, JSON.stringify(proofReceipt));
  await writeFile(attestationPath, JSON.stringify(proofAttestation));
  await writeFile(appPath, appJson);
  await assert.rejects(execFileP(process.execPath, [script], { cwd: dir }), error => {
    assert.equal(error.code, 2);
    assert.match(error.stderr, /requires real/);
    return true;
  });
  const generated = JSON.parse((await execFileP(process.execPath, [
    script, "--connection-id", CONNECTION_ID, "--app-json", appPath,
    "--plugin-version", "0.5.0", "--connection-label", "Muster ChatGPT Work",
  ], { cwd: dir })).stdout);
  assert.equal(generated.schemaVersion, 2);
  await assert.rejects(
    execFileP(process.execPath, [script, "--grade", receiptPath, "--nonce", NONCE, "--server-attestation", attestationPath]),
    (error) => {
      assert.equal(error.code, 2);
      assert.match(error.stderr, /identity inputs must be used together/);
      return true;
    },
  );
  const result = await execFileP(process.execPath, [
    script,
    "--grade", receiptPath,
    "--nonce", NONCE,
    "--server-attestation", attestationPath,
    "--connection-id", CONNECTION_ID,
    "--app-json", appPath,
    "--plugin-version", "0.5.0",
    "--connection-label", "Muster ChatGPT Work",
    "--snapshot-out", snapshotPath,
    "--owned-plugin-path", pluginPath,
    "--owned-temp-path", tempPath,
  ]);
  const grade = JSON.parse(result.stdout);
  assert.equal(grade.ok, true);
  assert.equal(grade.snapshotPath, snapshotPath);
  await writeFile(cleanupPath, JSON.stringify({
    cleanupType: "muster-work-native-cleanup-finalization",
    timestamp: TIMESTAMP,
    gradeDigest: grade.gradeDigest,
    ownedPaths: { plugin: pluginPath, temp: tempPath },
    inventory: { connection: "absent", tunnelProfile: "absent", plugin: "absent", marketplace: "absent", cache: "absent", ui: "absent" },
    artifacts: { tunnel: "stopped", screenshotsRetained: 0, logsRetained: 0, attestationRetained: 0, probeDirsRetained: 0 },
  }));
  const finalized = await execFileP(process.execPath, [
    script, "--finalize-cleanup", cleanupPath, "--grade-snapshot", snapshotPath,
  ]);
  assert.equal(JSON.parse(finalized.stdout).ok, true);
});
