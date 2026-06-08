#!/usr/bin/env node
// muster SessionStart hook — injects always-on guidance into every session.
//
// FULLY SELF-CONTAINED: only node: builtins, no imports from ../src.
// The plugin ships only plugin/, so this script must stand alone.
//
// FAIL-SAFE: this runs at every session start. The entire body is wrapped in
// try/catch. On ANY error we print minimal valid JSON and exit 0. Never throw,
// never break the session, never hang — only a few existsSync calls.

import { existsSync } from "node:fs";
import path from "node:path";

const EVENT = "SessionStart";

function detect(cwd) {
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

function buildContext(cwd) {
  const principles = [
    "muster principles:",
    "- Think before coding; state your assumptions before you act.",
    "- TDD: write the failing test first, then make it pass.",
    "- Surgical changes: touch only what the task needs.",
    "- Glass-box reasoning: show the crew and the decisions, never hide them.",
    "- Prefer code over the model for deterministic work (routing, retries, transforms).",
    "- Fail loud: verify before claiming done.",
  ].join("\n");

  const verbs =
    "Verbs: /muster:run (plan + show), /muster:autopilot (hands-off lifecycle), " +
    "/muster:diagnose (failure-first fix), /muster:audit (whole-codebase review-and-fix).";

  return [principles, verbs, detect(cwd)].join("\n");
}

function emit(obj) {
  process.stdout.write(JSON.stringify(obj));
}

try {
  emit({
    hookSpecificOutput: {
      hookEventName: EVENT,
      additionalContext: buildContext(process.cwd()),
      sessionTitle: "muster",
    },
  });
} catch {
  // Minimal valid output so the session is never broken.
  emit({ hookSpecificOutput: { hookEventName: EVENT } });
}

process.exit(0);
