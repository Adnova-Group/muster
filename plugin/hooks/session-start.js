#!/usr/bin/env node
// muster SessionStart hook — injects a one-line pointer into every session and
// cleans up stale per-session/per-repo state on a genuinely fresh session
// start.
//
// Self-contained apart from the sibling guidance.js/inline-budget.js (also
// under plugin/hooks/). The plugin ships only plugin/, so all three files
// travel together.
//
// FAIL-SAFE: this runs at every session start (including source "compact" and
// "resume"). On ANY error we print minimal valid JSON and exit 0. Never throw.

import { readFileSync, unlinkSync } from "node:fs";
import path from "node:path";
import { emit } from "./guidance.js";
import { cumFile, resetCum, directiveFile } from "./inline-budget.js";

const EVENT = "SessionStart";

// The one-line pointer this hook injects into every session — muster's
// always-on guidance is now this single line, not a full principles/verbs
// payload (that content still lives in guidance.js for the border-invitation
// nudges, which fire on their own trigger rather than unconditionally here).
const POINTER = "muster available; /muster:plan for orchestration-scale work.";

// Sources that begin a genuinely fresh session: clear stale per-session/
// per-repo state. "compact" and "resume" fire mid-run — do NOT disarm
// anything live.
const RESET_SOURCES = new Set(["startup", "clear"]);

// Read the stdin payload (matches user-prompt-submit.js pattern).
let payload;
try {
  payload = JSON.parse(readFileSync(0, "utf8"));
} catch {
  payload = {};
}

const source = typeof payload.source === "string" ? payload.source : null;
const cwd = (typeof payload.cwd === "string" && payload.cwd.length > 0)
  ? payload.cwd
  : process.cwd();

// Clear any stale wave/run markers, the cumulative cross-turn inline-drift
// counter (inline-budget.js), and the once-per-crossing directive-nudge
// marker ONLY when this is a fresh session start. "compact" and "resume" fire
// mid-session (mid-run, or mid-drift for a session long enough to have
// auto-compacted) — resetting any of this state there would be
// self-defeating, so they survive.
// source === null  → old-style payload with no source field → treat as startup.
// source "compact" or "resume" → mid-session; leave all of the above intact.
if (source === null || RESET_SOURCES.has(source)) {
  try { unlinkSync(path.join(cwd, ".muster", "wave-active")); } catch { /* not present — fine */ }
  try { unlinkSync(path.join(cwd, ".muster", "run-active")); } catch { /* not present — fine */ }

  // Best-effort, fail-soft: resetCum never throws, and the marker unlink is
  // wrapped so a missing marker (not yet armed this session) is a no-op.
  if (typeof payload.session_id === "string" && payload.session_id.length > 0) {
    const cFile = cumFile(payload.session_id);
    if (cFile) resetCum(cFile);

    const dFile = directiveFile(payload.session_id);
    if (dFile) {
      try { unlinkSync(dFile); } catch { /* not present — fine */ }
    }
  }
}

try {
  emit({
    hookSpecificOutput: {
      hookEventName: EVENT,
      additionalContext: POINTER,
    },
  });
} catch {
  // Minimal valid output so the session is never broken.
  emit({ hookSpecificOutput: { hookEventName: EVENT } });
}

process.exit(0);
