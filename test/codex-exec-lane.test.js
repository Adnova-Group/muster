// codex exec + codex review: the process-level dispatch lane and the native
// diff-review gate. Evidence: docs/research/codex-cli.md sec 10.4.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { linkSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
  assert.match(r.reason, /manifest write fences cannot be mechanically enforced/);
});

test("resolveCodexDispatchLane: even physically disjoint writers use hermetic processes", t => {
  const root = mkdtempSync(join(tmpdir(), "muster-write-fences-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, "src/x.js"), "x");
  writeFileSync(join(root, "src/y.js"), "y");
  const r = resolveCodexDispatchLane({ members: [
    { id: "a", writes: ["src/x.js"] },
    { id: "b", writes: ["src/y.js"] }
  ], repositoryRoot: root });
  assert.equal(r.mode, CODEX_EXEC_MODES.EXEC_PROCESS);
  assert.equal(r.isolation, "process-cwd");
});

test("resolveCodexDispatchLane: project-shadowable role names cannot authenticate omitted write fences", () => {
  for (const member of [
    { id: "missing" },
    { id: "claim", readOnly: true, agentType: "muster-builder" },
    { id: "shadow", readOnly: true, agentType: "muster-reviewer" },
  ]) {
    assert.equal(resolveCodexDispatchLane({ members: [member] }).mode, CODEX_EXEC_MODES.EXEC_PROCESS);
  }
});

test("resolveCodexDispatchLane: physical, hard-link, symlink, case, and missing aliases fail closed", t => {
  const root = mkdtempSync(join(tmpdir(), "muster-write-aliases-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, "target"), "x");
  linkSync(join(root, "target"), join(root, "hard"));
  symlinkSync(join(root, "target"), join(root, "sym"));
  execFileSync("mkfifo", [join(root, "pipe")]);
  writeFileSync(join(root, "Case"), "upper");
  writeFileSync(join(root, "case"), "lower");
  mkdirSync(join(root, "a"));
  mkdirSync(join(root, "b"));
  linkSync(join(root, "target"), join(root, "a/shared"));
  linkSync(join(root, "target"), join(root, "b/shared"));
  for (const writes of [
    ["target"], ["pipe"], ["target", "hard"], ["target", "sym"], ["Case", "case"], ["target", "missing"], ["a", "b"],
  ]) {
    assert.equal(resolveCodexDispatchLane({
      members: writes.map((write, index) => ({ id: String(index), writes: [write] })),
      repositoryRoot: root,
    }).mode, CODEX_EXEC_MODES.EXEC_PROCESS);
  }
});

test("resolveCodexDispatchLane: the caller can force isolation explicitly", () => {
  const r = resolveCodexDispatchLane({ members: [{ id: "a" }], forceProcess: true });
  assert.equal(r.mode, CODEX_EXEC_MODES.EXEC_PROCESS);
  assert.match(r.reason, /always use separate/);
});

test("resolveCodexDispatchLane: prompts cannot escape advisory write fences through shared cwd", () => {
  const result = resolveCodexDispatchLane({ members: [
    { id: "a", writes: ["package.json"], prompt: "overwrite SECURITY.md" },
    { id: "b", writes: ["LICENSE"], prompt: "overwrite SECURITY.md" },
  ] });
  assert.equal(result.mode, CODEX_EXEC_MODES.EXEC_PROCESS);
});

test("resolveCodexDispatchLane: semantic overlaps and malformed write fences fail closed to process isolation", () => {
  for (const members of [
    [{ writes: ["src/auth"] }, { writes: ["src/auth/session.js"] }],
    [{ writes: ["src/**"] }, { writes: ["src/session.js"] }],
    [{ writes: ["src/a/../x.js"] }, { writes: ["src/x.js"] }],
    [{ writes: true }, { writes: ["src/x.js"] }],
    [{ writes: [] }, { writes: ["src/x.js"] }],
  ]) {
    assert.equal(resolveCodexDispatchLane({ members }).mode, CODEX_EXEC_MODES.EXEC_PROCESS);
  }
});

// --- codex exec argv --------------------------------------------------------

test("codexExecCall: always emits --json, and -C is what actually isolates", () => {
  const call = codexExecCall({ prompt: "do the thing", cwd: "/w/item-1" });
  assert.equal(call.command, "codex");
  assert.deepEqual(call.argv, [
    "--ask-for-approval", "never", "exec", "--json", "--ignore-user-config", "--ignore-rules",
    "--strict-config", "--ephemeral", "-c", 'shell_environment_policy.inherit="none"',
    "--sandbox", "workspace-write",
    "-C", "/w/item-1", "--", "do the thing",
  ]);
  assert.equal(call.isolation, "process-cwd");
});

test("codexExecCall: threads policy, model, schema, last-message and git-check flags", () => {
  const call = codexExecCall({
    prompt: "p", cwd: "/w", model: "gpt-5.6-sol", schemaPath: "/s.json",
    lastMessagePath: "/out.txt", sandbox: "read-only", approvalPolicy: "untrusted", skipGitCheck: true
  });
  assert.deepEqual(call.argv, [
    "--ask-for-approval", "untrusted", "exec", "--json", "--ignore-user-config", "--ignore-rules",
    "--strict-config", "--ephemeral", "-c", 'shell_environment_policy.inherit="none"',
    "--sandbox", "read-only", "-C", "/w",
    "-m", "gpt-5.6-sol", "--output-schema", "/s.json", "-o", "/out.txt",
    "--skip-git-repo-check", "--", "p"
  ]);
  assert.throws(() => codexExecCall({ prompt: "p", sandbox: "host" }), /unsupported sandbox/);
  assert.throws(() => codexExecCall({ prompt: "p", approvalPolicy: "always" }), /unsupported approval policy/);
});

test("codexExecCall: the prompt is always last, so it is never parsed as a flag value", () => {
  for (const prompt of ["final", "--help", "review", "-danger"]) {
    assert.deepEqual(codexExecCall({ prompt, cwd: "/w", model: "m" }).argv.slice(-2), ["--", prompt]);
  }
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
