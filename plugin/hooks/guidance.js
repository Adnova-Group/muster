// muster shared guidance — single source of truth for the text the hooks inject.
//
// SELF-CONTAINED: only node: builtins. Ships under plugin/, must stand alone.
import { existsSync } from "node:fs";
import path from "node:path";

export const PRINCIPLES = [
  "muster principles:",
  "- Think before coding; state your assumptions before you act.",
  "- TDD: write the failing test first, then make it pass.",
  "- Surgical changes: touch only what the task needs.",
  "- Glass-box reasoning: show the crew and the decisions, never hide them.",
  "- Prefer code over the model for deterministic work (routing, retries, transforms).",
  "- Fail loud: verify before claiming done.",
].join("\n");

export const VERBS =
  "Verbs: /muster:run (plan + show), /muster:autopilot (hands-off lifecycle), " +
  "/muster:diagnose (failure-first fix), /muster:audit (whole-codebase review-and-fix), " +
  "/muster:sprint (batch backlog drain), /muster:runner (unattended one-cycle work-picker).";

// Voice anti-drift: a single reinforcement line every nudge tier must carry, to
// counter the output voice regressing over long sessions the same way routing does.
export const VOICE_NUDGE =
  "Voice: terse and decision-first — done = verified with evidence inline; no recaps, no process narration.";

export const ROUTING_POLICY =
  [
    "Default routing: in this muster repo, drive actionable prompts through muster —",
    "route directives and substantive questions to the verbs (/muster:run · :autopilot ·",
    ":diagnose · :audit · :sprint · :runner) where applicable, and content/copy work through",
    "the muster content pipeline (humanizer). Let conversational or trivial turns fall through.",
    "Honor explicit /muster commands as given.",
  ].join(" ") +
  " " +
  VOICE_NUDGE;

export const SHORT_NUDGE =
  "muster mode — drive directives through the muster verbs (don't default to plain inline " +
  "work), route copy/content through the humanizer, keep reasoning glass-box. Conversational " +
  "turns fall through. Verbs: /muster:run · /muster:autopilot · /muster:diagnose · /muster:audit · " +
  "/muster:sprint · /muster:runner. " +
  VOICE_NUDGE;

// Shared emit helper — writes a JSON object to stdout.
export function emit(obj) {
  process.stdout.write(JSON.stringify(obj));
}

// ── isDirective ───────────────────────────────────────────────────────────────
// Deterministic, pure, case-insensitive detector for "directive-shaped" prompts:
// an imperative verb (optionally preceded by a polite lead-in) as the prompt's
// opening word. No I/O — used by user-prompt-submit.js to trigger an immediate
// routing nudge instead of waiting for the periodic cadence.
const DIRECTIVE_PREFIXES = [
  "please",
  "can you",
  "could you",
  "let's",
  "lets",
  "now",
  "go",
  "ok",
  "okay",
];

const DIRECTIVE_VERBS = [
  "fix",
  "build",
  "implement",
  "add",
  "create",
  "write",
  "refactor",
  "migrate",
  "update",
  "remove",
  "rename",
  "convert",
  "make",
];

function escapeForRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const PREFIX_ALT = DIRECTIVE_PREFIXES.map(escapeForRegex).join("|");
const VERB_ALT = DIRECTIVE_VERBS.join("|");

// Zero or more polite lead-ins, then one of the imperative verbs, as the whole
// prompt's opening word (bounded by \b so "fixing"/"updates" etc. don't match).
const DIRECTIVE_RE = new RegExp(`^(?:(?:${PREFIX_ALT})\\s+)*(?:${VERB_ALT})\\b`, "i");

export function isDirective(prompt) {
  if (typeof prompt !== "string") return false;
  const trimmed = prompt.trim();
  if (trimmed.length === 0) return false;
  if (trimmed.startsWith("/")) return false;
  if (trimmed.endsWith("?")) return false;
  const match = DIRECTIVE_RE.exec(trimmed);
  if (!match) return false;
  // Tighten false positives: a verb immediately followed by ":" (a status
  // update headline, e.g. "Update: shipped...") or by the word "for" (a
  // noun-phrase headline, e.g. "Fix for the login bug is in review.") is not
  // an imperative directive, even though it opens with a directive verb.
  const rest = trimmed.slice(match[0].length);
  if (/^\s*:/.test(rest)) return false;
  if (/^\s+for\b/i.test(rest)) return false;
  return true;
}

export function detect(cwd) {
  const has = (f) => {
    try {
      return existsSync(path.join(cwd, f));
    } catch {
      return false;
    }
  };

  const git = has(".git");
  let stack;
  if (has("package.json")) stack = "Node project";
  else if (has("pyproject.toml")) stack = "Python project";
  else if (has("go.mod")) stack = "Go project";
  else if (has("Cargo.toml")) stack = "Rust project";

  if (!stack) {
    return git
      ? "Detected: a git repo with no recognized project type"
      : "No recognized project in the current directory";
  }
  return git ? `Detected: ${stack} in a git repo` : `Detected: ${stack}`;
}
