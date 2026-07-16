#!/usr/bin/env node
// muster UserPromptSubmit hook — the prompt-time half of muster's one border
// invitation (see pre-tool-use.js for the tool-call half: the cumulative
// inline-file drift counter). This is the ONLY prompt-time nudge muster
// injects — the old periodic every-N-turns tier (a short nudge, then the
// full principles payload) is gone; it habituated and injected on turns that
// had nothing to do with routing.
//
// Fires ONLY when a directive-shaped prompt (guidance.js: isDirective — an
// imperative verb like fix/build/implement, optionally after a polite
// lead-in; declaratives like "Update:"/"Fix for" and questions are excluded)
// lands with no muster run active AND that verb shape is corroborated by
// scale: at least one distinct file already recorded this crossing by the
// PreToolUse cumulative counter (inline-budget.js: isScaleCorroborated). A
// directive verb alone is opener detection, not scale — "fix typo" matches
// isDirective exactly as well as a genuine multi-file build, so a cold,
// isolated directive with no established inline drift yet never invites; a
// directive landing mid-drift does. Sells the value of a crew run
// (guidance.js: CREW_INVITATION) rather than commanding, once per crossing,
// then stays silent until re-armed by the same cadence as the PreToolUse
// border signal (inline-budget.js: isCrossingStale) — a muster run starting,
// SessionStart, or 60 minutes of inactivity — and even then, only once the
// shared invite cooldown (inline-budget.js: isInCooldown) has cleared, so a
// rapid re-arm cannot flap a repeat invite from this signal either.
//
// Self-contained apart from sibling guidance.js/inline-budget.js. FAIL-SAFE:
// whole body in try/catch; on ANY error or missing state, emit minimal valid
// JSON and exit 0.

import { readFileSync, writeFileSync, existsSync, statSync, unlinkSync } from "node:fs";
import path from "node:path";
import { emit, CREW_INVITATION, isDirective } from "./guidance.js";
import {
  directiveFile, isCrossingStale, cumFile, corroboratingCount, isScaleCorroborated,
  cooldownFile, isInCooldown, recordInvite,
} from "./inline-budget.js";

const EVENT = "UserPromptSubmit";

function directiveNudgeCopy() {
  return (
    `${CREW_INVITATION} This looks like directive work with no muster run active — ` +
    `try /muster:go (or /muster:plan to plan first).`
  );
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

  // Slash-command turns are explicit intent — never inject on them, and never
  // treat them as directive-shaped. Injecting context on a "/..." prompt is
  // noise, and in a relayed/remote session it can land ahead of the command
  // and break slash-command parsing.
  if (prompt.trimStart().startsWith("/")) {
    emit({ hookSpecificOutput: { hookEventName: EVENT } });
    process.exit(0);
  }

  let additionalContext;

  // The ONLY prompt-time nudge: isDirective-triggered, once per crossing.
  // Best-effort: any failure here degrades to silence (no nudge), never a crash.
  try {
    if (typeof sessionId === "string" && sessionId.length > 0) {
      const markerFile = directiveFile(sessionId);
      if (markerFile !== null) {
        const cwd =
          typeof payload.cwd === "string" && payload.cwd.length > 0 ? payload.cwd : process.cwd();
        let runActive = false;
        try {
          runActive = existsSync(path.join(cwd, ".muster", "run-active"));
        } catch {
          runActive = false;
        }

        if (runActive) {
          // A muster run resolves the invitation — re-arm for the next
          // post-run crossing (mirrors the PreToolUse cumulative counter's
          // reset-on-run-start). This happens on ANY turn where a run is
          // observed active, independent of this turn's prompt shape.
          try {
            unlinkSync(markerFile);
          } catch {
            /* not present — fine */
          }
        } else if (isDirective(prompt)) {
          let alreadyNudged = false;
          try {
            const { mtimeMs } = statSync(markerFile);
            alreadyNudged = !isCrossingStale(mtimeMs);
          } catch {
            alreadyNudged = false; // no marker yet — not nudged
          }
          if (!alreadyNudged) {
            // Scale correlation: a directive verb alone is opener detection,
            // not scale — require at least one distinct file already
            // recorded this crossing by the PreToolUse cumulative counter
            // before this signal may fire. A cold, isolated directive with
            // zero prior drift (e.g. "fix typo" as the very first ask) stays
            // silent here; the PreToolUse channel still catches real
            // multi-file drift on its own terms once it happens.
            const cFile = cumFile(sessionId);
            // corroboratingCount (not a raw readCum) so a dead prior
            // crossing's leftover file count -- the marker's own mtime past
            // CROSSING_MAX_AGE_MS -- never corroborates a brand-new,
            // genuinely trivial directive (review-gate finding).
            const priorCount = corroboratingCount(cFile);
            if (isScaleCorroborated(priorCount)) {
              const cdFile = cooldownFile(sessionId);
              if (!isInCooldown(cdFile)) {
                additionalContext = directiveNudgeCopy();
                recordInvite(cdFile);
                try {
                  writeFileSync(markerFile, "1");
                } catch {
                  /* best-effort */
                }
              }
              // cooldown active: stay silent and leave markerFile unwritten
              // so a still-corroborated directive can fire once it clears.
            }
          }
        }
      }
    }
  } catch {
    /* directive nudge is best-effort; fall back to silence */
  }

  const out = { hookEventName: EVENT };
  if (additionalContext) out.additionalContext = additionalContext;
  emit({ hookSpecificOutput: out });
} catch {
  emit({ hookSpecificOutput: { hookEventName: EVENT } });
}

process.exit(0);
