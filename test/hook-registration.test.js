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
