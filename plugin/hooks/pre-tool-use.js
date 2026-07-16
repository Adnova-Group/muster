#!/usr/bin/env node
// muster PreToolUse hook — action-class fence + the tool-call half of
// muster's one border invitation.
//
// Enforcement follows the run's EXTERNAL effects, not the orchestrator's own
// in-repo edits: the only hard DENY this hook can emit is the action-class
// fence (2.6.4 below), scoped to a live run that has declared a forbidden
// action class. Everything else in the old stack (a hard wave-active block on
// main-loop file writes, a per-turn deny once a session was deemed
// "engaged", a todo-driving dispatch gate) proved unscopable in the field —
// false-positive-trained kill switches, repeated-injection destabilization on
// legitimate concurrent work, and denies that fired on sessions/repos where
// muster had never run at all. Removed entirely (see CHANGELOG). Review gates
// (review-gate/SKILL.md) remain muster's quality enforcement; this hook only
// ever blocks a run-forbidden external action.
//
// Everything else this hook does is invitation, not enforcement: a single
// warn-only "border" that sells the value of a crew run (parallel dispatch,
// adversarial review, receipts — see guidance.js: CREW_INVITATION) once per
// crossing when inline drift with no muster run active crosses
// MUSTER_INLINE_SCALE distinct files, then stays silent until a run starts,
// SessionStart, or 60 minutes of inactivity re-arms it (inline-budget.js:
// isCrossingStale). A re-armed crossing is only ELIGIBLE to warn again — a
// shared cooldown (inline-budget.js: isInCooldown/recordInvite,
// MUSTER_INVITE_COOLDOWN_MS, default 15 min) still suppresses the actual warn
// for a window after the last invite, so a noisy border (a rapid muster-run
// restart, or a drift counter oscillating around the threshold) cannot flap a
// repeat invite seconds apart; a genuinely long-lived session still gets one
// invite per crossing once real time separates them. The prompt-time half of
// the same invitation lives in user-prompt-submit.js (the isDirective nudge,
// itself gated on scale correlation — see inline-budget.js:
// isScaleCorroborated).
//
// Decision order:
//   1. ALLOW if payload has agent_id (crew subagent — always allowed).
//   2. ALLOW if the target path is under a META_EXEMPT root (.muster/ or
//      .claude/ — orchestrator bookkeeping and repo-local settings).
//   3. ALLOW if the target path is outside the cwd tree (GUARD-SCOPE) —
//      out of scope for a cwd-relative fence.
//   4. Action-class fence: if .muster/run-active AND .muster/forbidden-actions
//      both exist, classify the tool call (action-guard.js) and DENY when it
//      matches a listed class (honors MUSTER_ACTION_GUARD off|warn|deny).
//      Fail-open (no-op) when either file is absent/unreadable, or no class
//      matches. THE ONLY DENY THIS HOOK CAN EMIT.
//   5. Border invitation: if this call is a qualifying inline file touch
//      (Edit/Write/NotebookEdit with a resolved target, or a Bash command
//      bash-write-target.js classifies as a high-confidence write) and no
//      muster run is active, record it in the cumulative cross-turn counter
//      (inline-budget.js: cumFile/recordCum). Crossing MUSTER_INLINE_SCALE
//      (default 3) for the first time this crossing window, AND the shared
//      cooldown is not active (inline-budget.js: isInCooldown) -> WARN
//      (additionalContext, never a deny) and start the cooldown. If a muster
//      run IS active, the counter resets instead (that work is tracked/
//      dispatched, not drift).
//   6. ALLOW.
//
// META_EXEMPT_ROOTS — the shared exemption set (always allowed):
//   [".muster", ".claude"]
//   Extend here, nowhere else.
//
// FAIL-SAFE: entire body wrapped in try/catch; any error → silent allow, exit 0.
//
// Bash command classification for the border-invitation key lives in
// bash-write-target.js (pure, unit-testable) — reused here purely to decide
// whether a shell command IS a file write for cumulative-counter keying; it no
// longer backs any deny path.

import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import { emit, CREW_INVITATION } from "./guidance.js";
import { bashWriteTarget } from "./bash-write-target.js";
import { classifyAction } from "./action-guard.js";
import {
  cumFile, recordCum, markNudged, resetCum, scaleThreshold,
  cooldownFile, isInCooldown, recordInvite,
} from "./inline-budget.js";

const EVENT = "PreToolUse";
const EDIT_TOOLS = new Set(["Edit", "Write", "NotebookEdit"]);

function allow() {
  emit({ hookSpecificOutput: { hookEventName: EVENT } });
  process.exit(0);
}

// Emit a deny (with reason) or warn (with context) decision, then exit. Two
// primitives so a caller cannot emit a deny without also exiting.
function denyWith(reason) {
  emit({ hookSpecificOutput: { hookEventName: EVENT, permissionDecision: "deny", permissionDecisionReason: reason } });
  process.exit(0);
}

function warnWith(additionalContext) {
  emit({ hookSpecificOutput: { hookEventName: EVENT, additionalContext } });
  process.exit(0);
}

// Raw Bash command string for a payload ("" when absent).
function bashCommand(payload) {
  return (payload.tool_input && payload.tool_input.command) || "";
}

// Action-class fence deny/warn — names the forbidden class and the override.
function denyAction(cls) {
  denyWith(
    `Action class "${cls}" is forbidden for this run — this tool call would perform a ${cls} action. ` +
    `If this class should not be forbidden: remove its line from .muster/forbidden-actions. ` +
    `To soften or disable this check: set MUSTER_ACTION_GUARD=warn or off.`,
  );
}

function warnActionAllow(cls) {
  warnWith(
    `Action class "${cls}" is forbidden for this run (MUSTER_ACTION_GUARD=warn) — allowing with a reminder. ` +
    `Remove its line from .muster/forbidden-actions, or set MUSTER_ACTION_GUARD=off to silence this reminder.`,
  );
}

// The border invitation (warn-only; never a deny). Sells the value of a crew
// run before naming the verb — see guidance.js: CREW_INVITATION for the
// shared value sentence this and the UserPromptSubmit isDirective nudge both
// carry.
function warnBorder(count) {
  warnWith(
    `${CREW_INVITATION} Worth reaching for here: ${count} distinct files touched inline this turn/session ` +
    `with no muster run active. Try /muster:go (or /muster:plan to plan first).`,
  );
}

try {
  let payload;
  try {
    payload = JSON.parse(readFileSync(0, "utf8"));
  } catch {
    allow();
  }

  // 1. Subagent calls always allowed.
  if (payload.agent_id !== undefined && payload.agent_id !== null) {
    allow();
  }

  const cwd = typeof payload.cwd === "string" && payload.cwd.length > 0
    ? payload.cwd
    : process.cwd();

  const rawTarget =
    (payload.tool_input && (payload.tool_input.file_path || payload.tool_input.notebook_path)) || "";

  // Resolve target against cwd if not absolute.
  const target = rawTarget
    ? (path.isAbsolute(rawTarget) ? rawTarget : path.resolve(cwd, rawTarget))
    : "";

  // 2. Meta-exempt roots — orchestrator bookkeeping dirs always allowed.
  //    (Bash has no file_path/notebook_path; target is "" so this gate is skipped.)
  //    To add a new exempt root, extend META_EXEMPT_ROOTS here and nowhere else.
  const META_EXEMPT_ROOTS = [".muster", ".claude"];
  for (const root of META_EXEMPT_ROOTS) {
    const rootAbs = path.resolve(cwd, root);
    if (target && (target === rootAbs || target.startsWith(rootAbs + path.sep))) {
      allow();
    }
  }

  // 3. GUARD-SCOPE: targets outside the cwd tree are out of this hook's scope.
  const cwdAbs = path.resolve(cwd);
  if (target && !target.startsWith(cwdAbs + path.sep) && target !== cwdAbs) {
    allow();
  }

  // 4. Action-class fence — THE ONLY DENY THIS HOOK CAN EMIT. Requires BOTH
  //    .muster/run-active (a run is live) AND .muster/forbidden-actions (one
  //    class per line, written by the orchestrator from the manifest at run
  //    start) to exist — either absent means this gate is a no-op
  //    (fail-open). Classification lives in action-guard.js. Honors
  //    MUSTER_ACTION_GUARD ("off" | "warn" | default deny). Never throws past
  //    this block: any failure (missing/unreadable file) falls through to the
  //    outer catch, equivalent to "no-op" here since nothing was decided yet.
  try {
    statSync(path.join(cwd, ".muster", "run-active"));
    const forbiddenRaw = readFileSync(path.join(cwd, ".muster", "forbidden-actions"), "utf8");
    const forbidden = new Set(forbiddenRaw.split("\n").map((l) => l.trim()).filter(Boolean));
    const cls = classifyAction(payload);
    if (cls && forbidden.has(cls)) {
      const actionGuard = (process.env.MUSTER_ACTION_GUARD || "deny").toLowerCase();
      if (actionGuard === "warn") {
        warnActionAllow(cls);
      } else if (actionGuard !== "off") {
        denyAction(cls);
      }
      // actionGuard === "off": fall through silently — no deny/warn, continue below.
    }
  } catch {
    // .muster/run-active absent, .muster/forbidden-actions absent/unreadable,
    // or no forbidden class matched — fail-open, continue to the border check.
  }

  // 5. Border invitation — warn-only cumulative drift signal. Never denies.
  let key = null;
  if (EDIT_TOOLS.has(payload.tool_name) && target) {
    key = target;
  } else if (payload.tool_name === "Bash") {
    const command = bashCommand(payload);
    if (bashWriteTarget(command) !== null) key = `bash:${command}`;
  }

  if (key) {
    const cFile = cumFile(payload.session_id);
    if (cFile) {
      let runActive = false;
      try {
        statSync(path.join(cwd, ".muster", "run-active"));
        runActive = true;
      } catch {
        runActive = false;
      }

      if (runActive) {
        // A muster run resolves the invitation — this work is tracked/
        // dispatched, not drift. Reset rather than record.
        resetCum(cFile);
      } else {
        const { count, nudged } = recordCum(cFile, key);
        if (!nudged && count >= scaleThreshold()) {
          // This crossing is nudged either way (never re-check its later
          // files) — but the cooldown decides whether the warn is actually
          // spoken. A rapid run-restart or a threshold-oscillating counter
          // re-arms a "new" crossing right away; the cooldown is what keeps
          // that re-armed crossing from flapping a repeat invite seconds
          // after the last one (see inline-budget.js: isInCooldown).
          markNudged(cFile);
          const cdFile = cooldownFile(payload.session_id);
          if (!isInCooldown(cdFile)) {
            recordInvite(cdFile);
            warnBorder(count);
          }
        }
      }
    }
  }

  // 6. Nothing above decided anything — allow.
  allow();
} catch {
  // FAIL-SAFE: never break the session.
  allow();
}
