#!/usr/bin/env node
// muster UserPromptSubmit hook — periodically re-asserts muster mode to counter
// in-session drift back to default Claude behavior.
//
// Two tiers, keyed off a per-session turn counter:
//   - every N turns        -> short nudge        (MUSTER_NUDGE_EVERY, default 3)
//   - every N*K turns       -> full principles    (K = MUSTER_PRINCIPLES_EVERY, default 3)
//
// Self-contained apart from sibling guidance.js. FAIL-SAFE: whole body in
// try/catch; on ANY error or missing state, emit minimal valid JSON and exit 0.

import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { emit, PRINCIPLES, VERBS, ROUTING_POLICY, SHORT_NUDGE, isDirective } from "./guidance.js";
import {
  budgetFile, resetBudget, directiveFile, turnFile, readStateText,
  replaceState, stateFileExists,
} from "./inline-budget.js";
import { envInt } from "./env-util.js";

const EVENT = "UserPromptSubmit";

function posInt(value, fallback) {
  const n = Number.parseInt(value, 10);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

// Increment and persist a per-session turn counter; return the new count.
function bumpTurn(sessionId) {
  // Exact-id hashing and private state location are shared with the other hook
  // state files. Missing/empty ids skip counting rather than share a filename.
  const file = turnFile(sessionId);
  if (file === null) return null;
  let count = 0;
  try {
    count = posInt((readStateText(file) || "").trim(), 0); // missing/junk -> 0
  } catch {
    count = 0;
  }
  count += 1;
  replaceState(file, String(count));
  return count;
}

try {
  let payload;
  try {
    payload = JSON.parse(readFileSync(0, "utf8"));
  } catch {
    payload = {};
  }
  const sessionId = typeof payload.session_id === "string" ? payload.session_id : undefined;
  const prompt = typeof payload.prompt === "string" ? payload.prompt : "";

  // A new user turn resets the per-turn inline-edit scale budget that the
  // PreToolUse scale gate reads (fresh allowance each turn). Runs for every
  // turn, including slash commands.
  if (typeof sessionId === "string" && sessionId.length > 0) {
    const file = budgetFile(sessionId);
    if (file) resetBudget(file);
  }

  // Slash-command turns are explicit intent — never inject on them, and never count
  // them. Injecting context on a "/..." prompt is noise, and in a relayed/remote
  // session it can land ahead of the command and break slash-command parsing.
  if (prompt.trimStart().startsWith("/")) {
    emit({ hookSpecificOutput: { hookEventName: EVENT } });
    process.exit(0);
  }

  if (typeof sessionId !== "string" || sessionId.length === 0) {
    emit({ hookSpecificOutput: { hookEventName: EVENT } });
    process.exit(0);
  }

  const N = envInt("MUSTER_NUDGE_EVERY", { min: 1, def: 3 }, process.env);
  const K = envInt("MUSTER_PRINCIPLES_EVERY", { min: 1, def: 3 }, process.env);
  const count = bumpTurn(sessionId);

  // count === null means the session_id sanitized to empty — skip nudging.
  if (count === null) {
    emit({ hookSpecificOutput: { hookEventName: EVENT } });
    process.exit(0);
  }

  let additionalContext;
  if (count % (N * K) === 0) additionalContext = `${PRINCIPLES}\n${VERBS}\n${ROUTING_POLICY}`;
  else if (count % N === 0) additionalContext = SHORT_NUDGE;

  // Directive-triggered nudge: fires immediately (independent of the periodic
  // cadence above) the first time a directive-shaped prompt lands with no active
  // muster run — once per session, then never again. Supersedes whatever the
  // periodic tier chose this turn (no double-inject). Best-effort: any failure
  // here degrades to the periodic behavior computed above.
  try {
    if (isDirective(prompt)) {
      const cwd =
        typeof payload.cwd === "string" && payload.cwd.length > 0 ? payload.cwd : process.cwd();
      let runActive = false;
      try {
        runActive = existsSync(path.join(cwd, ".muster", "run-active"));
      } catch {
        runActive = false;
      }
      if (!runActive) {
        const markerFile = directiveFile(sessionId);
        if (markerFile !== null) {
          let alreadyNudged = false;
          try {
            alreadyNudged = stateFileExists(markerFile);
          } catch {
            alreadyNudged = false;
          }
          if (!alreadyNudged) {
            additionalContext = ROUTING_POLICY;
            try {
              replaceState(markerFile, "1");
            } catch {
              /* best-effort */
            }
          }
        }
      }
    }
  } catch {
    /* directive nudge is best-effort; fall back to the periodic tier above */
  }

  const out = { hookEventName: EVENT };
  if (additionalContext) out.additionalContext = additionalContext;
  emit({ hookSpecificOutput: out });
} catch {
  emit({ hookSpecificOutput: { hookEventName: EVENT } });
}

process.exit(0);
