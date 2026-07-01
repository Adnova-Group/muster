#!/usr/bin/env node
// muster PreToolUse hook — wave-guard + post-run scale gate + permission gate.
//
// Keeps the orchestrator main loop from doing orchestration-scale work inline,
// enforcing the iron rule: dispatch through the crew (Agent tool) instead. Two
// regimes: a hard block WHILE a wave is active, and a softer per-turn scale gate
// once the wave marker is gone (the post-run window the advisory nudge can't hold).
//
// Decision order:
//   1. ALLOW if payload has agent_id (crew subagent — always allowed; skips permission layer).
//   2. ALLOW if the target path is under .muster/ (STATE bookkeeping is legit).
//      (For Bash: no path target; this gate is skipped.)
//   3. Permission layer (main-loop calls only, fires at every allow/warn path below).
//      Reads .muster/allow.run.json (run scope) and .muster-allow.json (project scope).
//      Destructive commands (classifyDestructive match) always emit permissionDecision:"ask",
//      even when the key is in an allowlist. Allowlisted non-destructive commands emit
//      permissionDecision:"allow" with a glass-box additionalContext. Never fires on deny paths.
//   4. No .muster/wave-active marker → applyScaleGate() (post-run window; may DENY).
//   5. Marker older than 60 minutes (stale/crashed wave) → applyScaleGate() likewise.
//   6. Active wave + MUSTER_WAVE_GUARD: "off" → silent allow; "warn" → allow with
//      reminder; unset or "deny":
//        Edit/Write/NotebookEdit → DENY.
//        Bash → inspect command via bashWriteTarget(); DENY only on a
//          high-confidence write match; ALLOW everything else (fail-open).
//          A destructive Bash command with no write pattern still reaches the
//          permission layer and emits "ask" rather than silently allowing.
//
// applyScaleGate (steps 4-5): with no wave, the main loop may touch 1-2 distinct
// files per turn (trivial/surgical falls through); the Nth distinct file
// (MUSTER_INLINE_SCALE, default 3) is DENIED and routed to a verb. Per-turn budget
// lives in inline-budget.js. Honors the same MUSTER_WAVE_GUARD override.
//
// FAIL-SAFE: entire body wrapped in try/catch; any error → silent allow, exit 0.
//
// Bash command classification lives in bash-write-target.js (pure, unit-testable).
// Permission gate core lives in permission-policy.js (harness-agnostic, pure).
// See those files for the DENY patterns and store format details.

import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import { emit } from "./guidance.js";
import { bashWriteTarget } from "./bash-write-target.js";
import { budgetFile, recordFile, scaleThreshold } from "./inline-budget.js";
import {
  readStore,
  resolvePermission,
  classifyDestructive,
  appendLedger,
} from "./permission-policy.js";

const EVENT = "PreToolUse";
const MARKER = ".muster/wave-active";
const STALE_MS = 60 * 60 * 1000; // 60 minutes
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

// High-confidence Bash file-write fragment, or null. Shared by the scale gate
// and the active-wave Bash branch.
function getBashFragment(payload) {
  return bashWriteTarget(bashCommand(payload));
}

// Scale-gate messages — action-first: lead with the instruction, rationale in parens.
function denyScale(count) {
  denyWith(
    `Route this through /muster:autopilot (or /muster:run to plan first). ` +
    `Reason: ${count} distinct files touched inline this turn with no active wave — ` +
    `orchestration-scale work belongs in a reviewed wave via the crew, not inline. ` +
    `Trivial 1-2 file edits fall through. Override (session-level): set MUSTER_WAVE_GUARD=warn or off.`,
  );
}

function warnScaleAllow(count) {
  warnWith(
    `Route orchestration-scale work through /muster:autopilot, not inline ` +
    `(${count} distinct files touched inline this turn with no active wave).`,
  );
}

// ── Permission gate (wave-2 CC adapter) ──────────────────────────────────────
//
// allowPermission(payload, cwd) — checked at every allow/warn path for main-loop
// calls. Called AFTER the early-allows (subagent, .muster/ paths) but BEFORE the
// final allow()/warnWith() in each branch.
//
// Exits with permissionDecision:"ask"   when the command is destructive (always
//   re-prompts the user, even if the key is already in an allowlist).
// Exits with permissionDecision:"allow" when the key is in an allowlist and the
//   command is not destructive (glass-box additionalContext names the scope).
// Returns silently (no exit) when neither applies — caller proceeds normally.
//
// Wrapped in try/catch: any internal error → fall through (fail-open).

function allowPermission(payload, cwd) {
  try {
    const command = bashCommand(payload);
    const rawTarget =
      (payload.tool_input && (payload.tool_input.file_path || payload.tool_input.notebook_path)) || "";
    const target = rawTarget
      ? (path.isAbsolute(rawTarget) ? rawTarget : path.resolve(cwd, rawTarget))
      : "";

    const runKeys = readStore(path.join(cwd, ".muster", "allow.run.json"));
    const projectKeys = readStore(path.join(cwd, ".muster-allow.json"));

    const isDestructive = classifyDestructive(payload.tool_name, command) !== null;
    const v = resolvePermission({ toolName: payload.tool_name, command, target, runKeys, projectKeys });

    // Read runId for the audit ledger. Fails silently — "unknown" is a safe default.
    let runId = "unknown";
    try {
      const rj = JSON.parse(readFileSync(path.join(cwd, ".muster", "run.json"), "utf8"));
      runId = rj.runId || rj.id || "unknown";
    } catch { /* run.json may not exist */ }

    const ledger = path.join(cwd, ".muster", "permission-ledger.jsonl");

    if (isDestructive) {
      // Destructive commands always force re-prompt regardless of allowlist.
      // This is the load-bearing carve-out: classifyDestructive overrides "allow".
      appendLedger(ledger, { toolName: payload.tool_name, verdict: "prompt-destructive", runId, reason: v.reason });
      emit({ hookSpecificOutput: { hookEventName: EVENT, permissionDecision: "ask" } });
      process.exit(0);
    }

    if (v.decision === "allow") {
      // Key is allowlisted and command is not destructive — auto-allow with glass-box line.
      appendLedger(ledger, { toolName: payload.tool_name, verdict: "allow", scope: v.scope, runId });
      emit({ hookSpecificOutput: {
        hookEventName: EVENT,
        permissionDecision: "allow",
        additionalContext: `muster: auto-allowed ${payload.tool_name} (${v.scope} allowlist)`,
      }});
      process.exit(0);
    }

    // Not destructive, not allowlisted: fall through to caller's normal behavior.
  } catch {
    // Any error in the permission check → fall through (fail-open).
  }
}

// No active wave: apply the per-turn scale gate. Allows, warns, or denies by
// guard mode and how many distinct files this turn already touched. Budget key
// is an edit tool's resolved target, OR the full Bash command for a high-
// confidence shell write (keyed on the whole command, NOT the static classifier
// fragment — otherwise distinct `sed -i fileN` writes collapse into one slot and
// slip the gate). Read-only Bash and edits without a concrete target pass free.
function applyScaleGate(payload, target, guard, cwd) {
  if (guard === "off") { allowPermission(payload, cwd); allow(); }

  let key = null;
  if (EDIT_TOOLS.has(payload.tool_name) && target) {
    key = target;
  } else if (payload.tool_name === "Bash") {
    const command = bashCommand(payload);
    if (bashWriteTarget(command) !== null) key = `bash:${command}`;
  }
  if (!key) { allowPermission(payload, cwd); allow(); }

  const file = budgetFile(payload.session_id);
  if (!file) { allowPermission(payload, cwd); allow(); } // no usable session id — fail-open, preserves legacy behavior

  const count = recordFile(file, key);
  if (count < scaleThreshold()) { allowPermission(payload, cwd); allow(); }

  if (guard === "warn") { allowPermission(payload, cwd); warnScaleAllow(count); }
  denyScale(count);
}

function warnAllow(waveId) {
  warnWith(`muster wave ${waveId} is active — dispatch edits through the crew via the Agent tool instead of editing inline.`);
}

// Sanitize a waveId read from a marker file before interpolating into output.
// - strip non-printable ASCII (keep 0x20-0x7E)
// - cap at 64 chars
// - fall back to "unknown" if empty after sanitization
function sanitizeWaveId(raw) {
  const clean = raw.replace(/[^\x20-\x7E]/g, "").slice(0, 64).trim();
  return clean.length > 0 ? clean : "unknown";
}

function deny(waveId) {
  denyWith(
    `muster wave ${waveId} is active — dispatch this edit through the crew (Agent tool) instead of editing inline. ` +
    `This includes shell-based file writes (sed -i, tee, heredocs) which bypass the hook. ` +
    `If no wave is actually running: rm .muster/wave-active. ` +
    `For harnesses whose PreToolUse payload lacks agent_id, set MUSTER_WAVE_GUARD=warn to allow with a reminder instead of blocking.`,
  );
}

function denyBash(waveId, fragment) {
  denyWith(
    `muster wave ${waveId} is active — this Bash command contains a high-confidence file write (matched: ${fragment}). ` +
    `Dispatch file writes through the crew (Agent tool) instead of running them inline. ` +
    `If no wave is actually running: rm .muster/wave-active. ` +
    `If this is a false positive (e.g. redirect-looking text inside a heredoc body): ` +
    `set MUSTER_WAVE_GUARD=warn to allow with a reminder instead of blocking.`,
  );
}

try {
  let payload;
  try {
    payload = JSON.parse(readFileSync(0, "utf8"));
  } catch {
    allow();
  }

  // 1. Subagent calls always allowed. Permission layer is skipped for subagents.
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

  // 2. Paths inside .muster/ are orchestrator STATE bookkeeping — always allowed.
  //    (Bash has no file_path/notebook_path; target is "" so this gate is skipped.)
  const musterDir = path.resolve(cwd, ".muster") + path.sep;
  if (target && (target === path.resolve(cwd, ".muster") || target.startsWith(musterDir))) {
    allow();
  }

  // Guard mode, needed by both the no-wave scale gate and the active-wave gate.
  const guard = (process.env.MUSTER_WAVE_GUARD || "deny").toLowerCase();

  // 3. Check for the wave-active marker.
  const markerPath = path.join(cwd, MARKER);
  let markerStat;
  try {
    markerStat = statSync(markerPath);
  } catch {
    // Marker does not exist — no active wave. Apply the post-run scale gate.
    // Permission layer is embedded inside applyScaleGate at each allow point.
    applyScaleGate(payload, target, guard, cwd);
  }

  // 4. Stale marker (older than 60 minutes) — treat as no wave; same scale gate.
  const ageMs = Date.now() - markerStat.mtimeMs;
  if (ageMs > STALE_MS) {
    applyScaleGate(payload, target, guard, cwd);
  }

  // Read wave id from marker content, then sanitize.
  let waveId = "unknown";
  try {
    waveId = sanitizeWaveId(readFileSync(markerPath, "utf8").trim());
  } catch {
    waveId = "unknown";
  }

  // 5. Honour MUSTER_WAVE_GUARD (hoisted above step 3 because applyScaleGate,
  //    called in the steps 3-4 no-wave fallthrough, also needs it).
  //    Permission layer fires before each allow/warn — never before deny.
  if (guard === "off") {
    allowPermission(payload, cwd);
    allow();
  } else if (guard === "warn") {
    allowPermission(payload, cwd);
    warnAllow(waveId);
  } else {
    // "deny" or anything unrecognised.
    // For Bash: inspect the command; deny only on high-confidence write match (fail-open).
    // Note: a destructive Bash command with no write pattern reaches allowPermission
    // and emits "ask" rather than silently allowing through the wave guard.
    if (payload.tool_name === "Bash") {
      const fragment = getBashFragment(payload);
      if (fragment !== null) {
        denyBash(waveId, fragment);
      } else {
        allowPermission(payload, cwd);
        allow();
      }
    } else {
      deny(waveId);
    }
  }
} catch {
  // FAIL-SAFE: never break the session.
  allow();
}
