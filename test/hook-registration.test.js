// Validates hooks.json structure and script path existence.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const HOOKS_JSON = path.join(ROOT, "plugin", "hooks", "hooks.json");

const VALID_EVENTS = new Set([
  "SessionStart",
  "UserPromptSubmit",
  "PreToolUse",
  "PostToolUse",
  "Stop",
  "SubagentStop",
  "SessionEnd",
  "PreCompact",
  "Notification",
]);

// Parse ${CLAUDE_PLUGIN_ROOT} as the plugin/ directory.
function resolveScript(command) {
  return command
    .replace(/\$\{CLAUDE_PLUGIN_ROOT\}/g, path.join(ROOT, "plugin"))
    .replace(/^node\s+"?/, "")
    .replace(/"$/, "")
    .trim();
}

test("hooks.json parses as valid JSON", () => {
  assert.doesNotThrow(() => JSON.parse(readFileSync(HOOKS_JSON, "utf8")), "hooks.json must be valid JSON");
});

test("hooks.json top-level keys are all valid hook event names", () => {
  const parsed = JSON.parse(readFileSync(HOOKS_JSON, "utf8"));
  const keys = Object.keys(parsed.hooks);
  assert.ok(keys.length > 0, "at least one hook event registered");
  for (const key of keys) {
    assert.ok(VALID_EVENTS.has(key), `"${key}" is not a valid hook event name`);
  }
});

// P1-6: the PreToolUse matcher must fire for EVERY mcp__* tool (not just names
// containing [Ss]end/[Ss]ubmit/[Pp]ublish/[Ss]ign/[Pp]urchase-shaped substrings).
// The old matcher only reached the hook for those keyword-ish tool names, so an
// MCP tool with different casing or wording never even invoked the hook — the
// action fence was dead for it. classifyToolName's word-boundary+case-insensitive
// keyword match (action-guard.js) is what actually narrows the class now; the
// matcher's only job is "get every mcp__* call to the hook at all."
test("hooks.json: PreToolUse matcher covers Edit|Write|NotebookEdit|Bash|mcp__.* (not a keyword subset)", () => {
  const parsed = JSON.parse(readFileSync(HOOKS_JSON, "utf8"));
  const entry = parsed.hooks.PreToolUse.find((e) =>
    e.hooks.some((h) => h.command.includes("pre-tool-use.js")),
  );
  assert.ok(entry, "PreToolUse entry running pre-tool-use.js must exist");
  assert.equal(
    entry.matcher,
    "Edit|Write|NotebookEdit|Bash|mcp__.*",
    "matcher must route every mcp__* tool to the hook; classification (case-insensitive, " +
    "word-boundary) happens in action-guard.js, not the matcher",
  );
});

test("every hook command's script path exists on disk", () => {
  const parsed = JSON.parse(readFileSync(HOOKS_JSON, "utf8"));
  for (const [event, entries] of Object.entries(parsed.hooks)) {
    for (const entry of entries) {
      for (const hook of entry.hooks) {
        assert.equal(hook.type, "command", `${event} hook must be type:command`);
        const scriptPath = resolveScript(hook.command);
        assert.ok(
          existsSync(scriptPath),
          `script for ${event} not found: ${scriptPath} (from command: ${hook.command})`,
        );
      }
    }
  }
});
