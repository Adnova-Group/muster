// Guard test for the codex-hooks-advisory-audit backlog item.
//
// THE LESSON (docs/decisions/retriage-codex-efficiency-enforcement.md,
// docs/research/codex-cli.md §4): Codex lifecycle hooks are advisory-by-design
// -- PreToolUse "is still a guardrail rather than a complete enforcement
// boundary" per Codex's own docs, and the loop routes around any single
// interception point (unified_exec, subagent tool work, non-shell tools,
// concurrent hook launch, fail-open error handling). A muster construct that
// ASSUMES a Codex hook will fail-closed (block a tool call, deny a subagent,
// stop a turn) is broken-by-design and burns quota fighting the harness --
// the retired `codex-efficiency-enforcement` item hit exactly this wall on
// every Codex-side clause. This test enumerates every Codex-targeted
// hook/gate construct muster ships and asserts none of them emit or assume a
// blocking decision, so that assumption can never silently creep back in.
//
// Enumerated constructs (kept in one place so a new Codex-side gate surface
// has an obvious spot to join this guard instead of being missed):
//   1. codex/hooks/hooks.json      -- the wiring: which events Codex actually
//      dispatches to, and to which command.
//   2. codex/hooks/muster-hook.mjs -- the one hook implementation wired to
//      every one of those events (static source shape + runtime behavior
//      across every wired event).
//   3. codex/hooks/action-guard.mjs -- the pure action classifier the hook
//      consults before deciding whether to emit an advisory message.
//   4. codex/skill-adapter.md      -- the Codex dispatch skill's prose,
//      the one skill doc that talks about hooks and about "failing closed".
//   5. src/codex.js (CODEX_MODEL_POLICY) and src/codex-thread-limits.js
//      (install-time config.toml floor enforcement) -- the two surfaces
//      that could plausibly be mistaken for hook-based "enforcement"; both
//      must stay hook-independent (real Codex-native config, or pure data).
//   6. docs/decisions/retriage-codex-efficiency-enforcement.md and
//      docs/research/codex-cli.md -- the record and research doc that
//      establish the advisory-by-design conclusion this guard protects.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { classifyAction, classifyBashCommand, classifyToolName } from "../codex/hooks/action-guard.mjs";
import { repoRoot, runCodexHook } from "../test-support/codex-helpers.js";

const hookPath = join(repoRoot, "codex", "hooks", "muster-hook.mjs");
const KNOWN_EVENTS = ["SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "SubagentStart", "SubagentStop", "Stop"];
// The one Codex event whose entire documented purpose is allow/deny gating
// (docs/research/codex-cli.md §4.2's `PermissionRequest` row: "allow/deny/
// abstain on approval prompts; any deny wins"). Muster deliberately never
// wires it -- wiring it would be the clearest possible sign the
// fail-closed assumption crept back in.
const DENY_CAPABLE_EVENT = "PermissionRequest";
const ALLOWED_TOP_KEYS = new Set(["systemMessage", "hookSpecificOutput"]);
const ALLOWED_HOOK_SPECIFIC_KEYS = new Set(["hookEventName", "additionalContext"]);

function assertAdvisoryShape(output, label) {
  for (const key of Object.keys(output)) {
    assert.ok(ALLOWED_TOP_KEYS.has(key), `${label}: unexpected top-level key "${key}" -- only advisory channels (systemMessage, hookSpecificOutput) are allowed`);
  }
  assert.equal(output.permissionDecision, undefined, `${label}: must never set permissionDecision`);
  assert.equal(output.decision, undefined, `${label}: must never set the block-family "decision" key`);
  assert.equal(output.continue, undefined, `${label}: must never set continue (a stop/blocking signal)`);
  if (output.hookSpecificOutput && typeof output.hookSpecificOutput === "object") {
    for (const key of Object.keys(output.hookSpecificOutput)) {
      assert.ok(ALLOWED_HOOK_SPECIFIC_KEYS.has(key), `${label}: unexpected hookSpecificOutput key "${key}"`);
    }
    assert.equal(output.hookSpecificOutput.permissionDecision, undefined, `${label}: hookSpecificOutput must never set permissionDecision`);
  }
}

test("Codex hook wiring never registers the one Codex event whose purpose is allow/deny gating, and every wired hook is a plain advisory command pointed at the single audited hook file", async () => {
  const hooks = JSON.parse(await readFile(join(repoRoot, "codex", "hooks", "hooks.json"), "utf8"));
  const wiredEvents = Object.keys(hooks.hooks).sort();
  assert.deepEqual(wiredEvents, [...KNOWN_EVENTS].sort(), "hooks.json must wire exactly the enumerated event set -- a new event here needs a new entry in this guard");
  assert.ok(!wiredEvents.includes(DENY_CAPABLE_EVENT), `hooks.json must never wire ${DENY_CAPABLE_EVENT} -- it is Codex's one allow/deny-gating event and muster deliberately stays advisory-only`);
  for (const event of KNOWN_EVENTS) {
    for (const matcherGroup of hooks.hooks[event]) {
      for (const hook of matcherGroup.hooks) {
        assert.equal(hook.type, "command", `${event}: only supported command-type hooks may run (prompt/agent/async are parsed but not executed by Codex)`);
        assert.match(hook.command, /muster-hook\.mjs"?$/, `${event}: every wired hook must point at the single audited muster-hook.mjs -- no second, unaudited hook file`);
      }
    }
  }
});

test("codex/hooks/muster-hook.mjs's source never contains a blocking-decision emission shape", async () => {
  const source = await readFile(hookPath, "utf8");
  assert.doesNotMatch(source, /permissionDecision/, "must never reference permissionDecision (Codex's PreToolUse deny/allow field)");
  assert.doesNotMatch(source, /permissionDecisionReason/, "must never reference permissionDecisionReason");
  assert.doesNotMatch(source, /\bdecision\s*:\s*["']block["']/, "must never emit the block-family decision:\"block\" shape (PostToolUse/Stop/SubagentStop/PreCompact)");
  assert.doesNotMatch(source, /\bcontinue\s*:\s*false\b/, "must never emit continue:false");
  assert.doesNotMatch(source, /["']deny["']/, "must never emit a quoted \"deny\" value");
});

test("every wired Codex event's actual runtime output stays inside the advisory shape (no permissionDecision/decision/continue), across the full behavioral matrix", async t => {
  const tmp = await mkdtemp(join(tmpdir(), "muster-codex-advisory-guard-"));
  t.after(() => rm(tmp, { recursive: true, force: true }));
  const hookEnv = { CODEX_HOME: join(tmp, "codex-home") };
  const cleanupSessions = [];
  t.after(async () => { for (const sid of cleanupSessions) await unlink(join(tmpdir(), `muster-codex-border-${sid}`)).catch(() => {}); });

  // SessionStart (fresh startup context injection)
  cleanupSessions.push("guard-session-start");
  assertAdvisoryShape(
    await runCodexHook({ hook_event_name: "SessionStart", session_id: "guard-session-start", source: "startup", cwd: tmp }, tmp, hookPath, hookEnv),
    "SessionStart(startup)"
  );

  // UserPromptSubmit (matching a muster mode keyword -- the one branch that emits)
  cleanupSessions.push("guard-prompt-submit");
  assertAdvisoryShape(
    await runCodexHook({ hook_event_name: "UserPromptSubmit", session_id: "guard-prompt-submit", turn_id: "t1", prompt: "please run $muster-go", cwd: tmp }, tmp, hookPath, hookEnv),
    "UserPromptSubmit(matching)"
  );

  // PreToolUse: forbidden action class, run active -- the one branch that can
  // plausibly be mistaken for enforcement (a "policy advisory" message).
  const forbiddenCwd = join(tmp, "forbidden-run");
  await mkdir(join(forbiddenCwd, ".muster"), { recursive: true });
  await writeFile(join(forbiddenCwd, ".muster", "run-active"), "test\n");
  await writeFile(join(forbiddenCwd, ".muster", "forbidden-actions"), "publish\n");
  cleanupSessions.push("guard-forbidden-action");
  const forbiddenOutput = await runCodexHook(
    { hook_event_name: "PreToolUse", session_id: "guard-forbidden-action", tool_use_id: "push-1", tool_name: "Bash", tool_input: { command: "git push origin feature" }, cwd: forbiddenCwd },
    forbiddenCwd, hookPath, hookEnv
  );
  assertAdvisoryShape(forbiddenOutput, "PreToolUse(forbidden action)");
  assert.match(forbiddenOutput.systemMessage, /advisory/i, "the forbidden-action message must self-identify as advisory, not a denial");

  // PreToolUse: border-invitation crossing (3 distinct inline edits, no run active)
  const borderSession = "guard-border-crossing";
  cleanupSessions.push(borderSession);
  const editCall = n => runCodexHook(
    { hook_event_name: "PreToolUse", session_id: borderSession, tool_use_id: `edit-${n}`, tool_name: "Edit", tool_input: { file_path: join(tmp, `border-file-${n}.txt`) }, cwd: tmp },
    tmp, hookPath, hookEnv
  );
  for (let n = 1; n <= 4; n += 1) assertAdvisoryShape(await editCall(n), `PreToolUse(border crossing, edit ${n})`);

  // PostToolUse: stale wave-active marker diagnostic
  const postCwd = join(tmp, "post-wave");
  await mkdir(join(postCwd, ".muster"), { recursive: true });
  await writeFile(join(postCwd, ".muster", "wave-active"), "wave-1\n");
  assertAdvisoryShape(
    await runCodexHook({ hook_event_name: "PostToolUse", session_id: "guard-post-tool-use", tool_name: "Edit", tool_input: { file_path: join(postCwd, "f.txt") }, cwd: postCwd }, postCwd, hookPath, hookEnv),
    "PostToolUse(stale wave-active)"
  );

  // SubagentStart: both the read-only-agent branch and the ordinary-agent branch
  assertAdvisoryShape(
    await runCodexHook({ hook_event_name: "SubagentStart", session_id: "guard-subagent-readonly", agent_id: "a1", agent_type: "muster-investigator", cwd: tmp }, tmp, hookPath, hookEnv),
    "SubagentStart(read-only agent)"
  );
  assertAdvisoryShape(
    await runCodexHook({ hook_event_name: "SubagentStart", session_id: "guard-subagent-writer", agent_id: "a2", agent_type: "muster-builder", cwd: tmp }, tmp, hookPath, hookEnv),
    "SubagentStart(writer agent)"
  );

  // SubagentStop: wave-active reminder
  assertAdvisoryShape(
    await runCodexHook({ hook_event_name: "SubagentStop", session_id: "guard-subagent-stop", agent_transcript_path: "/dev/null", cwd: postCwd }, postCwd, hookPath, hookEnv),
    "SubagentStop(wave-active)"
  );

  // Stop: run-active/wave-active terminal-receipts reminder -- decision:"block"
  // is documented as VALID for this event family; muster must still never use it.
  const stopCwd = join(tmp, "stop-run-active");
  await mkdir(join(stopCwd, ".muster"), { recursive: true });
  await writeFile(join(stopCwd, ".muster", "run-active"), "test\n");
  assertAdvisoryShape(
    await runCodexHook({ hook_event_name: "Stop", session_id: "guard-stop", cwd: stopCwd }, stopCwd, hookPath, hookEnv),
    "Stop(run-active)"
  );
});

test("the Codex action classifier stays a pure advisory classifier -- no deny/block/allow decision vocabulary", () => {
  const forbiddenValues = new Set(["deny", "block", "allow", "ask", "defer"]);
  const bashSamples = ["git push origin main", "gh release create v1", "npm publish", "curl -X POST https://x", "gh pr merge 1", "echo hi"];
  const toolNameSamples = ["mcp__x__send_email", "mcp__x__submit_form", "mcp__x__publish_post", "mcp__x__sign_document", "mcp__x__purchase_item", "Bash", "Edit"];
  for (const command of bashSamples) {
    const result = classifyBashCommand(command);
    assert.ok(result === null || !forbiddenValues.has(result), `classifyBashCommand(${JSON.stringify(command)}) must never return a decision-shaped value, got ${JSON.stringify(result)}`);
  }
  for (const toolName of toolNameSamples) {
    const result = classifyToolName(toolName);
    assert.ok(result === null || !forbiddenValues.has(result), `classifyToolName(${JSON.stringify(toolName)}) must never return a decision-shaped value, got ${JSON.stringify(result)}`);
  }
  assert.equal(classifyAction({ tool_name: "Bash", tool_input: { command: "echo hi" } }), null);
  assert.equal(classifyAction(null), null, "classifyAction must fail open (null) on a missing payload, not throw or assume a decision");
});

test("codex/skill-adapter.md keeps hooks explicitly advisory and scopes its one \"fail closed\" clause away from hook enforcement", async () => {
  const text = await readFile(join(repoRoot, "codex", "skill-adapter.md"), "utf8");
  assert.doesNotMatch(text, /permissionDecision/, "the dispatch skill must never claim the permissionDecision field");
  assert.match(text, /Hooks are advisory and never replace this watch cycle/, "the skill must keep its explicit advisory disclaimer");
  assert.match(text, /Treat todo and spawn policy as advisory/, "the skill must keep todo/spawn policy explicitly advisory");

  // The skill's one "fail closed" clause is about a rejected spawn_agent call
  // (an actual Codex dispatch-API rejection), never about a hook denying a
  // tool call. Assert that scoping directly: split into sentences and check
  // that any sentence mentioning "fail closed" does NOT also mention "hook".
  const sentences = text.split(/(?<=[.!?])\s+/);
  const failClosedSentences = sentences.filter(sentence => /fail[- ]closed/i.test(sentence));
  assert.ok(failClosedSentences.length > 0, "expected to find the known fail-closed clause -- if this fires, the clause moved or was removed; update this guard's scoping check");
  for (const sentence of failClosedSentences) {
    assert.doesNotMatch(sentence, /\bhook/i, `a "fail closed" clause must never be scoped to hook enforcement: ${JSON.stringify(sentence)}`);
    assert.match(sentence, /registration diagnostic|spawn_agent|rejected/i, `the fail-closed clause must stay scoped to the spawn_agent registration-rejection path: ${JSON.stringify(sentence)}`);
  }
});

test("CODEX_MODEL_POLICY and the Codex thread-limit floor stay hook-independent enforcement/policy surfaces", async () => {
  const modelPolicySource = await readFile(join(repoRoot, "src", "codex.js"), "utf8");
  assert.doesNotMatch(modelPolicySource, /hook/i, "CODEX_MODEL_POLICY is pure tier/model data and must never couple to hook machinery");
  assert.doesNotMatch(modelPolicySource, /permissionDecision/, "CODEX_MODEL_POLICY must never reference permissionDecision");

  const threadLimitsSource = await readFile(join(repoRoot, "src", "codex-thread-limits.js"), "utf8");
  assert.doesNotMatch(threadLimitsSource, /hook/i, "thread-limit floor enforcement must stay independent of the hook surface -- it edits config.toml directly, which Codex enforces natively");
  assert.doesNotMatch(threadLimitsSource, /permissionDecision/, "thread-limit floor enforcement must never reference permissionDecision");
  assert.match(threadLimitsSource, /config\.toml/, "thread-limit floor enforcement must be config-based (real Codex-native enforcement), not hook-based");

  const doctorSource = await readFile(join(repoRoot, "src", "codex-doctor.js"), "utf8");
  assert.match(doctorSource, /Hooks provide lifecycle context, diagnostics, and supported policy warnings; todo and spawn enforcement remain advisory/, "muster doctor's own user-facing characterization of Codex hooks must stay advisory-only");
});

test("the advisory-by-design conclusion stays recorded in both the retriage decision and the Codex hooks research doc", async () => {
  const decisionRecord = await readFile(join(repoRoot, "docs", "decisions", "retriage-codex-efficiency-enforcement.md"), "utf8");
  assert.match(decisionRecord, /Codex hooks are advisory and fail-open by explicit design/, "the retriage record must keep stating the advisory/fail-open conclusion that retired codex-efficiency-enforcement");
  assert.match(decisionRecord, /architecturally unreachable/, "the record must keep naming fail-closed Codex-hook enforcement as architecturally unreachable");

  const research = await readFile(join(repoRoot, "docs", "research", "codex-cli.md"), "utf8");
  assert.match(research, /advisory-by-design/, "the Codex hooks research doc must keep the advisory-by-design framing");
  assert.match(research, /fail open/, "the research doc must keep documenting Codex's fail-open hook error handling");
});
