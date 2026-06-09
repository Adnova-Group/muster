#!/usr/bin/env node
// muster SessionStart hook — injects always-on guidance into every session.
//
// Self-contained apart from the sibling guidance.js (also under plugin/hooks/).
// The plugin ships only plugin/, so both files travel together.
//
// FAIL-SAFE: this runs at every session start (including source "compact" and
// "resume"). On ANY error we print minimal valid JSON and exit 0. Never throw.

import { unlinkSync } from "node:fs";
import path from "node:path";
import { PRINCIPLES, VERBS, ROUTING_POLICY, detect } from "./guidance.js";

const EVENT = "SessionStart";

function emit(obj) {
  process.stdout.write(JSON.stringify(obj));
}

// Clear any stale wave marker so a new session never inherits a previous wave's state.
try { unlinkSync(path.join(process.cwd(), ".muster", "wave-active")); } catch { /* not present — fine */ }

try {
  emit({
    hookSpecificOutput: {
      hookEventName: EVENT,
      additionalContext: [PRINCIPLES, VERBS, ROUTING_POLICY, detect(process.cwd())].join("\n"),
    },
  });
} catch {
  // Minimal valid output so the session is never broken.
  emit({ hookSpecificOutput: { hookEventName: EVENT } });
}

process.exit(0);
