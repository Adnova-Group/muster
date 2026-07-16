#!/usr/bin/env node

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { classifyAction } from "./action-guard.mjs";

// Dropped: an emission-dedupe subsystem (per-event lock files, shard capacity
// limits, stale-lock quarantine/retirement) that existed only so two installed
// copies would not both emit context for one logical event. Every emission
// below is idempotent, so dedupe bought safety this payload never needed.
// This file now only gathers event context and prints it (fail-open stdout).

const MODES = "$muster-plan, $muster-go, $muster-plan-backlog, $muster-go-backlog, $muster-diagnose, $muster-audit, $muster-runner, and $muster-capture";
const WRITE_TOOLS = new Set(["Bash", "apply_patch", "Edit", "Write", "NotebookEdit"]);
const READ_ONLY_AGENTS = new Set([
  "muster-investigator", "muster-reviewer", "muster-strategist",
  "wsh-business-analyst", "wsh-code-reviewer", "wsh-security-auditor"
]);

function payload() { try { return JSON.parse(readFileSync(0, "utf8")); } catch { return {}; } }
const emit = value => process.stdout.write(`${JSON.stringify(value)}\n`);
const eventContext = (event, additionalContext) => emit({ hookSpecificOutput: { hookEventName: event, additionalContext } });
const message = systemMessage => emit({ systemMessage });
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
  // Not a machine-specific path: scripts/check-codex.mjs's tracked-file
  // absolute-path guard is quote-anchored (a quote char must immediately
  // precede the drive-letter/home/mnt/Users prefix), so this unquoted regex
  // literal does not trip it -- see test/codex.test.js's dedicated fixture
  // test proving exactly that.
  try { return /^gitdir:\s*.+[/\\]worktrees[/\\]/m.test(readFileSync(join(root, ".git"), "utf8")); }
  catch { return false; }
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
    } catch { /* try the next applicable state root */ }
  }
  return new Set();
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
