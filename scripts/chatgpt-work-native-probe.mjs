#!/usr/bin/env node

/*
 * A proof contract for the ChatGPT Work host loop.  This script does not drive
 * ChatGPT, create a tunnel, or infer a native invocation from a transcript. It
 * emits a nonce-bound run sheet and grades two independently produced records:
 * the operator's observation of a completed Work tool card and an attestation
 * emitted by the local MCP server.  Keep the two sources separate.
 */

import { createHash, randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
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
  connectionId = "asdk_app_probe_placeholder",
  appJson = "",
  pluginVersion = "0.5.0",
  connectionLabel = "Muster ChatGPT Work",
} = {}) {
  const normalizedId = normalizedConnectionId(connectionId);
  if (!PLUGIN_VERSION_PATTERN.test(pluginVersion)) throw new Error("pluginVersion must be semver-like");
  if (typeof connectionLabel !== "string" || connectionLabel.length === 0) {
    throw new Error("connectionLabel is required");
  }
  const nonce = randomBytes(16).toString("hex");
  return {
    schemaVersion: 2,
    nonce,
    request: expectedRequest(nonce),
    expectedResult: expectedResult(nonce),
    identity: {
      connectionIdSha256: sha256(normalizedId),
      pluginAppSha256: sha256(appJson),
      pluginName: PLUGIN_NAME,
      pluginVersion,
      connectionLabel,
    },
    instructions: [
      "Run only in ChatGPT Work (web or the ChatGPT desktop app with Work selected); Codex Desktop is a separate surface.",
      "Complete the native Pro Scan Tools gate first. If it does not pass, record HUMAN-HOLD and do not claim Pro support.",
      "Preflight independent inventories for the connection, tunnel profile, plugin, marketplace, cache, and UI artifacts. A collision with any existing name is HUMAN-HOLD; do not modify it.",
      "Use Secure MCP Tunnel with an outbound-only tunnel-client and the local STDIO command: node runtime/chatgpt-work-server.mjs.",
      "For the proof server, set MUSTER_CHATGPT_WORK_PROFILE=pro-safe, MUSTER_CHATGPT_WORK_PROBE_NONCE=<nonce>, and MUSTER_CHATGPT_WORK_PROBE_ATTESTATION_PATH=<absolute existing private probe-dir>/server-attestation.json; the target must not already exist.",
      "The probe directory must be current-user-owned and mode 0700 (POSIX) or an existing directory with an absolute exact-basename server-attestation.json target on Windows; the new attestation is 0600, and any collision is HUMAN-HOLD.",
      "Call muster_prioritize exactly once with the exact nonce-bearing request. Operator evidence must be a completed native Work tool card, not assistant prose, skill discovery, tools/list, or tunnel health.",
      "The server must emit a separate nonce/tool/request/result attestation with invocationCount=1 and a server timestamp. UI evidence is operator attestation, not cryptographic provenance.",
      "Bind the receipt to SHA-256(normalized connection ID), SHA-256(installed .app.json), plugin name/version, and the registered connection label; never store the raw ID, app file, tunnel ID, API key, or screenshots.",
      "Stop tunnel-client, delete only probe-owned resources after ownership checks, re-run every inventory and require absent/absent/absent before grading.",
      "Grade the operator receipt against the separate server attestation, then delete the attestation and empty probe directories. Never fabricate native proof or publish it.",
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

function validateAttestation(value, nonce, at, errors) {
  if (!exactKeys(value, ["attestationType", "source", "nonce", "tool", "request", "result", "invocationCount", "timestamp"], at, errors)) return;
  exactValue(value.attestationType, ATTESTATION_TYPE, `${at}.attestationType`, errors);
  exactValue(value.source, "server", `${at}.source`, errors);
  exactValue(value.nonce, nonce, `${at}.nonce`, errors);
  if (!NONCE_PATTERN.test(value.nonce ?? "")) errors.push(`${at}.nonce must be lowercase hexadecimal`);
  exactValue(value.tool, TOOL, `${at}.tool`, errors);
  validateRequest(value.request, nonce, `${at}.request`, errors);
  validateResult(value.result, nonce, `${at}.result`, errors);
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
  for (const phase of ["before", "during", "after"]) {
    const at = `receipt.inventory.${phase}`;
    if (!exactKeys(value[phase], Object.keys(expectedInventory(phase)), at, errors)) continue;
    for (const [key, expected] of Object.entries(expectedInventory(phase))) exactValue(value[phase][key], expected, `${at}.${key}`, errors);
  }
  exactValue(value.ownership, "probe-owned-only", "receipt.inventory.ownership", errors);
  exactValue(value.cleanup, "verified-absent", "receipt.inventory.cleanup", errors);
}

function validateArtifacts(value, errors) {
  if (!exactKeys(value, ["tunnel", "screenshotsRetained", "logsRetained", "attestationRetained", "probeDirsRetained"], "receipt.artifacts", errors)) return;
  exactValue(value.tunnel, "stopped", "receipt.artifacts.tunnel", errors);
  for (const key of ["screenshotsRetained", "logsRetained", "attestationRetained", "probeDirsRetained"]) exactValue(value[key], 0, `receipt.artifacts.${key}`, errors);
}

export function gradeReceipt(receipt, nonce, serverAttestation, expectedIdentity = null) {
  if (!NONCE_PATTERN.test(nonce ?? "")) return { ok: false, errors: ["expected nonce must be 32 lowercase hexadecimal characters"] };
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
  validateAttestation(receipt.serverEvidence, nonce, "receipt.serverEvidence", errors);
  if (!serverAttestation) errors.push("a separate server attestation is required");
  else {
    validateAttestation(serverAttestation, nonce, "serverAttestation", errors);
    if (JSON.stringify(receipt.serverEvidence) !== JSON.stringify(serverAttestation)) errors.push("serverEvidence must exactly match the separate server attestation");
  }
  if (JSON.stringify(receipt.operatorEvidence?.request) !== JSON.stringify(receipt.serverEvidence?.request)) errors.push("operator and server requests must match exactly");
  if (JSON.stringify(receipt.operatorEvidence?.result) !== JSON.stringify(receipt.serverEvidence?.result)) errors.push("operator and server results must match exactly");
  validateInventory(receipt.inventory, errors);
  validateArtifacts(receipt.artifacts, errors);
  return errors.length ? { ok: false, errors } : { ok: true, nonce, receiptType: RECEIPT_TYPE };
}

const HELP = `Usage:
  node scripts/chatgpt-work-native-probe.mjs
  node scripts/chatgpt-work-native-probe.mjs --grade <receipt.json> --nonce <nonce> --server-attestation <attestation.json> --connection-id <id> --app-json <file> --plugin-version <semver> --connection-label <label>
`;

async function main() {
  let values;
  try {
    ({ values } = parseArgs({ options: {
      grade: { type: "string" }, nonce: { type: "string" }, "server-attestation": { type: "string" },
      "connection-id": { type: "string" }, "app-json": { type: "string" }, "plugin-version": { type: "string" }, "connection-label": { type: "string" },
      help: { type: "boolean", short: "h", default: false },
    }, allowPositionals: false }));
  } catch (error) { process.stderr.write(`${error.message}\n${HELP}`); return 2; }
  if (values.help) { process.stdout.write(HELP); return 0; }
  if (!values.grade && !values.nonce && !values["server-attestation"]) {
    process.stdout.write(`${JSON.stringify(buildProbe(), null, 2)}\n`); return 0;
  }
  if (!values.grade || !values.nonce || !values["server-attestation"]) {
    process.stderr.write(`--grade, --nonce, and --server-attestation must be used together\n${HELP}`); return 2;
  }
  if (!values["connection-id"] || !values["app-json"] || !values["plugin-version"] || !values["connection-label"]) {
    process.stderr.write(`--connection-id, --app-json, --plugin-version, and --connection-label identity inputs must be used together when grading\n${HELP}`); return 2;
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
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return result.ok ? 0 : 1;
  } catch (error) {
    process.stdout.write(`${JSON.stringify({ ok: false, errors: [`cannot read proof: ${error.message}`] })}\n`); return 1;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) process.exitCode = await main();
