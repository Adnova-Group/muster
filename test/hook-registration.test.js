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
  "TaskCompleted",
]);

// Every hook runs in exec form (`command` + `args`, no shell): the script is the first `args`
// element, with ${CLAUDE_PLUGIN_ROOT} resolved to the plugin/ directory.
function resolveScript(hook) {
  return hook.args[0].replace(/\$\{CLAUDE_PLUGIN_ROOT\}/g, path.join(ROOT, "plugin"));
}

// Claude Code evaluates a matcher holding any regex character with RegExp.prototype.test,
// unanchored (code.claude.com/docs/en/hooks.md, "Matcher patterns").
function matches(matcher, toolName) {
  return new RegExp(matcher).test(toolName);
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

// P1-6: the PreToolUse matcher must fire for EVERY shell call and every external mcp__* tool
// (not just names containing send/submit/publish/sign/purchase-shaped substrings): the old
// keyword matcher never reached the hook for an MCP tool with other casing or wording, so the
// fence was dead for it. classifyToolName's word-boundary, case-insensitive match
// (action-guard.js) narrows the class; the matcher only routes calls to the hook. PowerShell is
// the primary Windows shell tool, so it rides with Bash. Edit/Write/NotebookEdit and exactly two
// Claude Desktop turn tools (mcp__ccd_turn__update_plan runs many times per Desktop session, and
// wrap_up) are deliberately absent: the fence never classifies them, and spawning node for each
// is pure always-on cost. The Desktop exclusion names full tool names, never a server or prefix,
// so a user server named ccd_<anything> still reaches the fence. The matcher is anchored because
// Claude Code tests it unanchored.
test("hooks.json: PreToolUse matcher routes shell and external mcp__* calls only", () => {
  const parsed = JSON.parse(readFileSync(HOOKS_JSON, "utf8"));
  const entry = parsed.hooks.PreToolUse.find((e) =>
    e.hooks.some((h) => (h.args || []).some((arg) => arg.endsWith("/hooks/pre-tool-use.js"))),
  );
  assert.ok(entry, "PreToolUse entry running pre-tool-use.js must exist");
  for (const tool of [
    "Bash", "PowerShell", "mcp__gmail__send_email", "mcp__docusign__sign_document",
    "mcp__plugin_acme_db__publish_release", "mcp__Stripe__Purchase", "mcp__ccdx__send",
    "mcp__claude_ai_Slack__slack_send_message", "mcp__ccd_evil__publish_post", "mcp__ccd_turn__publish",
    "mcp__ccd_turn__update_plan_and_send", "mcp__ccd_session__mark_chapter", "mcp__ccd_turn__wrap_up__x",
  ]) assert.ok(matches(entry.matcher, tool), `matcher must route ${tool} to the fence`);
  for (const tool of [
    "mcp__ccd_turn__update_plan", "mcp__ccd_turn__wrap_up", "Read", "Edit", "Write",
    "NotebookEdit", "BashOutput", "KillBash", "Monitor",
  ]) assert.ok(!matches(entry.matcher, tool), `matcher must not spawn the fence for ${tool}`);
});

// Exec form: Claude Code spawns node directly with the script path as one argument, so no shell
// is involved (a shell-form hook on Windows without Git Bash now blocks every call). The fence is
// advisory-safe to fail open, so a hook that cannot start or crashes never blocks the tool call.
test("hooks.json: every hook is exec form and fails open", () => {
  const parsed = JSON.parse(readFileSync(HOOKS_JSON, "utf8"));
  for (const [event, entries] of Object.entries(parsed.hooks)) {
    for (const entry of entries) {
      for (const hook of entry.hooks) {
        assert.equal(hook.command, "node", `${event} hook must spawn node directly`);
        assert.ok(Array.isArray(hook.args) && hook.args.length >= 1, `${event} hook must set args (exec form)`);
        assert.equal(hook.shell, undefined, `${event} hook must not select a shell`);
        assert.equal(hook.onFailure, "continue", `${event} hook must fail open`);
      }
    }
  }
});

// Zero cost until invoked: no hook may fire on session start or on every
// prompt. Only the run-scoped action fence stays registered (the TaskCompleted
// gate went with the native task board in revival stage 2b).
test("hooks.json registers no always-on SessionStart/UserPromptSubmit hooks", () => {
  const parsed = JSON.parse(readFileSync(HOOKS_JSON, "utf8"));
  assert.deepEqual(Object.keys(parsed.hooks).sort(), ["PreToolUse"]);
});

test("every hook command's script path exists on disk", () => {
  const parsed = JSON.parse(readFileSync(HOOKS_JSON, "utf8"));
  for (const [event, entries] of Object.entries(parsed.hooks)) {
    for (const entry of entries) {
      for (const hook of entry.hooks) {
        assert.equal(hook.type, "command", `${event} hook must be type:command`);
        const scriptPath = resolveScript(hook);
        assert.ok(
          existsSync(scriptPath),
          `script for ${event} not found: ${scriptPath} (from args: ${JSON.stringify(hook.args)})`,
        );
      }
    }
  }
});

// The matcher's Desktop exclusion and the hook's own skip list name the same exact tools, so a
// matcher edit cannot silently widen the hole past what the hook skips (or vice versa).
test("hooks.json: the matcher excludes exactly the hook's DESKTOP_HOST_TOOLS", async () => {
  const { DESKTOP_HOST_TOOLS } = await import("../plugin/hooks/action-guard.js");
  const parsed = JSON.parse(readFileSync(HOOKS_JSON, "utf8"));
  const { matcher } = parsed.hooks.PreToolUse[0];
  for (const tool of DESKTOP_HOST_TOOLS) {
    assert.ok(!matches(matcher, tool), `${tool} is in DESKTOP_HOST_TOOLS but the matcher still spawns it`);
    for (const near of [`${tool}x`, `${tool}_send`, tool.replace("mcp__ccd_turn__", "mcp__ccd_turnx__")]) {
      assert.ok(matches(matcher, near), `matcher must still route ${near}`);
    }
  }
  const excluded = /\(\?!ccd_turn__\(\?:([a-z_|]+)\)\$\)/.exec(matcher);
  assert.ok(excluded, "matcher's Desktop exclusion must be an anchored alternation of ccd_turn tool names");
  assert.deepEqual(
    excluded[1].split("|").map((name) => `mcp__ccd_turn__${name}`).sort(),
    [...DESKTOP_HOST_TOOLS].sort(),
  );
});
