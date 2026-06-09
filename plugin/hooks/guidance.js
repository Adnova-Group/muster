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
  "/muster:diagnose (failure-first fix), /muster:audit (whole-codebase review-and-fix).";

export const ROUTING_POLICY = [
  "Default routing: in this muster repo, drive actionable prompts through muster —",
  "route directives and substantive questions to the verbs (/muster:run · :autopilot ·",
  ":diagnose · :audit) where applicable, and content/copy work through the muster content",
  "pipeline (humanizer). Let conversational or trivial turns fall through. Honor explicit",
  "/muster commands as given.",
].join(" ");

export const SHORT_NUDGE =
  "muster mode — drive directives through the muster verbs (don't default to plain inline " +
  "work), route copy/content through the humanizer, keep reasoning glass-box. Conversational " +
  "turns fall through. Verbs: /muster:run · /muster:autopilot · /muster:diagnose · /muster:audit.";

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
