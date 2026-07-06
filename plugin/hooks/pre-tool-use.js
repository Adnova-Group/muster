#!/usr/bin/env node
// muster PreToolUse hook — wave-guard + post-run scale gate + action-class fence.
//
// Keeps the orchestrator main loop from doing orchestration-scale work inline,
// enforcing the iron rule: dispatch through the crew (Agent tool) instead. Two
// regimes: a hard block WHILE a wave is active, and a softer per-turn scale gate
// once the wave marker is gone (the post-run window the advisory nudge can't hold).
// A third, independent dimension (the action-class fence) denies tool calls
// that would perform a run-forbidden send/sign/submit/publish/purchase/
// delete-remote action, regardless of wave state.
//
// Decision order:
//   1. ALLOW if payload has agent_id (crew subagent — always allowed).
//   2. ALLOW if the target path is under a META_EXEMPT root (.muster/ or .claude/).
//      .muster/ — wave/state markers and orchestrator ledger.
//      .claude/ — repo-local Claude/orchestrator settings written mid-wave.
//      (For Bash: no path target; this gate is skipped.)
//   2.5. ALLOW if target is outside the cwd tree (GUARD-SCOPE).
//   2.6. Action-class fence: if .muster/run-active AND .muster/forbidden-actions
//        both exist, classify the tool call (action-guard.js) and DENY when it
//        matches a listed class (honors MUSTER_ACTION_GUARD off|warn|deny).
//        Fail-open (no-op) when either file is absent/unreadable, or no class
//        matches. See action-guard.js for classification.
//   3. No .muster/wave-active marker → applyScaleGate() (post-run window; may DENY).
//   4. Orphaned or stale marker → applyScaleGate() likewise.
//      Primary signal: .muster/run-active absent means no active run, so the
//      wave-active marker is orphaned (crashed wave). Verbs write run-active at
//      invocation start and clear it at end.
//      Fallback: marker older than STALE_MS (60 min) catches missed clears.
//   5. Active wave + MUSTER_WAVE_GUARD: "off" → silent allow; "warn" → allow with
//      reminder; unset or "deny":
//        Edit/Write/NotebookEdit → DENY.
//        Bash → inspect command via bashWriteTarget(); DENY only on a
//          high-confidence write match; ALLOW everything else (fail-open).
//        Any other tool_name (e.g. a send/sign/publish-named MCP tool matched
//          for the action-class fence above) → ALLOW; wave-guard gates file
//          writes, not arbitrary tool calls.
//
// applyScaleGate (steps 3-4): with no wave, the main loop may touch 1-2 distinct
// files per turn (trivial/surgical falls through); the Nth distinct file
// (MUSTER_INLINE_SCALE, default 3) is DENIED and routed to a verb. Per-turn budget
// lives in inline-budget.js. Honors the same MUSTER_WAVE_GUARD override.
//
// applyScaleGate also feeds a cumulative cross-turn counter (same file), so
// careful 1-2-file-per-turn drift that never trips the per-turn gate still
// gets a one-time WARN (never a deny) once the running total reaches the
// scale threshold with no muster run active. Reset when a run starts (that
// work is tracked/dispatched, not drift) and at SessionStart.
//
// META_EXEMPT_ROOTS — the shared exemption set (always allowed, no wave check):
//   [".muster", ".claude"]
//   Extend here, nowhere else.
//
// run-active scoping semantics:
//   run-active PRESENT + fresh wave-active → wave-guard is active (step 5).
//   run-active ABSENT  + any wave-active  → treated as orphaned/stale → scale-gate.
//   run-active only relaxes/scopes; it never introduces a new block. When neither
//   marker can be resolved the outer try/catch fail-safe applies.
//
// FAIL-SAFE: entire body wrapped in try/catch; any error → silent allow, exit 0.
//
// Bash command classification lives in bash-write-target.js (pure, unit-testable).
// See that file for the DENY patterns and known heredoc-body limitation.

import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import { emit } from "./guidance.js";
import { bashWriteTarget } from "./bash-write-target.js";
import { classifyAction } from "./action-guard.js";
import { budgetFile, recordFile, scaleThreshold, cumFile, recordCum, markNudged, resetCum } from "./inline-budget.js";

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

// Cumulative cross-turn drift: fires once per session when the total distinct
// inline-edited files (across turns, with no muster run active) reaches the
// scale threshold. Always a WARN (allow + additionalContext) — never a deny;
// the per-turn gate above is the only thing allowed to deny.
function warnCumulativeDrift(count) {
  warnWith(
    `Inline drift: ${count} distinct files edited inline across turns with no muster run active. ` +
    `Route sustained work through /muster:autopilot (or /muster:run to plan first). ` +
    `This reminder fires once per session.`,
  );
}

// No active wave: apply the per-turn scale gate. Allows, warns, or denies by
// guard mode and how many distinct files this turn already touched. Budget key
// is an edit tool's resolved target, OR the full Bash command for a high-
// confidence shell write (keyed on the whole command, NOT the static classifier
// fragment — otherwise distinct `sed -i fileN` writes collapse into one slot and
// slip the gate). Read-only Bash and edits without a concrete target pass free.
//
// Alongside the per-turn budget, also feeds a cumulative cross-turn counter
// (inline-budget.js: cumFile/recordCum/markNudged/resetCum) so drift spread
// carefully across many turns (1-2 files each, never tripping the per-turn
// gate) still gets a one-time warning. Cumulative tracking only applies with
// no muster run active (`cwd`/.muster/run-active absent) — while a run is
// active this turn's edits are dispatched/tracked by the run, not drift, so
// the cumulative counter is reset instead. The per-turn deny/warn above always
// takes precedence: cumulative logic only runs when the per-turn gate would
// otherwise allow.
//
// applyScaleGate never returns (always allow/warn/deny -> exit)
function applyScaleGate(payload, target, guard, cwd) {
  if (guard === "off") allow();

  let key = null;
  if (EDIT_TOOLS.has(payload.tool_name) && target) {
    key = target;
  } else if (payload.tool_name === "Bash") {
    const command = bashCommand(payload);
    if (bashWriteTarget(command) !== null) key = `bash:${command}`;
  }
  if (!key) allow();

  const file = budgetFile(payload.session_id);
  if (!file) allow(); // no usable session id — fail-open, preserves legacy behavior

  // Cumulative cross-turn tracking (best-effort; never affects the per-turn
  // deny/warn/allow decision path below).
  let cumResult = null;
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
      resetCum(cFile);
    } else {
      cumResult = recordCum(cFile, key);
    }
  }

  const count = recordFile(file, key);
  if (count < scaleThreshold()) {
    if (cumResult && !cumResult.nudged && cumResult.count >= scaleThreshold()) {
      markNudged(cFile);
      warnCumulativeDrift(cumResult.count);
    }
    allow();
  }

  if (guard === "warn") warnScaleAllow(count);
  denyScale(count);
}

function warnAllow(waveId) {
  warnWith(`muster wave ${waveId} is active — dispatch edits through the crew via the Agent tool instead of editing inline.`);
}

// Sanitize a string read from external input (a wave-marker's content, a
// bash-command fragment matched by bash-write-target.js) before interpolating
// it into a hook output string (permissionDecisionReason/additionalContext).
// - strip non-printable ASCII (keep 0x20-0x7E)
// - cap at `maxLen` chars (default 64)
// - fall back to `fallback` if empty after sanitization (default "unknown")
function sanitizePrintable(raw, { maxLen = 64, fallback = "unknown" } = {}) {
  const clean = raw.replace(/[^\x20-\x7E]/g, "").slice(0, maxLen).trim();
  return clean.length > 0 ? clean : fallback;
}

// waveId sanitization: thin wrapper over sanitizePrintable (kept as its own
// name at call sites for readability — same rules, default fallback/cap).
function sanitizeWaveId(raw) {
  return sanitizePrintable(raw);
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
  // fragment carries a slice of the raw Bash command (e.g. a redirect target)
  // straight from bash-write-target.js — untrusted input. Sanitize the same
  // way as waveId before it rides into permissionDecisionReason (P2-16).
  const safeFragment = sanitizePrintable(fragment, { fallback: "(unprintable)" });
  denyWith(
    `muster wave ${waveId} is active — this Bash command contains a high-confidence file write (matched: ${safeFragment}). ` +
    `Dispatch file writes through the crew (Agent tool) instead of running them inline. ` +
    `If no wave is actually running: rm .muster/wave-active. ` +
    `If this is a false positive (e.g. redirect-looking text inside a heredoc body): ` +
    `set MUSTER_WAVE_GUARD=warn to allow with a reminder instead of blocking.`,
  );
}

// Action-class fence deny/warn — names the forbidden class and the override
// (mirrors MUSTER_WAVE_GUARD semantics: remove the class from the file, or
// soften/disable via MUSTER_ACTION_GUARD).
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
  //    .muster/ — wave/state markers and orchestrator ledger.
  //    .claude/ — repo-local Claude/orchestrator settings written mid-wave.
  //    (Bash has no file_path/notebook_path; target is "" so this gate is skipped.)
  //    To add a new exempt root, extend META_EXEMPT_ROOTS here and nowhere else.
  const META_EXEMPT_ROOTS = [".muster", ".claude"];
  for (const root of META_EXEMPT_ROOTS) {
    const rootAbs = path.resolve(cwd, root);
    if (target && (target === rootAbs || target.startsWith(rootAbs + path.sep))) {
      allow();
    }
  }

  // GUARD-SCOPE: targets outside the cwd tree are out of this hook's scope — allow.
  // Prevents wave-guard and scale-gate from firing on unrelated paths (e.g. ~/.claude
  // memory files edited by the user in a separate context) during an active wave.
  const cwdAbs = path.resolve(cwd);
  if (target && !target.startsWith(cwdAbs + path.sep) && target !== cwdAbs) {
    allow();
  }

  // 2.6. Action-class fence: a third fence dimension (action-scoped, alongside
  //      the path-scoped owns/frozen fences). Requires BOTH .muster/run-active
  //      (a run is live) AND .muster/forbidden-actions (one class per line,
  //      written by the orchestrator from the manifest at run start) to exist —
  //      either absent means this gate is a no-op (fail-open). Classification
  //      lives in action-guard.js (tool_name keyword match for non-Bash tools;
  //      high-confidence Bash external-effect patterns otherwise). Honors
  //      MUSTER_ACTION_GUARD ("off" | "warn" | default deny), mirroring
  //      MUSTER_WAVE_GUARD semantics. Placed before the wave/scale logic so it
  //      applies regardless of wave state. Never throws past this block: any
  //      failure (missing/unreadable file) falls through to the outer catch,
  //      which is equivalent to "no-op" here since nothing was decided yet.
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
    // or no forbidden class matched — fail-open, continue to the wave/scale logic.
  }

  // Guard mode, needed by both the no-wave scale gate and the active-wave gate.
  // Assigned before step 3 so applyScaleGate can share it.
  const guard = (process.env.MUSTER_WAVE_GUARD || "deny").toLowerCase();

  // 3. Check for the wave-active marker.
  const markerPath = path.join(cwd, MARKER);
  let markerStat;
  try {
    markerStat = statSync(markerPath);
  } catch {
    // Marker does not exist — no active wave. Apply the post-run scale gate.
    applyScaleGate(payload, target, guard, cwd);
  }
  // Defensive: applyScaleGate always exits; this guard prevents any future
  // refactor from falling through to markerStat.mtimeMs on an undefined stat.
  if (!markerStat) allow();

  // 4. Orphaned or stale marker — treat as no wave; apply the scale gate.
  //    Primary signal: .muster/run-active absent means no run is in progress, so
  //    the wave-active marker is orphaned (crashed/incomplete run). Verbs write
  //    run-active at invocation start and clear it at end.
  //    Fallback: if the wave-active marker is older than STALE_MS the run
  //    almost certainly crashed regardless of run-active state.
  //    run-active only relaxes/scopes — its absence NEVER introduces a new block;
  //    behavior degrades to exactly today's scale-gate (fail-open preserved).
  let runActivePresent = false;
  try {
    statSync(path.join(cwd, ".muster", "run-active"));
    runActivePresent = true;
  } catch {
    runActivePresent = false;
  }
  const ageMs = Date.now() - markerStat.mtimeMs;
  if (!runActivePresent || ageMs > STALE_MS) {
    applyScaleGate(payload, target, guard, cwd);
  }

  // Read wave id from marker content, then sanitize.
  let waveId = "unknown";
  try {
    waveId = sanitizeWaveId(readFileSync(markerPath, "utf8").trim());
  } catch {
    waveId = "unknown";
  }

  // 5. Honour MUSTER_WAVE_GUARD (assigned before step 3 so applyScaleGate can share it).
  if (guard === "off") {
    allow();
  } else if (guard === "warn") {
    warnAllow(waveId);
  } else {
    // "deny" or anything unrecognised.
    // For Bash: inspect the command; deny only on high-confidence write match (fail-open).
    if (payload.tool_name === "Bash") {
      const fragment = getBashFragment(payload);
      if (fragment !== null) {
        denyBash(waveId, fragment);
      } else {
        allow();
      }
    } else if (EDIT_TOOLS.has(payload.tool_name)) {
      deny(waveId);
    } else {
      // Wave-guard gates file writes (Edit/Write/NotebookEdit), not arbitrary
      // tool calls. The PreToolUse matcher also fires on send/sign/publish-
      // named tools (for the action-class fence above); absent that fence
      // matching, any other tool_name reaching this point is out of scope for
      // the wave-guard and falls through allowed.
      allow();
    }
  }
} catch {
  // FAIL-SAFE: never break the session.
  allow();
}
