#!/usr/bin/env node
// muster UserPromptSubmit hook — periodically re-asserts muster mode to counter
// in-session drift back to default Claude behavior.
//
// Two tiers, keyed off a per-session turn counter:
//   - every N turns        -> short nudge        (MUSTER_NUDGE_EVERY, default 3)
//   - every N*K turns       -> full principles    (MUSTER_PRINCIPLES_EVERY, default 3)
//
// Self-contained apart from sibling guidance.js. FAIL-SAFE: whole body in
// try/catch; on ANY error or missing state, emit minimal valid JSON and exit 0.

import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { PRINCIPLES, VERBS, ROUTING_POLICY, SHORT_NUDGE } from "./guidance.js";

const EVENT = "UserPromptSubmit";

function emit(obj) {
  process.stdout.write(JSON.stringify(obj));
}

function posInt(value, fallback) {
  const n = Number.parseInt(value, 10);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

// Increment and persist a per-session turn counter; return the new count.
function bumpTurn(sessionId) {
  const safe = sessionId.replace(/[^a-zA-Z0-9_-]/g, "");
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
  let sessionId;
  try {
    sessionId = JSON.parse(readFileSync(0, "utf8")).session_id;
  } catch {
    sessionId = undefined;
  }

  if (typeof sessionId !== "string" || sessionId.length === 0) {
    emit({ hookSpecificOutput: { hookEventName: EVENT } });
    process.exit(0);
  }

  const N = posInt(process.env.MUSTER_NUDGE_EVERY, 3);
  const K = posInt(process.env.MUSTER_PRINCIPLES_EVERY, 3);
  const count = bumpTurn(sessionId);

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
