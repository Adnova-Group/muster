// coordination/SKILL.md Binding A (GitHub issues) claim-window rules, extracted verbatim
// from eval/modes/grade-lib.mjs so shipped runtime code (a real runner reading a live
// comment thread) and the eval's grader share one executable source of truth for this
// protocol instead of two hand-synced copies. Behavior is unchanged from grade-lib.mjs's
// prior inline definitions -- eval/modes/grade-lib.mjs now imports these from here.
//
// Binding A's exact receipt grammar: comments are `MUSTER
// CLAIMED|DONE|BLOCKED|HUMAN-HOLD|FAILED|YIELD <runner> <ts>`, first line fixed, free-text
// detail may follow on later (non-MUSTER-prefixed) lines of the SAME comment -- those are
// ignored by classifyMusterLine, not grammar violations. The claim-window race rule is
// genuinely deterministic (an ordering computation over timestamps) but has no other
// shipped-code home -- it lives here now, not encoded twice.
export const MUSTER_RECEIPT_PATTERNS = {
  CLAIMED: /^MUSTER CLAIMED (\S+) (\S+)(?:\s.*)?$/,
  DONE: /^MUSTER DONE (\S+) (\S+)(?:\s.*)?$/,
  BLOCKED: /^MUSTER BLOCKED (\S+) (\S+)(?:\s.*)?$/,
  // HUMAN-HOLD is the narrower BLOCKED variant (coordination/SKILL.md): floor-resetting
  // exactly like DONE/BLOCKED/FAILED (see computeClaimWindows below), but its resume gate
  // is stricter -- only the named `authorizer=<login>` can answer it, see
  // isHumanHoldResumeAuthorized below.
  "HUMAN-HOLD": /^MUSTER HUMAN-HOLD (\S+) (\S+)(?:\s.*)?$/,
  FAILED: /^MUSTER FAILED (\S+) (\S+)(?:\s.*)?$/,
  YIELD: /^MUSTER YIELD (\S+) (\S+)(?:\s.*)?$/,
};

// Walk the thread chronologically (events are assumed already in the fixture's/real
// thread's posted order), accumulating CLAIMED comments into the CURRENT open window.
// Each DONE/BLOCKED/HUMAN-HOLD/FAILED terminal comment resolves that window (its earliest
// claim is the winner, every other claim in it a loser) and starts a fresh one --
// deliberately NOT YIELD (coordination/SKILL.md's own rationale: a loser's yield landing
// before the winner's re-read would otherwise floor the winner's own claim out of its
// window, making the win undecidable). Returns every window plus `current`, the still-open
// (possibly unresolved) trailing window a live thread ends in.
export function computeClaimWindows(events) {
  const windows = [];
  let claims = [];
  let floor = "";
  const resolve = (resolvedBy) => {
    const sorted = [...claims].sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : a.runner.localeCompare(b.runner)));
    windows.push({ floor, claims: sorted, winner: sorted[0] || null, losers: sorted.slice(1), resolvedBy });
  };
  for (const e of events) {
    if (e.type === "CLAIMED") claims.push(e);
    else if (e.type === "DONE" || e.type === "BLOCKED" || e.type === "HUMAN-HOLD" || e.type === "FAILED") {
      resolve(e);
      floor = e.ts;
      claims = [];
    }
    // YIELD: never resolves or floors a window -- ignored for this walk.
  }
  const current = claims.length || windows.length === 0 ? (resolve(null), windows[windows.length - 1]) : windows[windows.length - 1];
  return { windows, current };
}

// Convenience wrapper: the winner/losers of the thread's CURRENT (most recent, possibly
// still-open) claim window -- what a runner reading the thread right now would compute.
export function computeClaimWindowWinner(events) {
  return computeClaimWindows(events).current;
}

// coordination/SKILL.md's HUMAN-HOLD resume rule (stricter than BLOCKED's "any reply"):
// only a reply from the exact `authorizer=<login>` its own HUMAN-HOLD receipt named
// resumes it -- matched by the replying comment's AUTHOR, not a body token (the inverse
// of the CLAIMED race's own identity problem above, where the body token is authoritative
// because runners share one GitHub login). Fixture/thread convention: a non-MUSTER reply
// line is `REPLY <author>: <text>`, author = the comment's `.user.login`.
const REPLY_LINE_RE = /^REPLY (\S+): (.+)$/;
const HUMAN_HOLD_AUTHORIZER_RE = /authorizer=(\S+)/;

export function isHumanHoldResumeAuthorized(lines) {
  let authorizer = null;
  let resumed = false;
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    const hh = MUSTER_RECEIPT_PATTERNS["HUMAN-HOLD"].exec(line);
    if (hh) {
      const m = HUMAN_HOLD_AUTHORIZER_RE.exec(line);
      authorizer = m ? m[1] : null;
      resumed = false;
      continue;
    }
    if (authorizer && !resumed) {
      const reply = REPLY_LINE_RE.exec(line);
      if (reply && reply[1] === authorizer) resumed = true;
    }
  }
  return { authorizer, resumed };
}
