// test/hermes-lane.test.js
//
// hermes-runner-lane-spike: fixture-driven tests for the thin, unwired
// scaffold at docs/strategy/hermes-lane/hermes-action-fence.js (deliberately
// NOT under plugin/hooks/ -- see that file's header for why). No live Hermes
// host is reachable from this repo (docs/research/hermes.md: no ~/.hermes, no
// `hermes` binary) -- these tests exercise the pure translation function in
// isolation against fixture payloads only. See docs/strategy/
// hermes-runner-lane.md for the design this scaffolds and the honest
// designed+probed/live-execution-needs-a-host framing.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mapActionFenceToHermes } from "../docs/strategy/hermes-lane/hermes-action-fence.js";

function mcpPayload(toolName, extra = {}) {
  return { tool_name: toolName, tool_input: {}, ...extra };
}

function bashPayload(command, extra = {}) {
  return { tool_name: "Bash", tool_input: { command }, ...extra };
}

test("deny mode: forbidden class match -> Hermes canonical block shape", () => {
  const result = mapActionFenceToHermes(mcpPayload("mcp__gmail__send_email"), ["send"], "deny");
  assert.deepEqual(Object.keys(result).sort(), ["action", "message"]);
  assert.equal(result.action, "block");
  assert.match(result.message, /Action class "send" is forbidden/);
  assert.match(result.message, /MUSTER_ACTION_GUARD=warn or off/);
});

test("deny mode: bash publish command matches the same classifier as the Claude Code fence", () => {
  const result = mapActionFenceToHermes(bashPayload("git push origin main"), ["publish"], "deny");
  assert.equal(result.action, "block");
  assert.match(result.message, /"publish"/);
});

test("no match -> null (fail-open, no block response)", () => {
  const result = mapActionFenceToHermes(mcpPayload("Edit"), ["send", "publish"], "deny");
  assert.equal(result, null);
});

test("class matches but not in the forbidden set -> null", () => {
  const result = mapActionFenceToHermes(mcpPayload("mcp__gmail__send_email"), ["publish"], "deny");
  assert.equal(result, null);
});

test("off mode -> null even on a matching class", () => {
  const result = mapActionFenceToHermes(mcpPayload("mcp__gmail__send_email"), ["send"], "off");
  assert.equal(result, null);
});

test("warn mode -> null: pre_tool_call has no allow-with-context analog (documented port gap)", () => {
  const result = mapActionFenceToHermes(mcpPayload("mcp__gmail__send_email"), ["send"], "warn");
  assert.equal(result, null);
});

test("empty forbidden-classes set -> null regardless of mode", () => {
  const result = mapActionFenceToHermes(mcpPayload("mcp__gmail__send_email"), [], "deny");
  assert.equal(result, null);
});

test("harness-internal tool names are never classified, matching action-guard's mcp__-only scope", () => {
  const result = mapActionFenceToHermes(mcpPayload("TaskCreate"), ["send", "submit", "publish", "sign", "purchase"], "deny");
  assert.equal(result, null);
});

test("non-array forbiddenClasses (undefined/null) -> null, never throws", () => {
  assert.equal(mapActionFenceToHermes(mcpPayload("mcp__gmail__send_email"), undefined, "deny"), null);
  assert.equal(mapActionFenceToHermes(mcpPayload("mcp__gmail__send_email"), null, "deny"), null);
});

test("unrecognized mode string falls through to deny (fail-closed, mirrors pre-tool-use.js's MUSTER_ACTION_GUARD handling)", () => {
  const result = mapActionFenceToHermes(mcpPayload("mcp__gmail__send_email"), ["send"], "not-a-real-mode");
  assert.equal(result.action, "block");
  assert.match(result.message, /"send"/);
});
