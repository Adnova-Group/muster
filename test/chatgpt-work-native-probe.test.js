import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  buildProbe,
  expectedRequest,
  expectedResult,
  buildIdentity,
  finalizeCleanup,
  gradeReceipt,
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

test("cleanup finalization is a separate second phase requiring verified absence", () => {
  const cleanup = {
    cleanupType: "muster-work-native-cleanup-finalization",
    nonce: NONCE,
    timestamp: TIMESTAMP,
    identity: identity(),
    inventory: { connection: "absent", tunnelProfile: "absent", plugin: "absent", marketplace: "absent", cache: "absent", ui: "absent" },
    artifacts: { tunnel: "stopped", screenshotsRetained: 0, logsRetained: 0, attestationRetained: 0, probeDirsRetained: 0 },
  };
  assert.deepEqual(finalizeCleanup(cleanup, NONCE, identity()), {
    ok: true, phase: "cleanup-finalized", nonce: NONCE,
  });
  cleanup.inventory.plugin = "present";
  assert.equal(finalizeCleanup(cleanup, NONCE, identity()).ok, false);
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

test("CLI emits a run sheet and grades a receipt only with its separate attestation", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "muster-native-probe-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const receiptPath = join(dir, "receipt.json");
  const attestationPath = join(dir, "attestation.json");
  const appPath = join(dir, ".app.json");
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
  ]);
  assert.equal(JSON.parse(result.stdout).ok, true);
});
