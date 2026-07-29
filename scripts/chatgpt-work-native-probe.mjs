#!/usr/bin/env node

/*
 * A proof contract for the ChatGPT Work host loop.  This script does not drive
 * ChatGPT, create a tunnel, or infer a native invocation from a transcript. It
 * emits a nonce-bound run sheet and grades two independently produced records:
 * the operator's observation of a completed Work tool card and an attestation
 * emitted by the local MCP server.  Keep the two sources separate.
 */

import { createHash, randomBytes } from "node:crypto";
import { lstat, open, readFile, realpath } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";

const NONCE_PATTERN = /^[a-f0-9]{32}$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const CONNECTION_ID_PATTERN = /^asdk_app_[A-Za-z0-9][A-Za-z0-9_-]*$/;
const PLUGIN_NAME = "muster";
const PLUGIN_VERSION_PATTERN = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;
const TOOL = "muster_prioritize";
const RECEIPT_TYPE = "operator-attested-native-tool-completed";
const ATTESTATION_TYPE = "muster-work-native-server-attestation";
const SNAPSHOT_TYPE = "muster-work-native-retained-grade";
const CLEANUP_TYPE = "muster-work-native-cleanup-finalization";
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const REQUEST_KEYS = ["items", "model"];
const ITEM_KEYS = ["name", "reach", "impact", "confidence", "effort"];
const RESULT_KEYS = [...ITEM_KEYS, "score", "rank"];

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

function exactKeys(value, keys, at, errors) {
  if (!isRecord(value)) {
    errors.push(`${at} must be an object`);
    return false;
  }
  const expected = new Set(keys);
  for (const key of Object.keys(value)) {
    if (!expected.has(key)) errors.push(`unknown field ${at}.${key}`);
  }
  for (const key of keys) {
    if (!Object.hasOwn(value, key)) errors.push(`missing field ${at}.${key}`);
  }
  return true;
}

function exactValue(actual, expected, at, errors) {
  if (actual !== expected) errors.push(`${at} must equal the probe value`);
}

function normalizedConnectionId(value) {
  if (typeof value !== "string") throw new Error("connection id is required");
  const id = value.startsWith("plugin_") ? value.slice("plugin_".length) : value;
  if (!CONNECTION_ID_PATTERN.test(id)) {
    throw new Error("connection id must match asdk_app_<id>");
  }
  return id;
}

export function sha256(value) {
  return createHash("sha256").update(String(value), "utf8").digest("hex");
}

export function buildIdentity({ connectionId, appJson, pluginVersion, connectionLabel }) {
  const normalizedId = normalizedConnectionId(connectionId);
  if (!PLUGIN_VERSION_PATTERN.test(pluginVersion ?? "")) throw new Error("pluginVersion must be semver-like");
  if (typeof connectionLabel !== "string" || connectionLabel.length === 0) throw new Error("connectionLabel is required");
  let app;
  try { app = JSON.parse(appJson); } catch { throw new Error("appJson must be valid JSON"); }
  if (JSON.stringify(app) !== JSON.stringify({ apps: { muster: { id: normalizedId } } })) {
    throw new Error("appJson must have the exact apps.muster.id shape and match the connection id");
  }
  return {
    connectionIdSha256: sha256(normalizedId),
    pluginAppSha256: sha256(appJson),
    pluginName: PLUGIN_NAME,
    pluginVersion,
    connectionLabel,
  };
}

export function expectedRequest(nonce) {
  return {
    items: [{
      name: `WORK_WEB_PROBE_${nonce}`,
      reach: 2,
      impact: 3,
      confidence: 1,
      effort: 2,
    }],
    model: "rice",
  };
}

export function expectedResult(nonce) {
  return [{
    ...expectedRequest(nonce).items[0],
    score: 3,
    rank: 1,
  }];
}

export function buildProbe({
  connectionId, appJson, pluginVersion, connectionLabel,
} = {}) {
  const identity = buildIdentity({ connectionId, appJson, pluginVersion, connectionLabel });
  const nonce = randomBytes(16).toString("hex");
  return {
    schemaVersion: 2,
    nonce,
    request: expectedRequest(nonce),
    expectedResult: expectedResult(nonce),
    identity,
    instructions: [
      "Run only in ChatGPT Work (web or the ChatGPT desktop app with Work selected); Codex Desktop is a separate surface.",
      "Complete the native Pro Scan Tools gate first. If it does not pass, record HUMAN-HOLD and do not claim Pro support.",
      "Preflight independent inventories for the connection, tunnel profile, plugin, marketplace, cache, and UI artifacts. A collision with any existing name is HUMAN-HOLD; do not modify it.",
      "Use Secure MCP Tunnel with an outbound-only tunnel-client and the local STDIO command: node runtime/chatgpt-work-server.mjs.",
      "For the proof server, set MUSTER_CHATGPT_WORK_PROFILE=pro-safe, MUSTER_CHATGPT_WORK_PROBE_NONCE=<nonce>, and MUSTER_CHATGPT_WORK_PROBE_ATTESTATION_PATH=<absolute existing private probe-dir>/server-attestation.json; the target must not already exist.",
      "The probe directory must be current-user-owned and mode 0700 on POSIX; the new attestation is 0600, and any collision is HUMAN-HOLD.",
      "Windows native proof is always HUMAN-HOLD: there is no usable Windows attestation claim.",
      "Call muster_prioritize exactly once with the exact nonce-bearing request. Operator evidence must be a completed native Work tool card, not assistant prose, skill discovery, tools/list, or tunnel health.",
      "The server must emit a separate nonce/tool/request/result attestation with invocationCount=1 and a server timestamp. UI evidence is operator attestation, not cryptographic provenance.",
      "Bind the receipt to SHA-256(normalized connection ID), SHA-256(installed .app.json), plugin name/version, and the registered connection label; never store the raw ID, app file, tunnel ID, API key, or screenshots.",
      "Phase 1: while the independent server attestation and installed .app.json still exist, grade the operator receipt and write a private retained snapshot outside the owned plugin/temp trees. The snapshot binds the successful grade, exact owned paths, app identity/hash, nonce, and server attestation with an evidence-grade SHA-256 digest.",
      "Phase 2 only after evidence grade succeeds: stop tunnel-client, delete only the exact snapshot-bound plugin/temp paths after ownership checks, re-run every inventory, and finalize from the retained snapshot. Phase 2 independently lstat-checks absence and rejects path mismatches, symlinks, and unowned replacements; it never depends on the deleted .app.json.",
    ],
  };
}

function validateTimestamp(value, at, errors) {
  const parsed = typeof value === "string" ? new Date(value) : null;
  if (!parsed || !Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) {
    errors.push(`${at} must be a normalized ISO timestamp`);
  }
}

function validateRequest(value, nonce, at, errors) {
  if (!exactKeys(value, REQUEST_KEYS, at, errors)) return;
  if (!Array.isArray(value.items) || value.items.length !== 1) {
    errors.push(`${at}.items must contain exactly one item`);
  } else {
    if (!exactKeys(value.items[0], ITEM_KEYS, `${at}.items[0]`, errors)) return;
    const expected = expectedRequest(nonce).items[0];
    for (const key of ITEM_KEYS) exactValue(value.items[0][key], expected[key], `${at}.items[0].${key}`, errors);
  }
  exactValue(value.model, "rice", `${at}.model`, errors);
}

function validateResult(value, nonce, at, errors) {
  if (!Array.isArray(value) || value.length !== 1) {
    errors.push(`${at} must contain exactly one item`);
    return;
  }
  if (!exactKeys(value[0], RESULT_KEYS, `${at}[0]`, errors)) return;
  const expected = expectedResult(nonce)[0];
  for (const key of RESULT_KEYS) exactValue(value[0][key], expected[key], `${at}[0].${key}`, errors);
}

function validateIdentity(value, expected, errors) {
  const keys = ["connectionIdSha256", "pluginAppSha256", "pluginName", "pluginVersion", "connectionLabel"];
  if (!exactKeys(value, keys, "receipt.identity", errors)) return;
  if (!SHA256_PATTERN.test(value.connectionIdSha256 ?? "")) errors.push("receipt.identity.connectionIdSha256 must be SHA-256 hex");
  if (!SHA256_PATTERN.test(value.pluginAppSha256 ?? "")) errors.push("receipt.identity.pluginAppSha256 must be SHA-256 hex");
  exactValue(value.connectionIdSha256, expected.connectionIdSha256, "receipt.identity.connectionIdSha256", errors);
  exactValue(value.pluginAppSha256, expected.pluginAppSha256, "receipt.identity.pluginAppSha256", errors);
  exactValue(value.pluginName, PLUGIN_NAME, "receipt.identity.pluginName", errors);
  if (!PLUGIN_VERSION_PATTERN.test(value.pluginVersion ?? "")) errors.push("receipt.identity.pluginVersion must be semver-like");
  exactValue(value.pluginVersion, expected.pluginVersion, "receipt.identity.pluginVersion", errors);
  exactValue(value.connectionLabel, expected.connectionLabel, "receipt.identity.connectionLabel", errors);
}

function validateModeEvidence(value, errors) {
  if (!exactKeys(value, ["source", "mode", "surface", "scanTools", "tool", "status", "request", "result"], "receipt.operatorEvidence", errors)) return;
  exactValue(value.source, "operator-observed-ui", "receipt.operatorEvidence.source", errors);
  exactValue(value.mode, "Work", "receipt.operatorEvidence.mode", errors);
  if (!["web", "desktop"].includes(value.surface)) errors.push("receipt.operatorEvidence.surface must be web or desktop");
  exactValue(value.scanTools, "passed", "receipt.operatorEvidence.scanTools", errors);
  exactValue(value.tool, TOOL, "receipt.operatorEvidence.tool", errors);
  exactValue(value.status, "completed", "receipt.operatorEvidence.status", errors);
}

function validateAttestation(value, nonce, at, errors, expectedIdentity) {
  if (!exactKeys(value, ["attestationType", "source", "nonce", "tool", "request", "result", "identity", "serverInstanceId", "invocationCount", "timestamp"], at, errors)) return;
  exactValue(value.attestationType, ATTESTATION_TYPE, `${at}.attestationType`, errors);
  exactValue(value.source, "server", `${at}.source`, errors);
  exactValue(value.nonce, nonce, `${at}.nonce`, errors);
  if (!NONCE_PATTERN.test(value.nonce ?? "")) errors.push(`${at}.nonce must be lowercase hexadecimal`);
  exactValue(value.tool, TOOL, `${at}.tool`, errors);
  validateRequest(value.request, nonce, `${at}.request`, errors);
  validateResult(value.result, nonce, `${at}.result`, errors);
  validateIdentity(value.identity, expectedIdentity, errors);
  if (!UUID_PATTERN.test(value.serverInstanceId ?? "")) errors.push(`${at}.serverInstanceId must be a UUID`);
  exactValue(value.invocationCount, 1, `${at}.invocationCount`, errors);
  validateTimestamp(value.timestamp, `${at}.timestamp`, errors);
}

function expectedInventory(phase) {
  const state = phase === "during" ? "present" : "absent";
  return {
    connection: state,
    tunnelProfile: state,
    plugin: state,
    marketplace: state,
    cache: state,
    ui: state,
  };
}

function validateInventory(value, errors) {
  if (!exactKeys(value, ["before", "during", "after", "ownership", "cleanup"], "receipt.inventory", errors)) return;
  for (const phase of ["before", "during"]) {
    const at = `receipt.inventory.${phase}`;
    if (!exactKeys(value[phase], Object.keys(expectedInventory(phase)), at, errors)) continue;
    for (const [key, expected] of Object.entries(expectedInventory(phase))) exactValue(value[phase][key], expected, `${at}.${key}`, errors);
  }
  exactValue(value.ownership, "probe-owned-only", "receipt.inventory.ownership", errors);
  for (const [key, expected] of Object.entries(expectedInventory("during"))) exactValue(value.after[key], expected, `receipt.inventory.after.${key}`, errors);
  exactValue(value.cleanup, "pending-after-evidence-grade", "receipt.inventory.cleanup", errors);
}

function validateArtifacts(value, errors) {
  if (!exactKeys(value, ["tunnel", "screenshotsRetained", "logsRetained", "attestationRetained", "probeDirsRetained"], "receipt.artifacts", errors)) return;
  exactValue(value.tunnel, "stopped", "receipt.artifacts.tunnel", errors);
  for (const key of ["screenshotsRetained", "logsRetained"]) exactValue(value[key], 0, `receipt.artifacts.${key}`, errors);
  exactValue(value.attestationRetained, 1, "receipt.artifacts.attestationRetained", errors);
  exactValue(value.probeDirsRetained, 1, "receipt.artifacts.probeDirsRetained", errors);
}

export function gradeReceipt(receipt, nonce, serverAttestation, expectedIdentity = null, platform = process.platform) {
  if (platform === "win32") return { ok: false, errors: ["HUMAN-HOLD: Windows native proof has no usable attestation claim"] };
  if (!NONCE_PATTERN.test(nonce ?? "")) return { ok: false, errors: ["expected nonce must be 32 lowercase hexadecimal characters"] };
  if (!expectedIdentity) return { ok: false, errors: ["expected identity is required"] };
  const errors = [];
  const keys = ["receiptType", "nonce", "timestamp", "identity", "operatorEvidence", "serverEvidence", "inventory", "artifacts"];
  if (!exactKeys(receipt, keys, "receipt", errors)) return { ok: false, errors };
  exactValue(receipt.receiptType, RECEIPT_TYPE, "receipt.receiptType", errors);
  exactValue(receipt.nonce, nonce, "receipt.nonce", errors);
  validateTimestamp(receipt.timestamp, "receipt.timestamp", errors);
  validateIdentity(receipt.identity, expectedIdentity || receipt.identity, errors);
  validateModeEvidence(receipt.operatorEvidence, errors);
  validateRequest(receipt.operatorEvidence?.request, nonce, "receipt.operatorEvidence.request", errors);
  validateResult(receipt.operatorEvidence?.result, nonce, "receipt.operatorEvidence.result", errors);
  validateAttestation(receipt.serverEvidence, nonce, "receipt.serverEvidence", errors, expectedIdentity);
  if (!serverAttestation) errors.push("a separate server attestation is required");
  else {
    validateAttestation(serverAttestation, nonce, "serverAttestation", errors, expectedIdentity);
    if (JSON.stringify(receipt.serverEvidence) !== JSON.stringify(serverAttestation)) errors.push("serverEvidence must exactly match the separate server attestation");
  }
  if (JSON.stringify(receipt.operatorEvidence?.request) !== JSON.stringify(receipt.serverEvidence?.request)) errors.push("operator and server requests must match exactly");
  if (JSON.stringify(receipt.operatorEvidence?.result) !== JSON.stringify(receipt.serverEvidence?.result)) errors.push("operator and server results must match exactly");
  validateInventory(receipt.inventory, errors);
  validateArtifacts(receipt.artifacts, errors);
  return errors.length ? { ok: false, errors } : { ok: true, phase: "evidence-graded", cleanupRequired: true, nonce, receiptType: RECEIPT_TYPE };
}

function exactAbsolutePath(value, at, errors) {
  if (typeof value !== "string" || !isAbsolute(value) || resolve(value) !== value) {
    errors.push(`${at} must be an exact normalized absolute path`);
    return false;
  }
  return true;
}

function pathContains(parent, candidate) {
  const rel = relative(parent, candidate);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

async function inspectOwnedDirectory(path, at, errors) {
  if (!exactAbsolutePath(path, at, errors)) return null;
  let stat;
  try { stat = await lstat(path); } catch (error) {
    errors.push(`${at} cannot be inspected: ${error.code === "ENOENT" ? "path is absent" : error.message}`);
    return null;
  }
  if (stat.isSymbolicLink()) errors.push(`${at} must not be a symlink`);
  if (!stat.isDirectory()) errors.push(`${at} must be a directory`);
  if (typeof process.getuid === "function" && stat.uid !== process.getuid()) errors.push(`${at} is unowned by the current user`);
  try {
    if (await realpath(path) !== path) errors.push(`${at} path must not traverse a symlink`);
  } catch (error) {
    errors.push(`${at} cannot be canonically resolved: ${error.message}`);
  }
  const parentPath = dirname(path);
  let parentStat;
  try { parentStat = await lstat(parentPath); }
  catch (error) {
    errors.push(`${at} parent cannot be inspected: ${error.message}`);
    return null;
  }
  if (parentStat.isSymbolicLink() || !parentStat.isDirectory()) errors.push(`${at} parent must be a real directory`);
  try {
    if (await realpath(parentPath) !== parentPath) errors.push(`${at} parent path must not traverse a symlink`);
  } catch (error) {
    errors.push(`${at} parent cannot be canonically resolved: ${error.message}`);
  }
  return {
    uid: typeof stat.uid === "number" ? stat.uid : null,
    dev: String(stat.dev),
    ino: String(stat.ino),
    type: "directory",
    parentPath,
    parentUid: typeof parentStat.uid === "number" ? parentStat.uid : null,
    parentDev: String(parentStat.dev),
    parentIno: String(parentStat.ino),
  };
}

function gradeDigestMaterial(snapshot) {
  return {
    grade: snapshot.grade,
    nonce: snapshot.nonce,
    identity: snapshot.identity,
    serverAttestation: snapshot.serverAttestation,
    ownedPaths: snapshot.ownedPaths,
    ownership: snapshot.ownership,
  };
}

function snapshotDigest(snapshot) {
  return sha256(JSON.stringify(gradeDigestMaterial(snapshot)));
}

async function validatePrivateSnapshotTarget(snapshotPath, errors) {
  if (!exactAbsolutePath(snapshotPath, "snapshotPath", errors)) return;
  const parent = dirname(snapshotPath);
  let parentStat;
  try { parentStat = await lstat(parent); } catch (error) {
    errors.push(`snapshot parent cannot be inspected: ${error.message}`);
    return;
  }
  if (parentStat.isSymbolicLink() || !parentStat.isDirectory()) errors.push("snapshot parent must be a real directory");
  if (typeof process.getuid === "function" && parentStat.uid !== process.getuid()) errors.push("snapshot parent is unowned by the current user");
  if ((parentStat.mode & 0o777) !== 0o700) errors.push("snapshot parent must be private mode 0700");
  try {
    if (await realpath(parent) !== parent) errors.push("snapshot parent path must not traverse a symlink");
  } catch (error) {
    errors.push(`snapshot parent cannot be resolved: ${error.message}`);
  }
}

export async function retainGradeSnapshot({
  grade, nonce, identity, serverAttestation, ownedPaths, snapshotPath,
} = {}) {
  const errors = [];
  if (process.platform === "win32") return { ok: false, errors: ["HUMAN-HOLD: Windows native proof has no usable attestation claim"] };
  if (JSON.stringify(grade) !== JSON.stringify({
    ok: true, phase: "evidence-graded", cleanupRequired: true, nonce, receiptType: RECEIPT_TYPE,
  })) errors.push("snapshot requires the exact successful phase 1 grade");
  if (!NONCE_PATTERN.test(nonce ?? "")) errors.push("snapshot nonce must be 32 lowercase hexadecimal characters");
  validateIdentity(identity, identity, errors);
  validateAttestation(serverAttestation, nonce, "snapshot.serverAttestation", errors, identity);
  if (!exactKeys(ownedPaths, ["plugin", "temp"], "snapshot.ownedPaths", errors)) return { ok: false, errors };
  const ownership = {
    plugin: await inspectOwnedDirectory(ownedPaths.plugin, "snapshot.ownedPaths.plugin", errors),
    temp: await inspectOwnedDirectory(ownedPaths.temp, "snapshot.ownedPaths.temp", errors),
  };
  await validatePrivateSnapshotTarget(snapshotPath, errors);
  for (const [key, path] of Object.entries(ownedPaths)) {
    if (exactAbsolutePath(path, `snapshot.ownedPaths.${key}`, errors) && pathContains(path, snapshotPath)) {
      errors.push(`snapshotPath must be outside the owned ${key} path`);
    }
  }
  if (typeof ownedPaths.plugin === "string" && typeof ownedPaths.temp === "string"
    && (ownedPaths.plugin === ownedPaths.temp || pathContains(ownedPaths.plugin, ownedPaths.temp) || pathContains(ownedPaths.temp, ownedPaths.plugin))) {
    errors.push("owned plugin and temp paths must be distinct and non-nested");
  }
  if (errors.length) return { ok: false, errors };
  const snapshot = {
    snapshotType: SNAPSHOT_TYPE,
    schemaVersion: 1,
    grade,
    nonce,
    identity,
    serverAttestation,
    ownedPaths,
    ownership,
  };
  snapshot.gradeDigest = snapshotDigest(snapshot);
  let handle;
  try {
    handle = await open(snapshotPath, "wx", 0o600);
    await handle.writeFile(`${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
  } catch (error) {
    return { ok: false, errors: [`cannot retain private grade snapshot: ${error.message}`] };
  } finally {
    await handle?.close();
  }
  return {
    ...grade,
    gradeDigest: snapshot.gradeDigest,
    snapshotPath,
  };
}

function validateSnapshot(snapshot, errors) {
  const keys = ["snapshotType", "schemaVersion", "grade", "nonce", "identity", "serverAttestation", "ownedPaths", "ownership", "gradeDigest"];
  if (!exactKeys(snapshot, keys, "snapshot", errors)) return;
  exactValue(snapshot.snapshotType, SNAPSHOT_TYPE, "snapshot.snapshotType", errors);
  exactValue(snapshot.schemaVersion, 1, "snapshot.schemaVersion", errors);
  if (!NONCE_PATTERN.test(snapshot.nonce ?? "")) errors.push("snapshot.nonce must be 32 lowercase hexadecimal characters");
  if (!isRecord(snapshot.grade) || snapshot.grade.ok !== true || snapshot.grade.phase !== "evidence-graded"
    || snapshot.grade.cleanupRequired !== true || snapshot.grade.nonce !== snapshot.nonce
    || snapshot.grade.receiptType !== RECEIPT_TYPE) {
    errors.push("snapshot must contain a successful phase 1 grade");
  }
  validateIdentity(snapshot.identity, snapshot.identity, errors);
  validateAttestation(snapshot.serverAttestation, snapshot.nonce, "snapshot.serverAttestation", errors, snapshot.identity);
  if (exactKeys(snapshot.ownedPaths, ["plugin", "temp"], "snapshot.ownedPaths", errors)) {
    for (const key of ["plugin", "temp"]) exactAbsolutePath(snapshot.ownedPaths[key], `snapshot.ownedPaths.${key}`, errors);
  }
  if (!exactKeys(snapshot.ownership, ["plugin", "temp"], "snapshot.ownership", errors)) return;
  for (const key of ["plugin", "temp"]) {
    const at = `snapshot.ownership.${key}`;
    if (!exactKeys(snapshot.ownership[key], [
      "uid", "dev", "ino", "type", "parentPath", "parentUid", "parentDev", "parentIno",
    ], at, errors)) continue;
    exactValue(snapshot.ownership[key].type, "directory", `${at}.type`, errors);
    exactAbsolutePath(snapshot.ownership[key].parentPath, `${at}.parentPath`, errors);
  }
  if (!SHA256_PATTERN.test(snapshot.gradeDigest ?? "") || snapshot.gradeDigest !== snapshotDigest(snapshot)) {
    errors.push("snapshot.gradeDigest does not cryptographically bind the successful phase 1 evidence");
  }
}

async function verifyAbsent(path, at, errors) {
  try {
    const stat = await lstat(path);
    if (stat.isSymbolicLink()) errors.push(`${at} is a symlink, not verified absence`);
    else if (typeof process.getuid === "function" && stat.uid !== process.getuid()) errors.push(`${at} is an unowned replacement`);
    else errors.push(`${at} must be absent`);
  } catch (error) {
    if (error.code !== "ENOENT") errors.push(`${at} absence cannot be verified: ${error.message}`);
  }
}

async function verifyOwnedParent(record, at, errors) {
  if (!record?.parentPath) return;
  let stat;
  try { stat = await lstat(record.parentPath); }
  catch (error) {
    errors.push(`${at} parent identity cannot be verified: ${error.message}`);
    return;
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    errors.push(`${at} parent is not the retained real directory`);
    return;
  }
  try {
    if (await realpath(record.parentPath) !== record.parentPath) {
      errors.push(`${at} parent path now traverses a symlink`);
    }
  } catch (error) {
    errors.push(`${at} parent cannot be canonically resolved: ${error.message}`);
  }
  if (String(stat.dev) !== record.parentDev || String(stat.ino) !== record.parentIno
    || (typeof stat.uid === "number" ? stat.uid : null) !== record.parentUid) {
    errors.push(`${at} parent identity changed after evidence grading`);
  }
}

async function readPrivateGradeSnapshot(snapshotPath) {
  const errors = [];
  await validatePrivateSnapshotTarget(snapshotPath, errors);
  let stat;
  try { stat = await lstat(snapshotPath); } catch (error) {
    errors.push(`grade snapshot cannot be inspected: ${error.message}`);
  }
  if (stat) {
    if (stat.isSymbolicLink() || !stat.isFile()) errors.push("grade snapshot must be a regular file, not a symlink");
    if (typeof process.getuid === "function" && stat.uid !== process.getuid()) errors.push("grade snapshot is unowned");
    if ((stat.mode & 0o777) !== 0o600) errors.push("grade snapshot must be private mode 0600");
  }
  if (errors.length) throw new Error(errors.join("; "));
  return JSON.parse(await readFile(snapshotPath, "utf8"));
}

export async function finalizeCleanup(cleanup, snapshot) {
  if (process.platform === "win32") return { ok: false, errors: ["HUMAN-HOLD: Windows native proof has no usable attestation claim"] };
  const errors = [];
  validateSnapshot(snapshot, errors);
  if (!exactKeys(cleanup, ["cleanupType", "timestamp", "gradeDigest", "ownedPaths", "inventory", "artifacts"], "cleanup", errors)) {
    return { ok: false, errors };
  }
  exactValue(cleanup.cleanupType, CLEANUP_TYPE, "cleanup.cleanupType", errors);
  validateTimestamp(cleanup.timestamp, "cleanup.timestamp", errors);
  exactValue(cleanup.gradeDigest, snapshot?.gradeDigest, "cleanup.gradeDigest", errors);
  if (exactKeys(cleanup.ownedPaths, ["plugin", "temp"], "cleanup.ownedPaths", errors)) {
    for (const key of ["plugin", "temp"]) {
      if (cleanup.ownedPaths[key] !== snapshot?.ownedPaths?.[key]) errors.push(`cleanup.ownedPaths.${key} path mismatch`);
    }
  }
  const inventoryKeys = Object.keys(expectedInventory("after"));
  if (exactKeys(cleanup.inventory, inventoryKeys, "cleanup.inventory", errors)) {
    for (const key of inventoryKeys) exactValue(cleanup.inventory[key], "absent", `cleanup.inventory.${key}`, errors);
  }
  if (exactKeys(cleanup.artifacts, ["tunnel", "screenshotsRetained", "logsRetained", "attestationRetained", "probeDirsRetained"], "cleanup.artifacts", errors)) {
    exactValue(cleanup.artifacts.tunnel, "stopped", "cleanup.artifacts.tunnel", errors);
    for (const key of ["screenshotsRetained", "logsRetained", "attestationRetained", "probeDirsRetained"]) {
      exactValue(cleanup.artifacts[key], 0, `cleanup.artifacts.${key}`, errors);
    }
  }
  if (snapshot?.ownedPaths) {
    await verifyOwnedParent(snapshot.ownership?.plugin, "snapshot.ownedPaths.plugin", errors);
    await verifyOwnedParent(snapshot.ownership?.temp, "snapshot.ownedPaths.temp", errors);
    await verifyAbsent(snapshot.ownedPaths.plugin, "snapshot.ownedPaths.plugin", errors);
    await verifyAbsent(snapshot.ownedPaths.temp, "snapshot.ownedPaths.temp", errors);
  }
  return errors.length ? { ok: false, errors } : {
    ok: true, phase: "cleanup-finalized", nonce: snapshot.nonce, gradeDigest: snapshot.gradeDigest,
  };
}

const HELP = `Usage:
  node scripts/chatgpt-work-native-probe.mjs --connection-id <id> --app-json <file> --plugin-version <semver> --connection-label <label>
  node scripts/chatgpt-work-native-probe.mjs --grade <receipt.json> --nonce <nonce> --server-attestation <attestation.json> --connection-id <id> --app-json <file> --plugin-version <semver> --connection-label <label> --snapshot-out <private-retained.json> --owned-plugin-path <absolute-path> --owned-temp-path <absolute-path>
  node scripts/chatgpt-work-native-probe.mjs --finalize-cleanup <cleanup.json> --grade-snapshot <private-retained.json>
`;

async function main() {
  let values;
  try {
    ({ values } = parseArgs({ options: {
      grade: { type: "string" }, "finalize-cleanup": { type: "string" }, nonce: { type: "string" }, "server-attestation": { type: "string" },
      "connection-id": { type: "string" }, "app-json": { type: "string" }, "plugin-version": { type: "string" }, "connection-label": { type: "string" },
      "snapshot-out": { type: "string" }, "grade-snapshot": { type: "string" },
      "owned-plugin-path": { type: "string" }, "owned-temp-path": { type: "string" },
      help: { type: "boolean", short: "h", default: false },
    }, allowPositionals: false }));
  } catch (error) { process.stderr.write(`${error.message}\n${HELP}`); return 2; }
  if (values.help) { process.stdout.write(HELP); return 0; }
  if (values["finalize-cleanup"]) {
    if (!values["grade-snapshot"]) {
      process.stderr.write(`cleanup finalization requires --grade-snapshot; deleted identity inputs are not used\n${HELP}`); return 2;
    }
    try {
      const [cleanup, snapshot] = await Promise.all([
        readFile(values["finalize-cleanup"], "utf8").then(JSON.parse),
        readPrivateGradeSnapshot(values["grade-snapshot"]),
      ]);
      const result = await finalizeCleanup(cleanup, snapshot);
      process.stdout.write(`${JSON.stringify(result)}\n`);
      return result.ok ? 0 : 1;
    } catch (error) {
      process.stdout.write(`${JSON.stringify({ ok: false, errors: [`cannot finalize cleanup: ${error.message}`] })}\n`); return 1;
    }
  }
  if (!values.grade && !values.nonce && !values["server-attestation"]) {
    if (!values["connection-id"] || !values["app-json"] || !values["plugin-version"] || !values["connection-label"]) {
      process.stderr.write(`run-sheet generation requires real --connection-id, --app-json, --plugin-version, and --connection-label inputs\n${HELP}`); return 2;
    }
    try {
      process.stdout.write(`${JSON.stringify(buildProbe({
        connectionId: values["connection-id"],
        appJson: await readFile(values["app-json"], "utf8"),
        pluginVersion: values["plugin-version"],
        connectionLabel: values["connection-label"],
      }), null, 2)}\n`); return 0;
    } catch (error) { process.stderr.write(`${error.message}\n`); return 2; }
  }
  if (!values.grade || !values.nonce || !values["server-attestation"]) {
    process.stderr.write(`--grade, --nonce, and --server-attestation must be used together\n${HELP}`); return 2;
  }
  if (!values["connection-id"] || !values["app-json"] || !values["plugin-version"] || !values["connection-label"]) {
    process.stderr.write(`--connection-id, --app-json, --plugin-version, and --connection-label identity inputs must be used together when grading\n${HELP}`); return 2;
  }
  if (!values["snapshot-out"] || !values["owned-plugin-path"] || !values["owned-temp-path"]) {
    process.stderr.write(`--snapshot-out, --owned-plugin-path, and --owned-temp-path are required when grading\n${HELP}`); return 2;
  }
  try {
    const [receipt, attestation] = await Promise.all([
      readFile(values.grade, "utf8").then(JSON.parse),
      readFile(values["server-attestation"], "utf8").then(JSON.parse),
    ]);
    const expectedIdentity = buildIdentity({
      connectionId: values["connection-id"],
      appJson: await readFile(values["app-json"], "utf8"),
      pluginVersion: values["plugin-version"],
      connectionLabel: values["connection-label"],
    });
    const result = gradeReceipt(receipt, values.nonce, attestation, expectedIdentity);
    if (!result.ok) {
      process.stdout.write(`${JSON.stringify(result)}\n`);
      return 1;
    }
    const retained = await retainGradeSnapshot({
      grade: result,
      nonce: values.nonce,
      identity: expectedIdentity,
      serverAttestation: attestation,
      ownedPaths: { plugin: values["owned-plugin-path"], temp: values["owned-temp-path"] },
      snapshotPath: values["snapshot-out"],
    });
    process.stdout.write(`${JSON.stringify(retained)}\n`);
    return retained.ok ? 0 : 1;
  } catch (error) {
    process.stdout.write(`${JSON.stringify({ ok: false, errors: [`cannot read proof: ${error.message}`] })}\n`); return 1;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) process.exitCode = await main();
