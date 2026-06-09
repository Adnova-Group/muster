#!/usr/bin/env node
// muster SessionStart hook — injects always-on guidance into every session.
//
// Self-contained apart from the sibling guidance.js (also under plugin/hooks/).
// The plugin ships only plugin/, so both files travel together.
//
// FAIL-SAFE: this runs at every session start (including source "compact" and
// "resume"). On ANY error we print minimal valid JSON and exit 0. Never throw.

import { PRINCIPLES, VERBS, ROUTING_POLICY, detect } from "./guidance.js";

const EVENT = "SessionStart";

function emit(obj) {
  process.stdout.write(JSON.stringify(obj));
}

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
