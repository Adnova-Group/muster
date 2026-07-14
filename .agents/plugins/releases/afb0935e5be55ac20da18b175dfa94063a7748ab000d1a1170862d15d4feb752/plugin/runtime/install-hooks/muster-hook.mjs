#!/usr/bin/env node

import { createHash } from "node:crypto";
import { closeSync, constants as fsConstants, existsSync, fstatSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { classifyAction } from "./action-guard.mjs";

const MODES = "$muster-plan, $muster-go, $muster-plan-backlog, $muster-go-backlog, $muster-diagnose, $muster-audit, $muster-runner, and $muster-capture";
const WRITE_TOOLS = new Set(["Bash", "apply_patch", "Edit", "Write", "NotebookEdit"]);
const READ_ONLY_AGENTS = new Set([
  "muster-investigator",
  "muster-reviewer",
  "muster-strategist",
  "wsh-business-analyst",
  "wsh-code-reviewer",
  "wsh-security-auditor"
]);

function payload() {
  try { return JSON.parse(readFileSync(0, "utf8")); }
  catch { return {}; }
}

let emissionClaimed = false;
function emit(value) {
  if (!emissionClaimed) {
    if (!claimEmission(input, event)) return;
    emissionClaimed = true;
  }
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function eventContext(event, additionalContext) {
  emit({ hookSpecificOutput: { hookEventName: event, additionalContext } });
}

function message(systemMessage) {
  emit({ systemMessage });
}

function gitRoot(cwd) {
  let current = resolve(cwd);
  for (;;) {
    if (existsSync(join(current, ".git"))) return current;
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

function gitDirLooksLikeWorktree(root) {
  if (!root) return false;
  try {
    const marker = readFileSync(join(root, ".git"), "utf8");
    return /^gitdir:\s*.+[/\\]worktrees[/\\]/m.test(marker);
  } catch {
    return false;
  }
}

function state(cwd) {
  const root = gitRoot(cwd);
  return {
    root,
    runActive: existsSync(join(cwd, ".muster", "run-active")) || Boolean(root && existsSync(join(root, ".muster", "run-active"))),
    waveActive: existsSync(join(cwd, ".muster", "wave-active")) || Boolean(root && existsSync(join(root, ".muster", "wave-active"))),
    worktree: gitDirLooksLikeWorktree(root)
  };
}

function forbiddenActions(cwd, root) {
  for (const base of [cwd, root].filter(Boolean)) {
    try {
      return new Set(readFileSync(join(base, ".muster", "forbidden-actions"), "utf8")
        .split(/\r?\n/).map(value => value.trim()).filter(Boolean));
    } catch {
      // Try the next applicable state root.
    }
  }
  return new Set();
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  return value;
}

const digest = value => createHash("sha256").update(value).digest("hex");
const scalar = value => typeof value === "string" || typeof value === "number" ? String(value) : "";

function eventKey(input, event) {
  const parts = [event, scalar(input.session_id)];
  if (event === "SessionStart") {
    parts.push(scalar(input.source), scalar(input.session_start_id || input.start_id || input.session_id));
  } else {
    parts.push(scalar(input.turn_id));
    const eventId = input.event_id || input.tool_use_id || input.call_id || input.agent_id || input.subagent_id;
    parts.push(scalar(eventId));
    if (!input.turn_id && !eventId) parts.push(digest(JSON.stringify(canonical(input))));
  }
  return digest(JSON.stringify(parts));
}

function contained(base, target) {
  const rel = relative(resolve(base), resolve(target));
  return rel && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

function ensureDirectory(path) {
  if (!existsSync(path)) mkdirSync(path, { recursive: true, mode: 0o700 });
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`unsafe hook event directory: ${path}`);
}

const CLEANUP_INTERVAL_MS = 60 * 1000;
const RECORD_TTL_MS = 24 * 60 * 60 * 1000;
const RECORDS_PER_SHARD = 64;
// Cleanup callbacks only delete expired records or trim an overfull shard. They are
// idempotent, so a bounded lease prevents a forged or paused live PID from blocking
// capacity recovery indefinitely.
const LOCK_LEASE_MS = 30 * 1000;

function regularRecords(dir) {
  const records = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!/^[a-f0-9]{64}\.json$/.test(entry.name)) continue;
    const path = join(dir, entry.name);
    if (!contained(dir, path)) continue;
    const stat = lstatSync(path);
    if (stat.isFile() && !stat.isSymbolicLink()) records.push({ path, mtimeMs: stat.mtimeMs });
  }
  return records;
}

function readHookLock(path) {
  let fd;
  try {
    const before = lstatSync(path);
    if (before.isSymbolicLink() || !before.isFile()) throw new Error(`unsafe hook lock: ${path}`);
    fd = openSync(path, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW || 0));
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.dev !== before.dev || stat.ino !== before.ino) throw new Error(`unsafe hook lock: ${path}`);
    let record = null;
    try { record = JSON.parse(readFileSync(fd, "utf8")); } catch { /* invalid owners fail closed below */ }
    return { stat, record };
  } finally { if (fd !== undefined) closeSync(fd); }
}

const sameHookLockInode = (left, right) => left.dev === right.dev && left.ino === right.ino;
const sameHookLockOwner = (left, right) => typeof left?.token === "string" && left.token.length > 0
  && left.token === right?.token && left.pid === right?.pid
  && left.createdAt === right?.createdAt && left.format === right?.format;
const staleHookLock = (state, now) => {
  const createdAt = Number(state.record?.createdAt);
  const leaseStartedAt = Number.isFinite(createdAt) ? Math.min(createdAt, state.stat.mtimeMs) : state.stat.mtimeMs;
  return now - leaseStartedAt >= LOCK_LEASE_MS;
};

function defaultHookRetirementModeCapability({ stat }) {
  return (stat.mode & 0o777) !== 0o777;
}

function assertPrivateHookRetirementDirectory(dir, { expectedStat = null, requirePrivateMode = true } = {}) {
  const stat = lstatSync(dir);
  const uid = typeof process.getuid === "function" ? process.getuid() : null;
  const ownerMismatch = process.platform !== "win32" && typeof uid === "number" && stat.uid !== uid;
  const ownerChanged = expectedStat && stat.uid !== expectedStat.uid;
  const directoryChanged = expectedStat && !sameHookLockInode(stat, expectedStat);
  const unsafeMode = requirePrivateMode && process.platform !== "win32"
    && ((stat.mode & 0o700) !== 0o700 || (stat.mode & 0o077) !== 0);
  if (stat.isSymbolicLink() || !stat.isDirectory() || ownerMismatch || ownerChanged || directoryChanged || unsafeMode) {
    throw new Error(`unsafe hook lock retirement directory: ${dir}`);
  }
  return stat;
}

function privateHookRetirement(path, { modeCapability = defaultHookRetirementModeCapability } = {}) {
  for (let attempt = 0; attempt < 8; attempt++) {
    const dir = join(dirname(path), `.muster-retired-${process.pid}-${digest(`${Date.now()}:${Math.random()}`)}`);
    try { mkdirSync(dir, { mode: 0o700 }); }
    catch (error) { if (error.code === "EEXIST" && attempt < 7) continue; throw error; }
    const stat = lstatSync(dir);
    const requirePrivateMode = modeCapability({ dir, stat });
    if (typeof requirePrivateMode !== "boolean") throw new Error(`invalid hook retirement mode capability for ${dir}`);
    assertPrivateHookRetirementDirectory(dir, { expectedStat: stat, requirePrivateMode });
    return { dir, path: join(dir, "lock"), stat, expectedStat: stat, requirePrivateMode };
  }
  throw new Error(`could not create hook lock retirement directory for ${path}`);
}

function removeEmptyHookRetirementDirectory(retirement) {
  assertPrivateHookRetirementDirectory(retirement.dir, retirement);
  rmdirSync(retirement.dir);
}

function restoreRetiredHookLock(path, retirement, stat) {
  assertPrivateHookRetirementDirectory(retirement.dir, retirement);
  const current = lstatSync(retirement.path);
  if (!sameHookLockInode(current, stat)) return false;
  try { linkSync(retirement.path, path); }
  catch (error) { if (error.code === "EEXIST") return false; throw error; }
  const restored = lstatSync(path);
  if (!sameHookLockInode(restored, stat)) throw new Error(`hook lock restore changed identity: ${path}`);
  assertPrivateHookRetirementDirectory(retirement.dir, retirement);
  rmSync(retirement.path);
  removeEmptyHookRetirementDirectory(retirement);
  return true;
}

function restoreQuarantinedHookLock(path, quarantine, stat, { modeCapability } = {}) {
  const retirement = privateHookRetirement(quarantine, { modeCapability });
  try { renameSync(quarantine, retirement.path); }
  catch (error) {
    try { removeEmptyHookRetirementDirectory(retirement); } catch { /* preserve an ambiguous retirement directory */ }
    if (error.code === "ENOENT") return false;
    throw error;
  }
  return restoreRetiredHookLock(path, retirement, stat);
}

function retireOwnedHookLock(path, expectedStat, expectedRecord, {
  restorePath = path,
  stale = null,
  afterRetirement = () => {},
  modeCapability
} = {}) {
  let current;
  try { current = readHookLock(path); }
  catch { return false; }
  if (!sameHookLockInode(current.stat, expectedStat) || !sameHookLockOwner(current.record, expectedRecord)) return false;
  const retirement = privateHookRetirement(path, { modeCapability });
  try { renameSync(path, retirement.path); }
  catch (error) {
    try { removeEmptyHookRetirementDirectory(retirement); } catch { /* preserve an ambiguous retirement directory */ }
    if (error.code === "ENOENT") return false;
    throw error;
  }
  afterRetirement({ dir: retirement.dir, path: retirement.path, sourcePath: path });
  assertPrivateHookRetirementDirectory(retirement.dir, retirement);
  let retired;
  try { retired = readHookLock(retirement.path); }
  catch { return false; }
  if (!sameHookLockInode(retired.stat, expectedStat) || !sameHookLockOwner(retired.record, expectedRecord)) {
    return false;
  }
  if (stale && !stale(retired)) {
    restoreRetiredHookLock(restorePath, retirement, expectedStat);
    return false;
  }
  assertPrivateHookRetirementDirectory(retirement.dir, retirement);
  const final = readHookLock(retirement.path);
  if (!sameHookLockInode(final.stat, expectedStat) || !sameHookLockOwner(final.record, expectedRecord)) return false;
  rmSync(retirement.path);
  removeEmptyHookRetirementDirectory(retirement);
  return true;
}

export function reclaimStaleLock(path, now, {
  afterQuarantine = () => {},
  afterValidation = () => {},
  afterRetirement = () => {},
  modeCapability = defaultHookRetirementModeCapability
} = {}) {
  let current;
  try { current = readHookLock(path); }
  catch (error) { if (error.code === "ENOENT") return false; throw error; }
  if (!sameHookLockOwner(current.record, current.record) || !staleHookLock(current, now)) return false;
  const quarantine = `${path}.muster-reclaim-${process.pid}-${digest(`${now}:${Math.random()}`)}`;
  try { renameSync(path, quarantine); }
  catch (error) { if (error.code === "ENOENT") return false; throw error; }
  try {
    afterQuarantine({ path, quarantine });
    const quarantined = readHookLock(quarantine);
    if (!sameHookLockInode(quarantined.stat, current.stat) || !sameHookLockOwner(quarantined.record, current.record)
      || !staleHookLock(quarantined, now)) {
      restoreQuarantinedHookLock(path, quarantine, quarantined.stat, { modeCapability });
      return false;
    }
    afterValidation({ path, quarantine });
    const finalCandidate = readHookLock(quarantine);
    if (!sameHookLockInode(finalCandidate.stat, quarantined.stat) || !sameHookLockOwner(finalCandidate.record, quarantined.record)
      || !staleHookLock(finalCandidate, now)) {
      restoreQuarantinedHookLock(path, quarantine, finalCandidate.stat, { modeCapability });
      return false;
    }
    return retireOwnedHookLock(quarantine, finalCandidate.stat, finalCandidate.record, {
      restorePath: path,
      stale: state => staleHookLock(state, now),
      afterRetirement,
      modeCapability
    });
  } catch (error) {
    // Preserve ambiguous retired entries; never delete a pathname whose owner
    // cannot be bound after the final move.
    throw error;
  }
}

export function withShardLock(dir, name, callback, now = Date.now(), {
  beforeRelease = () => {},
  afterRetirement = () => {},
  modeCapability = defaultHookRetirementModeCapability
} = {}) {
  const path = join(dir, name);
  const token = digest(`${process.pid}:${now}:${name}:${Math.random()}`);
  let fd;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      fd = openSync(path, "wx", 0o600);
      writeFileSync(fd, JSON.stringify({ format: 1, pid: process.pid, createdAt: now, token }) + "\n", "utf8");
      break;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      if (attempt === 0 && reclaimStaleLock(path, now, { afterRetirement, modeCapability })) continue;
      return false;
    }
  }
  try { callback(); }
  finally {
    closeSync(fd);
    try {
      const current = readHookLock(path);
      if (!sameHookLockOwner(current.record, { token, pid: process.pid, createdAt: now, format: 1 })) return false;
      beforeRelease({ path });
      if (!retireOwnedHookLock(path, current.stat, current.record, { afterRetirement, modeCapability })) return false;
    } catch { return false; /* a replaced or unsafe lock is not ours to remove */ }
  }
  return true;
}

function cleanupEventRecords(dir, now = Date.now()) {
  const stamp = join(dir, ".cleanup-stamp");
  try {
    const stat = lstatSync(stamp);
    if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(`unsafe hook cleanup stamp: ${stamp}`);
    if (now - stat.mtimeMs < CLEANUP_INTERVAL_MS) return;
  } catch (error) { if (error.code !== "ENOENT") throw error; }
  withShardLock(dir, ".cleanup-lock", () => {
    for (const record of regularRecords(dir)) if (now - record.mtimeMs > RECORD_TTL_MS) rmSync(record.path, { force: true });
    const staged = join(dir, `.cleanup-stamp-${process.pid}-${now}.tmp`);
    let fd;
    try {
      fd = openSync(staged, "wx", 0o600);
      writeFileSync(fd, `${now}\n`, "utf8");
      closeSync(fd);
      fd = null;
      renameSync(staged, stamp);
    } finally {
      if (fd !== null && fd !== undefined) try { closeSync(fd); } catch { /* cleanup below */ }
      try {
        const stat = lstatSync(staged);
        if (stat.isFile() && !stat.isSymbolicLink()) rmSync(staged, { force: true });
      } catch { /* already renamed */ }
    }
  }, now);
}

function enforceShardCapacity(dir, preserve) {
  withShardLock(dir, ".capacity-lock", () => {
    const records = regularRecords(dir).sort((left, right) => left.mtimeMs - right.mtimeMs || left.path.localeCompare(right.path));
    for (const record of records.slice(0, Math.max(0, records.length - RECORDS_PER_SHARD))) {
      if (record.path !== preserve) rmSync(record.path, { force: true });
    }
  });
}

function claimEmission(input, event) {
  let fd = null, record = null;
  try {
    const home = resolve(process.env.CODEX_HOME || join(homedir(), ".codex"));
    ensureDirectory(home);
    const muster = join(home, "muster"), dir = join(muster, "hook-events");
    if (!contained(home, muster) || !contained(home, dir)) throw new Error("hook event directory escaped CODEX_HOME");
    ensureDirectory(muster);
    ensureDirectory(dir);
    const key = eventKey(input, event), shard = join(dir, key.slice(0, 2));
    if (!contained(dir, shard)) throw new Error("hook event shard escaped its directory");
    ensureDirectory(shard);
    cleanupEventRecords(shard);
    record = join(shard, `${key}.json`);
    if (!contained(shard, record)) throw new Error("hook event record escaped its directory");
    try { fd = openSync(record, "wx", 0o600); }
    catch (error) {
      if (error.code !== "EEXIST") throw error;
      const stat = lstatSync(record);
      if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(`unsafe hook event record: ${record}`);
      return false;
    }
    writeFileSync(fd, JSON.stringify({ format: 1, event, createdAt: new Date().toISOString() }) + "\n", "utf8");
    closeSync(fd);
    fd = null;
    enforceShardCapacity(shard, record);
    return true;
  } catch (error) {
    if (fd !== null) try { closeSync(fd); } catch { /* fail open */ }
    if (record) try {
      const stat = lstatSync(record);
      if (stat.isFile() && !stat.isSymbolicLink()) rmSync(record, { force: true });
    } catch { /* fail open */ }
    process.stderr.write(`Muster hook dedupe unavailable; continuing fail-open: ${error.message}\n`);
    return true;
  }
}

const input = payload();
const event = typeof input.hook_event_name === "string" ? input.hook_event_name : "";
const cwd = typeof input.cwd === "string" && input.cwd ? input.cwd : process.cwd();
const current = state(cwd);

try {
  if (event === "SessionStart") {
    eventContext(event,
      `Muster is installed for Codex. Route orchestration through ${MODES}. ` +
      "Use the bundled deterministic CLI/MCP and preserve its approval, manifest, wave, receipt, and verification gates. " +
      "Write-capable waves must run in isolated git worktrees. Codex lifecycle hooks provide context and diagnostics; todo and spawn enforcement remain advisory."
    );
  } else if (event === "UserPromptSubmit") {
    const prompt = typeof input.prompt === "string" ? input.prompt : "";
    if (/\b(?:muster|plan-backlog|go-backlog|diagnose|audit|runner|capture)\b/i.test(prompt)) {
      eventContext(event, `Use the matching Muster mode skill and its deterministic gates. Available modes: ${MODES}.`);
    }
  } else if (event === "PreToolUse") {
    const tool = typeof input.tool_name === "string" ? input.tool_name : "";
    const action = current.runActive ? classifyAction(input) : null;
    if (action && forbiddenActions(cwd, current.root).has(action)) {
      message(`Muster policy advisory: action class "${action}" is forbidden for this run. Do not execute this external effect unless the authorized manifest/disposition changes. Codex PreToolUse hooks surface this warning but do not reliably block every unified-shell or subagent action.`);
    } else if (WRITE_TOOLS.has(tool) && current.waveActive && !current.worktree) {
      message("Muster policy advisory: a write-capable wave is active outside a detected isolated git worktree. Dispatch writes to a write-capable Muster agent in its assigned worktree. Codex PreToolUse hooks cannot reliably deny every subagent or unified-shell action.");
    }
  } else if (event === "PostToolUse") {
    if (current.waveActive && !current.runActive) {
      message("Muster diagnostic: .muster/wave-active exists without .muster/run-active. Treat it as a potentially stale marker and verify state before continuing.");
    }
  } else if (event === "SubagentStart") {
    const type = typeof input.agent_type === "string" ? input.agent_type : "default";
    const policy = READ_ONLY_AGENTS.has(type)
      ? "Remain read-only and return evidence to the orchestrator."
      : "Before writing, verify you are in the isolated worktree assigned by the orchestrator; never write on the base branch.";
    eventContext(event, `Muster subagent ${type}: ${policy} Preserve task ownership boundaries and return verification evidence plus the final commit SHA when applicable.`);
  } else if (event === "SubagentStop") {
    if (current.waveActive) message("Muster diagnostic: record the subagent result, review findings, and verification evidence before closing the active wave.");
  } else if (event === "Stop") {
    if (current.runActive || current.waveActive) {
      message("Muster diagnostic: this turn is stopping with active run or wave state. Confirm terminal receipts and clear only markers owned by the completed or explicitly cancelled workflow.");
    }
  }
} catch {
  // Hooks are diagnostic and fail open. Never break a Codex session.
}
