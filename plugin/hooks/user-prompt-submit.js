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

import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { emit, PRINCIPLES, VERBS, ROUTING_POLICY, SHORT_NUDGE } from "./guidance.js";
import { budgetFile, resetBudget, safeSession } from "./inline-budget.js";

const EVENT = "UserPromptSubmit";

function posInt(value, fallback) {
  const n = Number.parseInt(value, 10);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

// Increment and persist a per-session turn counter; return the new count.
function bumpTurn(sessionId) {
  // Shared sanitization rule (inline-budget.js). Null when nothing usable remains:
  // skip turn-counting rather than write a bare shared file (muster-turns-) that
  // causes cross-session collisions.
  const safe = safeSession(sessionId);
  if (safe === null) return null;
  const file = path.join(os.tmpdir(), `muster-turns-${safe}`);
  let count = 0;
  try {
    count = posInt(readFileSync(file, "utf8").trim(), 0); // missing/junk -> 0
  } catch {
    count = 0;
  }
  count += 1;
  writeFileSync(file, String(count));
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

  const N = posInt(process.env.MUSTER_NUDGE_EVERY, 3);
  const K = posInt(process.env.MUSTER_PRINCIPLES_EVERY, 3);
  const count = bumpTurn(sessionId);

  // count === null means the session_id sanitized to empty — skip nudging.
  if (count === null) {
    emit({ hookSpecificOutput: { hookEventName: EVENT } });
    process.exit(0);
  }

  let additionalContext;
  if (count % (N * K) === 0) additionalContext = `${PRINCIPLES}\n${VERBS}\n${ROUTING_POLICY}`;
  else if (count % N === 0) additionalContext = SHORT_NUDGE;

  const out = { hookEventName: EVENT };
  if (additionalContext) out.additionalContext = additionalContext;
  emit({ hookSpecificOutput: out });
} catch {
  emit({ hookSpecificOutput: { hookEventName: EVENT } });
}

process.exit(0);
