// test/hook-pre-tool-use-action-fence.test.js
//
// Action-class fence: a third fence dimension (action-scoped, distinct from the
// path-scoped owns/frozen fences). While a run is active (.muster/run-active)
// AND the orchestrator has written .muster/forbidden-actions (one class per
// line, from the manifest at run start), a tool call classified into one of
// those forbidden classes is denied. Fail-open on everything else.

import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import os from "node:os";
import { cleanDir, makeRunActive, spawnHook } from "./test-support/hook-helpers.js";
import { classifyToolName, classifyBashCommand, classifyAction } from "../plugin/hooks/action-guard.js";

const HOOK = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "plugin",
  "hooks",
  "pre-tool-use.js",
);

function runRaw(stdinText, env = {}) {
  return spawnHook(HOOK, stdinText, env);
}

// Build a tmp dir with .muster/run-active present (a live run).
function makeRunDir() {
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), "muster-action-fence-test-"));
  makeRunActive(tmpDir);
  return tmpDir;
}

function writeForbidden(tmpDir, classes) {
  writeFileSync(path.join(tmpDir, ".muster", "forbidden-actions"), classes.join("\n"));
}

function mcpPayload(toolName, cwd, extra = {}) {
  return JSON.stringify({ tool_name: toolName, tool_input: {}, cwd, ...extra });
}

function bashPayload(command, cwd, extra = {}) {
  return JSON.stringify({ tool_name: "Bash", tool_input: { command }, cwd, ...extra });
}

// ── pure classification unit tests ──────────────────────────────────────────

test("classifyToolName: mcp send-shaped tool name classifies as send", () => {
  assert.equal(classifyToolName("mcp__gmail__send_email"), "send");
});

test("classifyToolName: publish-shaped tool name classifies as publish", () => {
  assert.equal(classifyToolName("mcp__blog__publish_post"), "publish");
});

test("classifyToolName: unrelated tool name classifies as null", () => {
  assert.equal(classifyToolName("Edit"), null);
  assert.equal(classifyToolName("Read"), null);
});

test("classifyToolName: non-string input is null", () => {
  assert.equal(classifyToolName(undefined), null);
  assert.equal(classifyToolName(""), null);
});

// ── F1: action classification is scoped to external-effect surfaces (mcp__*) ──
// Harness-internal tools are never action-classified, no matter how their name
// reads — action fences gate external effects, not the orchestrator's own
// machinery (SendMessage, SendUserFile, TaskCreate/TaskUpdate, Agent, etc).
test("classifyToolName: harness-internal SendMessage is null (not action-classified)", () => {
  assert.equal(classifyToolName("SendMessage"), null);
});

test("classifyToolName: harness-internal SendUserFile is null (not action-classified)", () => {
  assert.equal(classifyToolName("SendUserFile"), null);
});

test("classifyToolName: harness-internal TaskCreate/TaskUpdate/Agent are null", () => {
  assert.equal(classifyToolName("TaskCreate"), null);
  assert.equal(classifyToolName("TaskUpdate"), null);
  assert.equal(classifyToolName("Agent"), null);
});

test("classifyToolName: mcp__ prefixed tool names still classify normally", () => {
  assert.equal(classifyToolName("mcp__claude_ai_Slack__slack_send_message"), "send");
});

// ── F4: word-boundary keyword match — 'sign' must not match inside 'assign' ──
test("classifyToolName: manage-assignments is null (no 'sign' substring false-positive)", () => {
  assert.equal(classifyToolName("mcp__todoist__manage-assignments"), null);
});

test("classifyToolName: a real sign-shaped tool name still classifies as sign", () => {
  assert.equal(classifyToolName("mcp__docusign__sign_document"), "sign");
});

// ── P1-6: matcher-vs-classifier split ───────────────────────────────────────
// hooks.json's PreToolUse matcher is now the wide "mcp__.*" (see
// hook-registration.test.js for the matcher-string pin) — it no longer filters
// by keyword casing/shape, so EVERY mcp__* tool call reaches this hook. The
// actual class narrowing (case-insensitive, word-boundary) happens here, in
// classifyToolName. This test pins that an ALL-CAPS action word still
// classifies correctly once the call reaches the classifier.
test("classifyToolName: ALL-CAPS action word still classifies (case-insensitive)", () => {
  assert.equal(classifyToolName("mcp__x__SEND_EMAIL"), "send");
});

// ── P1-12: purchase-class classification ────────────────────────────────────
test("classifyToolName: purchase-shaped tool name classifies as purchase", () => {
  assert.equal(classifyToolName("mcp__shop__purchase_item"), "purchase");
});

test("classifyBashCommand: npm publish classifies as publish", () => {
  assert.equal(classifyBashCommand("npm publish"), "publish");
});

test("classifyBashCommand: gh release create classifies as publish", () => {
  assert.equal(classifyBashCommand("gh release create v1.0.0"), "publish");
});

test("classifyBashCommand: git push classifies as publish", () => {
  assert.equal(classifyBashCommand("git push origin main"), "publish");
});

test("classifyBashCommand: curl -X POST classifies as send", () => {
  assert.equal(classifyBashCommand("curl -X POST https://example.com/webhook"), "send");
});

test("classifyBashCommand: gh pr merge classifies as submit", () => {
  assert.equal(classifyBashCommand("gh pr merge 42"), "submit");
});

// ── P1-12: git push --delete is ordered before the plain-push publish match ──
test("classifyBashCommand: git push origin --delete foo classifies as delete-remote (not publish)", () => {
  assert.equal(classifyBashCommand("git push origin --delete foo"), "delete-remote");
});

test("classifyBashCommand: unrelated command classifies as null", () => {
  assert.equal(classifyBashCommand("npm test"), null);
  assert.equal(classifyBashCommand("git log --oneline"), null);
});

test("classifyAction: dispatches Bash payloads through classifyBashCommand", () => {
  assert.equal(classifyAction({ tool_name: "Bash", tool_input: { command: "npm publish" } }), "publish");
});

test("classifyAction: dispatches non-Bash payloads through classifyToolName", () => {
  assert.equal(classifyAction({ tool_name: "mcp__gmail__send_email", tool_input: {} }), "send");
});

// ── hook integration: deny ──────────────────────────────────────────────────

test("deny: mcp send-shaped tool_name when 'send' is forbidden and a run is active", async () => {
  const tmpDir = makeRunDir();
  writeForbidden(tmpDir, ["send"]);
  try {
    const { stdout, code } = await runRaw(mcpPayload("mcp__gmail__send_email", tmpDir));
    assert.equal(code, 0);
    const out = JSON.parse(stdout).hookSpecificOutput;
    assert.equal(out.permissionDecision, "deny", "forbidden send action must be denied");
    assert.match(out.permissionDecisionReason, /send/i, "reason names the forbidden class");
    assert.match(out.permissionDecisionReason, /forbidden-actions|MUSTER_ACTION_GUARD/i, "reason names the override");
  } finally {
    cleanDir(tmpDir);
  }
});

test("deny: npm publish Bash command when 'publish' is forbidden and a run is active", async () => {
  const tmpDir = makeRunDir();
  writeForbidden(tmpDir, ["publish"]);
  try {
    const { stdout, code } = await runRaw(bashPayload("npm publish", tmpDir));
    assert.equal(code, 0);
    const out = JSON.parse(stdout).hookSpecificOutput;
    assert.equal(out.permissionDecision, "deny", "forbidden publish action must be denied");
    assert.match(out.permissionDecisionReason, /publish/i, "reason names the forbidden class");
  } finally {
    cleanDir(tmpDir);
  }
});

// ── F1: harness-internal tools never action-classified (hook integration) ──
test("allow: SendMessage is never action-classified, even with 'send' forbidden and a run active", async () => {
  const tmpDir = makeRunDir();
  writeForbidden(tmpDir, ["send"]);
  try {
    const { stdout, code } = await runRaw(mcpPayload("SendMessage", tmpDir));
    assert.equal(code, 0);
    const out = JSON.parse(stdout).hookSpecificOutput;
    assert.notEqual(out.permissionDecision, "deny", "harness-internal SendMessage must never be action-classified");
  } finally {
    cleanDir(tmpDir);
  }
});

test("allow: SendUserFile is never action-classified, even with 'send' forbidden and a run active", async () => {
  const tmpDir = makeRunDir();
  writeForbidden(tmpDir, ["send"]);
  try {
    const { stdout, code } = await runRaw(mcpPayload("SendUserFile", tmpDir));
    assert.equal(code, 0);
    const out = JSON.parse(stdout).hookSpecificOutput;
    assert.notEqual(out.permissionDecision, "deny", "harness-internal SendUserFile must never be action-classified");
  } finally {
    cleanDir(tmpDir);
  }
});

// ── P1-6: end-to-end, ALL-CAPS mcp tool name still denies via the fence ─────
// The matcher (hooks.json) can't be exercised in-process — this hits the hook
// itself with a payload shaped like what the "mcp__.*" matcher would forward.
// See hook-registration.test.js for the matcher-string pin and the
// classifyToolName case-handling unit test above for the classifier half.
test("deny: ALL-CAPS mcp tool_name (mcp__x__SEND_EMAIL) when 'send' is forbidden and a run is active", async () => {
  const tmpDir = makeRunDir();
  writeForbidden(tmpDir, ["send"]);
  try {
    const { stdout, code } = await runRaw(mcpPayload("mcp__x__SEND_EMAIL", tmpDir));
    assert.equal(code, 0);
    const out = JSON.parse(stdout).hookSpecificOutput;
    assert.equal(out.permissionDecision, "deny", "ALL-CAPS send-shaped tool must still be denied");
    assert.match(out.permissionDecisionReason, /send/i, "reason names the forbidden class");
  } finally {
    cleanDir(tmpDir);
  }
});

test("deny: mcp__claude_ai_Slack__slack_send_message still classifies as send and is denied", async () => {
  const tmpDir = makeRunDir();
  writeForbidden(tmpDir, ["send"]);
  try {
    const { stdout, code } = await runRaw(mcpPayload("mcp__claude_ai_Slack__slack_send_message", tmpDir));
    assert.equal(code, 0);
    const out = JSON.parse(stdout).hookSpecificOutput;
    assert.equal(out.permissionDecision, "deny", "external mcp__ send tool must still be denied");
  } finally {
    cleanDir(tmpDir);
  }
});

// ── hook integration: allow / fail-open ─────────────────────────────────────

test("allow: forbidden-actions file absent (no run-scoped fence) even with run-active", async () => {
  const tmpDir = makeRunDir();
  // No forbidden-actions file written.
  try {
    const { stdout, code } = await runRaw(bashPayload("npm publish", tmpDir));
    assert.equal(code, 0);
    const out = JSON.parse(stdout).hookSpecificOutput;
    assert.notEqual(out.permissionDecision, "deny", "no forbidden-actions file must fail-open");
  } finally {
    cleanDir(tmpDir);
  }
});

test("allow: run-active absent even when forbidden-actions file is present", async () => {
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), "muster-action-fence-test-"));
  mkdirSync(path.join(tmpDir, ".muster"), { recursive: true });
  writeForbidden(tmpDir, ["publish"]);
  try {
    const { stdout, code } = await runRaw(bashPayload("npm publish", tmpDir));
    assert.equal(code, 0);
    const out = JSON.parse(stdout).hookSpecificOutput;
    assert.notEqual(out.permissionDecision, "deny", "no run-active must fail-open");
  } finally {
    cleanDir(tmpDir);
  }
});

test("allow: action class classified but not in the forbidden set", async () => {
  const tmpDir = makeRunDir();
  writeForbidden(tmpDir, ["send"]); // publish is not listed
  try {
    const { stdout, code } = await runRaw(bashPayload("npm publish", tmpDir));
    assert.equal(code, 0);
    const out = JSON.parse(stdout).hookSpecificOutput;
    assert.notEqual(out.permissionDecision, "deny", "unlisted class must be allowed");
  } finally {
    cleanDir(tmpDir);
  }
});

test("warn: MUSTER_ACTION_GUARD=warn allows with additionalContext instead of denying", async () => {
  const tmpDir = makeRunDir();
  writeForbidden(tmpDir, ["publish"]);
  try {
    const { stdout, code } = await runRaw(bashPayload("npm publish", tmpDir), { MUSTER_ACTION_GUARD: "warn" });
    assert.equal(code, 0);
    const out = JSON.parse(stdout).hookSpecificOutput;
    assert.notEqual(out.permissionDecision, "deny", "warn mode must not deny");
    assert.ok("additionalContext" in out, "warn mode must emit additionalContext");
    assert.match(out.additionalContext, /publish/i, "warn context names the class");
  } finally {
    cleanDir(tmpDir);
  }
});

test("off: MUSTER_ACTION_GUARD=off silently allows a forbidden action", async () => {
  const tmpDir = makeRunDir();
  writeForbidden(tmpDir, ["publish"]);
  try {
    const { stdout, code } = await runRaw(bashPayload("npm publish", tmpDir), { MUSTER_ACTION_GUARD: "off" });
    assert.equal(code, 0);
    const out = JSON.parse(stdout).hookSpecificOutput;
    assert.notEqual(out.permissionDecision, "deny", "off mode must not deny");
  } finally {
    cleanDir(tmpDir);
  }
});

test("fail-open: forbidden-actions is an unreadable directory (not a file)", async () => {
  const tmpDir = makeRunDir();
  // Make forbidden-actions a directory instead of a file -> readFileSync throws EISDIR.
  mkdirSync(path.join(tmpDir, ".muster", "forbidden-actions"), { recursive: true });
  try {
    const { stdout, code } = await runRaw(bashPayload("npm publish", tmpDir));
    assert.equal(code, 0);
    const out = JSON.parse(stdout).hookSpecificOutput;
    assert.notEqual(out.permissionDecision, "deny", "unreadable forbidden-actions must fail-open");
  } finally {
    cleanDir(tmpDir);
  }
});

// ── regression: subagent + meta-exempt exemptions still hold ───────────────

test("regression: agent_id subagent call is allowed even with a matching forbidden action", async () => {
  const tmpDir = makeRunDir();
  writeForbidden(tmpDir, ["publish"]);
  try {
    const { stdout, code } = await runRaw(bashPayload("npm publish", tmpDir, { agent_id: "sub-abc" }));
    assert.equal(code, 0);
    const out = JSON.parse(stdout).hookSpecificOutput;
    assert.notEqual(out.permissionDecision, "deny", "subagent calls must remain exempt from the action fence");
  } finally {
    cleanDir(tmpDir);
  }
});

test("regression: Edit targeting .muster/ stays exempt even with a matching forbidden action", async () => {
  const tmpDir = makeRunDir();
  writeForbidden(tmpDir, ["send"]);
  try {
    const { stdout, code } = await runRaw(
      JSON.stringify({
        tool_name: "mcp__gmail__send_email", // classifies as send, but targets .muster/
        tool_input: { file_path: ".muster/log.txt" },
        cwd: tmpDir,
      }),
    );
    assert.equal(code, 0);
    const out = JSON.parse(stdout).hookSpecificOutput;
    assert.notEqual(out.permissionDecision, "deny", ".muster/ target must remain meta-exempt");
  } finally {
    cleanDir(tmpDir);
  }
});

// ── F2/F5: orchestrator SKILL.md fence-file lifecycle prose ─────────────────
// Doc-content pin: the fence-file lifecycle description in the "Scope fences"
// section must (F2) have the orchestrator remove .muster/forbidden-actions
// immediately BEFORE executing the run's declared merge disposition (fences
// guard the work phase; the declared disposition is the human-authorized
// exit — otherwise a fenced "publish" self-deadlocks muster's own merge-push),
// and (F5) clarify that the file carries only the TOP-LEVEL forbiddenActions
// set, with per-task additions staying brief-level discipline (the hook reads
// only the file, never a task's own forbiddenActions).
const SKILL_MD = readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "plugin", "skills", "orchestrator", "SKILL.md"),
  "utf8",
);

test("orchestrator SKILL.md: forbidden-actions removed before executing the merge disposition", () => {
  assert.match(
    SKILL_MD,
    /remove\s+`\.muster\/forbidden-actions`\s+immediately before executing[^.]*merge disposition/i,
    "fence lifecycle must state removal happens before the merge disposition executes",
  );
  assert.match(
    SKILL_MD,
    /human-authorized exit/i,
    "fence lifecycle must explain why: the declared disposition is the human-authorized exit",
  );
});

test("orchestrator SKILL.md: forbidden-actions file carries only the top-level set", () => {
  assert.match(
    SKILL_MD,
    /top-level\s+set/i,
    "must clarify the file carries the TOP-LEVEL forbiddenActions set",
  );
  assert.match(
    SKILL_MD,
    /brief-level discipline/i,
    "must clarify per-task additions are brief-level discipline, not hook-enforced",
  );
});
