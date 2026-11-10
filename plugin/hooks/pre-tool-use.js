#!/usr/bin/env node
// muster PreToolUse hook — the action-class fence, and nothing else.
//
// The fence is the only hard DENY muster ships. It acts only while a muster
// run is live in the tool payload's cwd: `.muster/run-active` exists (the verb
// writes it at run start and removes it at run end) AND the orchestrator has
// written `.muster/forbidden-actions` (one class per line, the manifest's
// top-level forbiddenActions). A Bash/PowerShell command or mcp__* tool call
// that action-guard.js classifies into one of those classes is denied.
// Outside a run this hook finds neither file and allows.
//
// Classification runs before any exemption: a delegated (agent_id) call is
// fenced exactly like a main-loop call. The shell classifier is deliberately
// conservative; this is a fence for recognized action classes, not a sandbox.
//
// MUSTER_ACTION_GUARD: deny (default) | warn (allow with a reminder) | off.
// Any unrecognized value denies, so a typo cannot silently disable the fence.
//
// FAIL-SAFE: entire body wrapped in try/catch; any error → silent allow, exit 0.

import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import { emit } from "./guidance.js";
import { classifyAction, DESKTOP_HOST_TOOLS } from "./action-guard.js";

const EVENT = "PreToolUse";

// Where a live run's markers are: the tool call's checkout, or, when that checkout is a linked
// worktree (Workflow executors run in .claude/worktrees/*, which start without the markers), the
// main checkout of the same repository. Resolved from the worktree's `.git` file and its
// `commondir` with plain reads, so the hot path never spawns git. Throws when no live run is
// found (the caller fails open).
function hasRun(dir) {
  try { statSync(path.join(dir, ".muster", "run-active")); return true; } catch { return false; }
}
function runRoot(cwd) {
  if (hasRun(cwd)) return cwd;
  for (let dir = path.resolve(cwd); ; dir = path.dirname(dir)) {
    let dotgit;
    try { dotgit = readFileSync(path.join(dir, ".git"), "utf8"); } catch (e) {
      if (e && e.code === "EISDIR") break; // a main checkout: already checked via cwd ancestry below
      if (path.dirname(dir) === dir) break;
      continue;
    }
    const m = /^gitdir:\s*(.+)\s*$/m.exec(dotgit);
    if (!m) break;
    const gitdir = path.resolve(dir, m[1].trim());
    let common = gitdir;
    try { common = path.resolve(gitdir, readFileSync(path.join(gitdir, "commondir"), "utf8").trim()); } catch { /* not a worktree */ }
    const main = path.dirname(common);
    if (hasRun(main)) return main;
    break;
  }
  throw new Error("no live run");
}

function allow() {
  emit({ hookSpecificOutput: { hookEventName: EVENT } });
  process.exit(0);
}

// Action-class fence deny/warn — names the forbidden class and the override.
function denyAction(cls) {
  emit({
    hookSpecificOutput: {
      hookEventName: EVENT,
      permissionDecision: "deny",
      permissionDecisionReason:
        `Action class "${cls}" is forbidden for this run — this tool call would perform a ${cls} action. ` +
        `If this class should not be forbidden: remove its line from .muster/forbidden-actions. ` +
        `To soften or disable this check: set MUSTER_ACTION_GUARD=warn or off.`,
    },
  });
  process.exit(0);
}

function warnActionAllow(cls) {
  emit({
    hookSpecificOutput: {
      hookEventName: EVENT,
      additionalContext:
        `Action class "${cls}" is forbidden for this run (MUSTER_ACTION_GUARD=warn) — allowing with a reminder. ` +
        `Remove its line from .muster/forbidden-actions, or set MUSTER_ACTION_GUARD=off to silence this reminder.`,
    },
  });
  process.exit(0);
}

try {
  let payload;
  try {
    payload = JSON.parse(readFileSync(0, "utf8"));
  } catch {
    allow();
  }
  if (DESKTOP_HOST_TOOLS.has(payload.tool_name)) allow();

  const cwd = typeof payload.cwd === "string" && payload.cwd.length > 0
    ? payload.cwd
    : process.cwd();

  try {
    const root = runRoot(cwd);
    const forbiddenRaw = readFileSync(path.join(root, ".muster", "forbidden-actions"), "utf8");
    const forbidden = new Set(forbiddenRaw.split("\n").map((l) => l.trim()).filter(Boolean));
    const cls = classifyAction(payload);
    if (cls && forbidden.has(cls)) {
      const actionGuard = (process.env.MUSTER_ACTION_GUARD || "deny").toLowerCase();
      if (actionGuard === "warn") {
        warnActionAllow(cls);
      } else if (actionGuard !== "off") {
        denyAction(cls);
      }
    }
  } catch {
    // No live run here, or unreadable run state: fail open.
  }

  allow();
} catch {
  // FAIL-SAFE: never break the session.
  allow();
}
