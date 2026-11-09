// muster shared guidance — the principles/verbs/routing text the Cowork MCP
// server (mcp/server.mjs) injects as its instructions, plus the emit() helper
// the PreToolUse action fence uses. No hook injects this text into a Claude
// Code session any more.
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
  "Verbs: /muster:plan (approve-first; a backlog scope confirms, then plans), /muster:go (hands-off lifecycle; same scope confirm), " +
  "/muster:plan-backlog (approve-first batch planner), /muster:diagnose (failure-first fix), /muster:audit (whole-codebase review-and-fix), " +
  "/muster:design (canonical design-context and workflow gate), /muster:go-backlog (batch backlog clear), /muster:runner (unattended one-cycle work-picker).";

// Voice anti-drift: a single reinforcement line the injected guidance carries, to
// counter the output voice regressing over long sessions the same way routing does.
export const VOICE_NUDGE =
  "Voice: terse and decision-first — done = verified with evidence inline; no recaps, no process narration.";

export const ROUTING_POLICY =
  [
    "Default routing: in this muster repo, drive actionable prompts through muster --",
    "route directives and substantive questions to the verbs (/muster:plan · :go ·",
    ":plan-backlog · :diagnose · :audit · :design · :go-backlog · :runner) where applicable, and",
    "content/copy work through the muster content pipeline (humanizer). Let conversational",
    "or trivial turns fall through. Honor explicit /muster commands as given.",
  ].join(" ") +
  " " +
  VOICE_NUDGE;

// Shared emit helper — writes a JSON object to stdout.
export function emit(obj) {
  process.stdout.write(JSON.stringify(obj));
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
