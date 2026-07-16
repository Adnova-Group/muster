#!/usr/bin/env node

import { existsSync, lstatSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { classifyAction } from "./action-guard.mjs";

// Dropped: an emission-dedupe subsystem (per-event lock files, shard capacity
// limits, stale-lock quarantine/retirement) that existed only so two installed
// copies would not both emit context for one logical event. Every emission
// below is idempotent, so dedupe bought safety this payload never needed.
//
// Enforcement-model port (adapts, onto this Codex integration branch, the
// "enforcement follows the run" redesign landed on main's
// plugin/hooks/pre-tool-use.js -- see main's CHANGELOG entry of that name;
// main is a separate, not-yet-merged line of history from this branch, so
// nothing it changed applies here automatically). Codex hooks were already
// advisory-by-design -- this file has never had a hard-deny decision path --
// so there was no deny path left to soften. What DID need deleting was the
// wave-active-keyed write matcher: a blunt "any
// Bash/Edit/Write/NotebookEdit/apply_patch call counts as a write" check,
// gated on the presence of `.muster/wave-active`, the same marker main's own
// hook no longer reads for enforcement (wave-active survives there only as
// orchestrator bookkeeping). Removed along with it: the small worktree-
// detection heuristic that existed solely to scope that check.
//
// In its place, the one surviving advisory surface besides the action-class
// fence: a warn-only "border invitation" -- distinct inline edit-tool targets
// touched with no muster run active, across calls in this session. Crossing
// MUSTER_INLINE_SCALE (default 3) warns once per crossing, then stays silent
// until a muster run starts, a fresh SessionStart, or 60 minutes of
// inactivity re-arms it. This mirrors main's inline-budget.js cumulative-
// counter design, trimmed to the one signal this port needs: no per-turn
// deny threshold (codex never had one to remove), no directive-prompt half
// (one entry point is enough here). Bash is deliberately NOT counted: main's
// equivalent only counts a Bash call after classifying it as a high-
// confidence file write (a dedicated bash-write-target classifier); this
// port has no such classifier, and counting every Bash call as a "write"
// would resurrect exactly the blunt-matcher false-positive class this port
// removes. State lives in os.tmpdir(), per session -- never litters project
// trees, never creates a CODEX_HOME artifact, same rationale main's
// inline-budget.js documents for its own equivalent state.

const MODES = "$muster-plan, $muster-go, $muster-plan-backlog, $muster-go-backlog, $muster-diagnose, $muster-audit, $muster-runner, and $muster-capture";
const EDIT_TOOLS = new Set(["apply_patch", "Edit", "Write", "NotebookEdit"]);
const READ_ONLY_AGENTS = new Set([
  "muster-investigator", "muster-reviewer", "muster-strategist",
  "wsh-business-analyst", "wsh-code-reviewer", "wsh-security-auditor"
]);
const BORDER_SCALE_DEFAULT = 3;
const BORDER_MAX_AGE_MS = 60 * 60 * 1000; // 60 minutes -- mirrors inline-budget.js's CROSSING_MAX_AGE_MS
const BORDER_INVITATION =
  "A muster run buys parallel dispatch across the crew, adversarial review before merge, and a receipts trail for every decision.";

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
function state(cwd) {
  const root = gitRoot(cwd);
  return {
    root,
    runActive: existsSync(join(cwd, ".muster", "run-active")) || Boolean(root && existsSync(join(root, ".muster", "run-active"))),
    waveActive: existsSync(join(cwd, ".muster", "wave-active")) || Boolean(root && existsSync(join(root, ".muster", "wave-active")))
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

// ── border invitation: per-session cumulative distinct-edit counter ────────
function borderScale() {
  const raw = Number.parseInt(process.env.MUSTER_INLINE_SCALE || "", 10);
  return Number.isFinite(raw) && raw >= 2 ? raw : BORDER_SCALE_DEFAULT;
}
function safeSession(sessionId) {
  if (typeof sessionId !== "string") return null;
  const s = sessionId.replace(/[^a-zA-Z0-9_-]/g, "");
  return s.length > 0 ? s : null;
}
function borderFile(sessionId) {
  const s = safeSession(sessionId);
  return s ? join(tmpdir(), `muster-codex-border-${s}`) : null;
}
// Symlink-safe write (CWE-59 hardening, ported from inline-budget.js): the
// marker lives in a shared, world-writable tmpdir keyed only by a sanitized
// session id, so refuse to write through a planted symlink at that path.
function safeWriteFileSync(file, content) {
  try {
    const st = lstatSync(file);
    if (!st.isFile()) unlinkSync(file);
  } catch { /* ENOENT, or unlink failed -- writeFileSync below surfaces its own error */ }
  writeFileSync(file, content);
}
function readBorder(file) {
  try {
    const raw = JSON.parse(readFileSync(file, "utf8"));
    const v = raw && typeof raw === "object" ? raw : {};
    const touched = Array.isArray(v.touched) ? v.touched.filter(x => typeof x === "string") : [];
    return { touched, nudged: Boolean(v.nudged) };
  } catch { return { touched: [], nudged: false }; }
}
function resetBorder(file) {
  try { safeWriteFileSync(file, JSON.stringify({ touched: [], nudged: false })); } catch { /* best-effort */ }
}
// Record `key` into the distinct-touch set (discarding it first if the prior
// crossing has gone stale past BORDER_MAX_AGE_MS), persist, and return the
// resulting { count, nudged }.
function recordBorder(file, key, now = Date.now()) {
  let mtimeMs = null;
  try { mtimeMs = statSync(file).mtimeMs; } catch { mtimeMs = null; }
  const stale = typeof mtimeMs === "number" && Number.isFinite(mtimeMs) && (now - mtimeMs) > BORDER_MAX_AGE_MS;
  const current = stale ? { touched: [], nudged: false } : readBorder(file);
  if (!current.touched.includes(key)) current.touched.push(key);
  try { safeWriteFileSync(file, JSON.stringify(current)); } catch { /* best-effort */ }
  return { count: current.touched.length, nudged: current.nudged };
}
function markBorderNudged(file) {
  const current = readBorder(file);
  current.nudged = true;
  try { safeWriteFileSync(file, JSON.stringify(current)); } catch { /* best-effort */ }
}
function borderKey(input) {
  const ti = (input.tool_input && typeof input.tool_input === "object") ? input.tool_input : {};
  return ti.file_path || ti.path || ti.notebook_path || input.tool_name || "unknown";
}

const input = payload();
const event = typeof input.hook_event_name === "string" ? input.hook_event_name : "";
const cwd = typeof input.cwd === "string" && input.cwd ? input.cwd : process.cwd();
const current = state(cwd);
try {
  if (event === "SessionStart") {
    // A genuinely fresh session (not a mid-run "compact"/"resume") re-arms
    // the border invitation, mirroring session-start.js's resetCum call.
    const source = typeof input.source === "string" ? input.source : null;
    if (source === null || source === "startup" || source === "clear") {
      const bFile = borderFile(input.session_id);
      if (bFile) resetBorder(bFile);
    }
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
    } else if (EDIT_TOOLS.has(tool)) {
      // The border invitation: the sole surviving no-run-active advisory (see
      // the header comment). A live run resolves drift -- reset instead of
      // recording; otherwise record this touch and warn once per crossing.
      const bFile = borderFile(input.session_id);
      if (bFile) {
        if (current.runActive) {
          resetBorder(bFile);
        } else {
          const { count, nudged } = recordBorder(bFile, borderKey(input));
          if (!nudged && count >= borderScale()) {
            markBorderNudged(bFile);
            message(
              `Muster policy advisory (border invitation): ${count} distinct inline edits touched this session with no muster run active. ` +
              `${BORDER_INVITATION} Try $muster-go (or $muster-plan to plan first). ` +
              "Codex PreToolUse hooks surface this as a one-time reminder per crossing, never a block."
            );
          }
        }
      }
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
