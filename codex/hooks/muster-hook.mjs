#!/usr/bin/env node

import { createHash } from "node:crypto";
import { closeSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
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

function cleanupEventRecords(dir, now = Date.now()) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!/^[a-f0-9]{64}\.json$/.test(entry.name)) continue;
    const path = join(dir, entry.name);
    if (!contained(dir, path)) continue;
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink()) continue;
    if (now - stat.mtimeMs > 24 * 60 * 60 * 1000) rmSync(path, { force: true });
  }
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
    cleanupEventRecords(dir);
    record = join(dir, `${eventKey(input, event)}.json`);
    if (!contained(dir, record)) throw new Error("hook event record escaped its directory");
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
