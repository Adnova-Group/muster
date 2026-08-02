// codex exec + codex review: the process-level dispatch lane and the native
// diff-review gate. Evidence: docs/research/codex-cli.md sec 10.4.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  resolveCodexDispatchLane, codexExecCall, interpretCodexExecExit, codexReviewCall,
  resolveCodexReviewRouting, CODEX_EXEC_MODES
} from "../src/wave-dispatch.js";

// --- lane selection ---------------------------------------------------------

test("resolveCodexDispatchLane: overlapping write sets force process isolation", () => {
  // spawn_agent shares ONE cwd across every agent — "edits made by one agent are
  // immediately visible to all other agents" — so conflicting writers can only
  // be isolated by separate processes.
  const r = resolveCodexDispatchLane({ members: [
    { id: "a", writes: ["src/x.js"] },
    { id: "b", writes: ["src/x.js"] }
  ]});
  assert.equal(r.mode, CODEX_EXEC_MODES.EXEC_PROCESS);
  assert.equal(r.isolation, "process-cwd");
  assert.match(r.reason, /overlapping write sets/);
});

test("resolveCodexDispatchLane: disjoint writers stay on the cheaper in-session lane", () => {
  const r = resolveCodexDispatchLane({ members: [
    { id: "a", writes: ["src/x.js"] },
    { id: "b", writes: ["src/y.js"] }
  ]});
  assert.equal(r.mode, CODEX_EXEC_MODES.SPAWN_AGENT);
  assert.equal(r.isolation, "context-only");
});

test("resolveCodexDispatchLane: read-only members never force a cold process", () => {
  const r = resolveCodexDispatchLane({ members: [{ id: "a" }, { id: "b" }] });
  assert.equal(r.mode, CODEX_EXEC_MODES.SPAWN_AGENT);
});

test("resolveCodexDispatchLane: the caller can force isolation explicitly", () => {
  const r = resolveCodexDispatchLane({ members: [{ id: "a" }], forceProcess: true });
  assert.equal(r.mode, CODEX_EXEC_MODES.EXEC_PROCESS);
  assert.match(r.reason, /forced/);
});

// --- codex exec argv --------------------------------------------------------

test("codexExecCall: always emits --json, and -C is what actually isolates", () => {
  const call = codexExecCall({ prompt: "do the thing", cwd: "/w/item-1" });
  assert.equal(call.command, "codex");
  assert.deepEqual(call.argv, [
    "--ask-for-approval", "never", "exec", "--json", "--ignore-user-config",
    "--strict-config", "--ephemeral", "--sandbox", "workspace-write",
    "-C", "/w/item-1", "do the thing",
  ]);
  assert.equal(call.isolation, "process-cwd");
});

test("codexExecCall: threads policy, model, schema, last-message and git-check flags", () => {
  const call = codexExecCall({
    prompt: "p", cwd: "/w", model: "gpt-5.6-sol", schemaPath: "/s.json",
    lastMessagePath: "/out.txt", sandbox: "read-only", approvalPolicy: "untrusted", skipGitCheck: true
  });
  assert.deepEqual(call.argv, [
    "--ask-for-approval", "untrusted", "exec", "--json", "--ignore-user-config",
    "--strict-config", "--ephemeral", "--sandbox", "read-only", "-C", "/w",
    "-m", "gpt-5.6-sol", "--output-schema", "/s.json", "-o", "/out.txt",
    "--skip-git-repo-check", "p"
  ]);
  assert.throws(() => codexExecCall({ prompt: "p", sandbox: "host" }), /unsupported sandbox/);
  assert.throws(() => codexExecCall({ prompt: "p", approvalPolicy: "always" }), /unsupported approval policy/);
});

test("codexExecCall: the prompt is always last, so it is never parsed as a flag value", () => {
  assert.equal(codexExecCall({ prompt: "final", cwd: "/w", model: "m" }).argv.at(-1), "final");
  assert.throws(() => codexExecCall({ cwd: "/w" }), /prompt is required/);
  assert.throws(() => codexExecCall({ prompt: "   " }), /prompt is required/);
});

test("interpretCodexExecExit: 0 and 1 are verdicts, anything else is a harness fault", () => {
  assert.deepEqual(interpretCodexExecExit(0), { ok: true, fatal: false });
  assert.equal(interpretCodexExecExit(1).fatal, true);
  const odd = interpretCodexExecExit(137); // e.g. SIGKILL
  assert.equal(odd.ok, false);
  assert.match(odd.reason, /not a documented exec status/);
});

// --- codex review -----------------------------------------------------------

test("codexReviewCall: each selector builds its own argv", () => {
  assert.deepEqual(codexReviewCall({ base: "main" }).argv, ["review", "--base", "main"]);
  assert.deepEqual(codexReviewCall({ uncommitted: true }).argv, ["review", "--uncommitted"]);
  assert.deepEqual(codexReviewCall({ commit: "abc123" }).argv, ["review", "--commit", "abc123"]);
});

test("codexReviewCall: exactly one selector — zero or two is a caller bug, not a default", () => {
  assert.throws(() => codexReviewCall({}), /exactly one of base \| uncommitted \| commit/);
  assert.throws(() => codexReviewCall({ base: "main", uncommitted: true }), /exactly one of/);
});

test("codexReviewCall: optional title and prompt, prompt last", () => {
  const call = codexReviewCall({ base: "main", title: "wave 1", prompt: "focus on the gate" });
  assert.deepEqual(call.argv, ["review", "--base", "main", "--title", "wave 1", "focus on the gate"]);
});

test("native Codex review remains shadow-only after the failed benchmark", () => {
  assert.deepEqual(resolveCodexReviewRouting(), {
    mode: "muster-review-gate",
    nativeReviewEnabled: false,
    reason: "native review shadow benchmark rejected adoption (0/10 schema-valid outputs)",
  });
  assert.equal(resolveCodexReviewRouting({ requestNativeReview: true }).nativeReviewEnabled, false);
});
