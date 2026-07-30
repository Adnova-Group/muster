import { constants as fsConstants } from "node:fs";
import { lstat, opendir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readNoFollowRegular } from "./fs-safe.js";

const DISPATCH_RECEIPT_FORMAT = "muster.dispatch-process";
const DISPATCH_RECEIPT_SCHEMA = 1;
const MAX_DISPATCH_RECEIPTS = 256;
const MAX_DISPATCH_RECEIPT_BYTES = 4096;
const RECEIPT_NAME =
  /^receipt-([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.json$/;
const RECEIPT_KEYS = [
  "createdAt",
  "format",
  "pid",
  "provider",
  "schemaVersion",
  "startIdentity",
  "token",
];
const KIMI_PROCESS_REPORT_ONLY_MESSAGE =
  "Kimi process dispatch is report-only: trusted broker bootstrap is unavailable";
const MODULE_PATH = fileURLToPath(import.meta.url);

function dispatchReceiptDirectory() {
  return join(homedir(), ".muster", "dispatch-receipts");
}

function isOwnedPrivate(info, mode) {
  const owned = typeof process.getuid !== "function" || info.uid === process.getuid();
  return owned && (info.mode & 0o777) === mode;
}

async function validatePrivateStore(root) {
  const parent = await lstat(dirname(root));
  const parentOwned = typeof process.getuid !== "function" || parent.uid === process.getuid();
  if (parent.isSymbolicLink() || !parent.isDirectory() || !parentOwned) {
    throw new Error(
      `unsafe dispatch receipt parent: ${dirname(root)} must be a current-user-owned directory, not a symlink`,
    );
  }
  const info = await lstat(root);
  if (info.isSymbolicLink() || !info.isDirectory() || !isOwnedPrivate(info, 0o700)) {
    throw new Error(
      `unsafe dispatch receipt directory: ${root} must be a current-user-owned 0700 directory, not a symlink`,
    );
  }
}

function validReceipt(value, token) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  if (Object.keys(value).sort().join(",") !== RECEIPT_KEYS.slice().sort().join(",")) return false;
  return value.format === DISPATCH_RECEIPT_FORMAT &&
    value.schemaVersion === DISPATCH_RECEIPT_SCHEMA &&
    value.provider === "kimi" &&
    value.token === token &&
    Number.isSafeInteger(value.pid) &&
    value.pid > 0 &&
    typeof value.startIdentity === "string" &&
    /^linux-proc-stat:\d+$/.test(value.startIdentity) &&
    typeof value.createdAt === "string" &&
    Number.isFinite(Date.parse(value.createdAt));
}

async function readReceiptFile(path, token) {
  if (!fsConstants.O_NOFOLLOW) throw new Error("dispatch receipt reads require O_NOFOLLOW");
  const { bytes, info } = await readNoFollowRegular(path, {
    maxBytes: MAX_DISPATCH_RECEIPT_BYTES,
    label: `dispatch receipt ${path}`,
    requireSingleLink: true,
  });
  if (!isOwnedPrivate(info, 0o600)) {
    throw new Error(`unsafe dispatch receipt mode or ownership: ${path}`);
  }
  const value = JSON.parse(bytes.toString("utf8"));
  if (!validReceipt(value, token)) throw new Error(`invalid dispatch receipt: ${path}`);
  return value;
}

export async function readDispatchReceipts({
  receiptRoot = dispatchReceiptDirectory(),
  processes = [],
  processSnapshotComplete = false,
} = {}) {
  try {
    await validatePrivateStore(receiptRoot);
  } catch (error) {
    if (error?.code === "ENOENT") {
      return { receipts: [], rejected: [], cleaned: [], truncated: false };
    }
    throw error;
  }

  const allEntries = [];
  let directoryTruncated = false;
  const directory = await opendir(receiptRoot);
  for await (const entry of directory) {
    if (allEntries.length === MAX_DISPATCH_RECEIPTS) {
      directoryTruncated = true;
      break;
    }
    allEntries.push(entry.name);
  }
  allEntries.sort();

  const invalidNames = allEntries.filter((name) => !RECEIPT_NAME.test(name));
  const validNames = allEntries.filter((name) => RECEIPT_NAME.test(name));
  const processRows = Array.isArray(processes) ? processes : [];
  const byPid = new Map(processRows.map((row) => [Number(row?.pid), row]));
  const receipts = [];
  const rejected = invalidNames.map((name) => ({ name, reason: "unexpected-name" }));

  for (const name of validNames) {
    const match = RECEIPT_NAME.exec(name);
    const path = join(receiptRoot, name);
    let receipt;
    try {
      const info = await lstat(path);
      if (info.isSymbolicLink() || !info.isFile()) {
        throw new Error("not a regular no-follow receipt");
      }
      receipt = await readReceiptFile(path, match[1]);
    } catch (error) {
      rejected.push({ name, reason: error.message });
      continue;
    }

    const observed = byPid.get(receipt.pid);
    const stale = processSnapshotComplete === true && !observed;
    const identityMismatch =
      observed &&
      typeof observed.startIdentity === "string" &&
      observed.startIdentity &&
      observed.startIdentity !== receipt.startIdentity;
    if (!stale && !identityMismatch) {
      receipts.push({ pid: receipt.pid, startIdentity: receipt.startIdentity });
    }
  }

  return {
    receipts,
    rejected,
    cleaned: [],
    truncated: directoryTruncated,
    incompleteProvenance:
      processSnapshotComplete !== true || directoryTruncated || rejected.length > 0,
  };
}

export async function runKimiProcess(_request, _options = {}) {
  throw new Error(KIMI_PROCESS_REPORT_ONLY_MESSAGE);
}

if (
  process.argv[1] === MODULE_PATH &&
  (process.argv[2] === "--broker" || process.argv[2] === "--launcher")
) {
  process.stderr.write(`${KIMI_PROCESS_REPORT_ONLY_MESSAGE}\n`);
  process.exitCode = 1;
}
