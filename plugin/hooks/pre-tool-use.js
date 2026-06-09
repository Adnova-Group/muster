#!/usr/bin/env node
// muster PreToolUse hook — wave-guard.
//
// Prevents the orchestrator main loop from editing files inline while a
// muster wave is active, enforcing the iron rule: dispatch through the crew
// (Agent tool) instead.
//
// Decision order:
//   1. ALLOW if payload has agent_id (crew subagent — always allowed).
//   2. ALLOW if the target path is under .muster/ (STATE bookkeeping is legit).
//   3. ALLOW if .muster/wave-active does not exist.
//   4. ALLOW if the marker's mtime is older than 60 minutes (stale/crashed wave).
//   5. MUSTER_WAVE_GUARD: "off" → silent allow; "warn" → allow with reminder;
//      unset or "deny" → DENY.
//
// FAIL-SAFE: entire body wrapped in try/catch; any error → silent allow, exit 0.

import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import { emit } from "./guidance.js";

const EVENT = "PreToolUse";
const MARKER = ".muster/wave-active";
const STALE_MS = 60 * 60 * 1000; // 60 minutes

function allow() {
  emit({ hookSpecificOutput: { hookEventName: EVENT } });
  process.exit(0);
}

function warnAllow(waveId) {
  emit({
    hookSpecificOutput: {
      hookEventName: EVENT,
      additionalContext:
        `muster wave ${waveId} is active — dispatch edits through the crew via the Agent tool instead of editing inline.`,
    },
  });
  process.exit(0);
}

// Sanitize a waveId read from a marker file before interpolating into output.
// - strip non-printable ASCII (keep 0x20–0x7E)
// - cap at 64 chars
// - fall back to "unknown" if empty after sanitization
function sanitizeWaveId(raw) {
  const clean = raw.replace(/[^\x20-\x7E]/g, "").slice(0, 64).trim();
  return clean.length > 0 ? clean : "unknown";
}

function deny(waveId) {
  emit({
    hookSpecificOutput: {
      hookEventName: EVENT,
      permissionDecision: "deny",
      permissionDecisionReason:
        `muster wave ${waveId} is active — dispatch this edit through the crew (Agent tool) instead of editing inline. ` +
        `This includes shell-based file writes (sed -i, tee, heredocs) which bypass the hook. ` +
        `If no wave is actually running: rm .muster/wave-active. ` +
        `For harnesses whose PreToolUse payload lacks agent_id, set MUSTER_WAVE_GUARD=warn to allow with a reminder instead of blocking.`,
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

  // 2. Paths inside .muster/ are orchestrator STATE bookkeeping — always allowed.
  const musterDir = path.resolve(cwd, ".muster") + path.sep;
  if (target && (target === path.resolve(cwd, ".muster") || target.startsWith(musterDir))) {
    allow();
  }

  // 3. Check for the wave-active marker.
  const markerPath = path.join(cwd, MARKER);
  let markerStat;
  try {
    markerStat = statSync(markerPath);
  } catch {
    // Marker does not exist — no active wave.
    allow();
  }

  // 4. Stale marker (older than 60 minutes) — treat as no wave.
  const ageMs = Date.now() - markerStat.mtimeMs;
  if (ageMs > STALE_MS) {
    allow();
  }

  // Read wave id from marker content, then sanitize.
  let waveId = "unknown";
  try {
    waveId = sanitizeWaveId(readFileSync(markerPath, "utf8").trim());
  } catch {
    waveId = "unknown";
  }

  // 5. Honour MUSTER_WAVE_GUARD env var.
  const guard = (process.env.MUSTER_WAVE_GUARD || "deny").toLowerCase();
  if (guard === "off") {
    allow();
  } else if (guard === "warn") {
    warnAllow(waveId);
  } else {
    // "deny" or anything unrecognised → block.
    deny(waveId);
  }
} catch {
  // FAIL-SAFE: never break the session.
  allow();
}
