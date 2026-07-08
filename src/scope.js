// Deterministic backlog-vs-item scope detection for the plan/go verb family.
//
// Only DETERMINISTIC signals live here. Judgment about multi-deliverable intent buried in
// prose ("add three things: ...") stays out of this module entirely — that stays mode
// prose's job at the AskUserQuestion confirm step; this module only ever answers from
// hard facts (a parseable ref, a file that exists and looks like a checklist, a live
// default backlog file). Rules, in the order they are checked:
//
//   1. text parses as a backlog ref (file/issues/linear — reusing batch-plan.js's
//      parseBacklogRef, plan-backlog.md B1's grammar) -> backlog. Parseability alone is
//      enough, same as parseBacklogRef's own stance: existence is the caller's job.
//   2. text names an existing, readable file whose content looks like a backlog
//      checklist (has a `- [ ] ` line) -> backlog. Broader than rule 1: no .md
//      extension or whitespace-free-token requirement, just "is this really a backlog".
//   3. text is empty/whitespace AND the default `.muster/backlog.md` exists under cwd
//      with >=1 unchecked item -> backlog (bare invocation against a live backlog).
//   4. text is non-empty and none of the above matched -> item. A malformed backlog ref
//      (parseBacklogRef kind "invalid", e.g. "issues:") still resolves to item — the
//      boundary decision holds — but carries a distinct malformed-ref signal instead of
//      the generic outcome-sentence one, so a typo'd ref doesn't silently pass for a
//      real single-item outcome.
//   5. text is empty and no live default backlog -> ambiguous.
//
// Rules 1-3 all independently contribute a signal to the same "backlog" verdict when they
// fire (multiple can fire at once, e.g. a .md ref that also happens to exist and have
// checklist items) — every signal that matched is returned so the mode's confirm question
// can cite all of them, not just the first.
import { readFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { parseBacklogRef } from "./batch-plan.js";

const UNCHECKED_ITEM_RE = /^- \[ \] /;

// Signals get echoed verbatim into the AskUserQuestion confirm-question UI, so raw
// user-supplied text must never be interpolated into one unbounded/unescaped: a 200KB
// blob or a newline-laden paste would produce a signal that breaks that UI, an ANSI CSI
// sequence could rewrite terminal/UI chrome, and a Unicode bidi-control character could
// make the excerpt visually reorder without changing its underlying bytes (Trojan-Source
// style spoofing) -- none of those are things a confirm-question echo should ever carry.
// Every signal that quotes user text runs it through sanitizeForSignal first: ANSI escape
// sequences and bidi-control characters are stripped outright, then whitespace runs
// (including newlines) collapse to a single space, then the excerpt is capped at
// SIGNAL_EXCERPT_MAX chars with a trailing ellipsis.
const SIGNAL_EXCERPT_MAX = 80;

// CSI-style ANSI escape sequences (e.g. `\x1b[31m`, `\x1b[0m`).
const ANSI_ESCAPE_RE = /\x1b\[[0-9;]*[a-zA-Z]/g;
// Unicode bidi-control/formatting characters: LRM/RLM (U+200E/U+200F), ALM (U+061C),
// LRE/RLE/PDF/LRO/RLO (U+202A-U+202E), and LRI/RLI/FSI/PDI (U+2066-U+2069).
const BIDI_CONTROL_RE = /[‎‏؜‪-‮⁦-⁩]/g;

function sanitizeForSignal(text) {
  const stripped = String(text).replace(ANSI_ESCAPE_RE, "").replace(BIDI_CONTROL_RE, "");
  const collapsed = stripped.replace(/\s+/g, " ").trim();
  if (collapsed.length <= SIGNAL_EXCERPT_MAX) return collapsed;
  return `${collapsed.slice(0, SIGNAL_EXCERPT_MAX - 1)}…`;
}

// Count `- [ ] ` (unchecked) checklist lines in a markdown string, leading-whitespace
// tolerant per line (mirrors sprint-waves.js's own CHECKBOX_RE stripping convention).
function countUncheckedItems(content) {
  if (typeof content !== "string") return 0;
  let n = 0;
  for (const line of content.split(/\r?\n/)) {
    if (UNCHECKED_ITEM_RE.test(line.replace(/^\s+/, ""))) n++;
  }
  return n;
}

// Windows drive-letter ("C:\x" or "C:/x") and UNC ("\\server\x") path shapes. node:path's
// isAbsolute is platform-DYNAMIC: on a POSIX runtime it returns false for both of these, so
// a Windows-absolute candidate would otherwise slip through isTraversalUnsafe as merely
// "relative" and reach join()/readFile() below (mirrors src/batch-plan.js's parseBacklogRef
// guard, which carries the identical pair for the same reason).
const WINDOWS_DRIVE_RE = /^[A-Za-z]:[\\/]/;
const WINDOWS_UNC_RE = /^\\\\/;

// Traversal guard (mirrors src/memory.js's writeMemory/appendState/appendFollowup
// slug/runId checks): rejects an absolute path (POSIX or Windows-shaped) or any ".."
// substring before it ever reaches join()/readFile(). Without this, untrusted CLI/issue
// text landed directly in a real filesystem read with no boundary check at all -- P0
// arbitrary-file-read: a relative "../../etc/passwd" traversed outside cwd via path.join,
// and an absolute candidate was passed straight through unmodified.
function isTraversalUnsafe(rawSegment) {
  return (
    typeof rawSegment !== "string" ||
    isAbsolute(rawSegment) ||
    WINDOWS_DRIVE_RE.test(rawSegment) ||
    WINDOWS_UNC_RE.test(rawSegment) ||
    rawSegment.includes("..")
  );
}

// Reads `safeCwd`-joined `rawSegment` if it passes the traversal guard, exists, and is a
// readable file; returns { readable, count } where count is its unchecked-item tally. An
// unsafe segment, or any read failure (missing, a directory, EACCES, ...), degrades to
// { readable: false, count: 0 } — existence/readability/safety is exactly what this
// function is answering, so a "no" here is the answer, not an error to throw. This is the
// only place src/scope.js calls readFile, so the guard applies before every read.
async function readBacklogCandidate(safeCwd, rawSegment) {
  if (isTraversalUnsafe(rawSegment)) return { readable: false, count: 0 };
  try {
    const content = await readFile(join(safeCwd, rawSegment), "utf8");
    return { readable: true, count: countUncheckedItems(content) };
  } catch {
    return { readable: false, count: 0 };
  }
}

export async function detectScope({ cwd = process.cwd(), text = "" } = {}) {
  // Degrade gracefully on a bad cwd (non-string, empty, null, ...) instead of throwing
  // out of path.join below — the module's whole stance is "hard facts or a safe default,
  // never a crash", and cwd is just another input to that same discipline.
  const safeCwd = typeof cwd === "string" && cwd !== "" ? cwd : process.cwd();
  const raw = typeof text === "string" ? text : "";
  const trimmed = raw.trim();
  const signals = [];

  // Rule 1: a parseable backlog ref (file/issues/linear kinds only — "outcome" carries no
  // rule-1 signal here; "invalid" is handled distinctly below once we know no other rule
  // fired, so a typo'd ref doesn't silently read as a generic outcome sentence).
  const ref = parseBacklogRef(trimmed);
  if (ref.kind === "file") {
    signals.push(`"${sanitizeForSignal(ref.path)}" parses as a backlog file ref`);
  } else if (ref.kind === "issues") {
    signals.push(`"issues:${sanitizeForSignal(ref.label)}" parses as a GitHub-issues backlog ref`);
  } else if (ref.kind === "linear") {
    signals.push(`"linear:${sanitizeForSignal(ref.key)}" parses as a Linear backlog ref`);
  }

  // Rule 2: text names an existing, readable file that looks like a backlog checklist.
  // readBacklogCandidate applies the traversal guard itself (absolute paths and ".."
  // segments never reach a real read) — an unsafe candidate degrades to the same "no"
  // answer as a missing file, contributing no signal.
  if (trimmed !== "") {
    const { readable, count } = await readBacklogCandidate(safeCwd, trimmed);
    if (readable && count > 0) {
      signals.push(
        `"${sanitizeForSignal(trimmed)}" is a readable file with ${count} unchecked item${count === 1 ? "" : "s"}`
      );
    }
  }

  // Rule 3: bare invocation (empty/whitespace text) against a live default backlog.
  if (trimmed === "") {
    const { readable, count } = await readBacklogCandidate(safeCwd, join(".muster", "backlog.md"));
    if (readable && count > 0) {
      signals.push(`.muster/backlog.md has ${count} unchecked item${count === 1 ? "" : "s"} (bare invocation)`);
    }
  }

  if (signals.length > 0) {
    return { scope: "backlog", signals };
  }

  // Rule 4: non-empty text, no backlog signal -> a single-item outcome. A malformed
  // backlog ref (parseBacklogRef kind "invalid", e.g. "issues:") gets a distinct signal
  // instead of the generic outcome-sentence one: the boundary decision still holds
  // (item), but a typo'd ref should never look identical to a real outcome sentence.
  if (trimmed !== "") {
    const excerpt = sanitizeForSignal(trimmed);
    if (ref.kind === "invalid") {
      return {
        scope: "item",
        signals: [
          `"${excerpt}" looks like a malformed backlog reference — treating as an outcome; check the ref syntax if you meant a backlog`,
        ],
      };
    }
    return { scope: "item", signals: [`"${excerpt}" is an outcome, not a backlog ref`] };
  }

  // Rule 5: empty text, no live default backlog -> genuinely ambiguous.
  return { scope: "ambiguous", signals: ["empty invocation and no live backlog found at .muster/backlog.md"] };
}
