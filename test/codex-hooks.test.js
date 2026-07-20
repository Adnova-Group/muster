// Split from the former test/codex.test.js monolith: the Codex lifecycle
// hook runtime (muster-hook.mjs) -- distribution, idempotent per-event
// emission, ownership/drift detection, and the no-lock-artifacts guarantee.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { cp, mkdir, mkdtemp, readdir, readFile, rm, unlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCodexInstall, runCodexUninstall } from "../src/codex-install.js";
import { repoRoot, runCodexHook, selectedPluginRoot } from "../test-support/codex-helpers.js";
// Shared per-run session-id isolator (test/test-support/hook-helpers.js, a
// different test-support dir than codex-helpers above): the Codex border marker
// `muster-codex-border-<sid>` is HOST-GLOBAL, keyed by session id alone, so the
// border-count tests below derive their sid from uniqueSid("<base>") instead of
// a fixed literal to stay isolated across concurrent full-suite runners.
import { uniqueSid } from "./test-support/hook-helpers.js";

// Border-invitation state lives in os.tmpdir(), keyed by a sanitized
// session_id (mirrors plugin/hooks/inline-budget.js's cumFile naming, kept
// separate from that file's `muster-cum-*` prefix so a shared-session-id
// coincidence between a Claude session and a Codex session can never
// collide). Tests compute the same path to assert on/clean up state directly.
const borderStateFile = sessionId => join(tmpdir(), `muster-codex-border-${sessionId.replace(/[^a-zA-Z0-9_-]/g, "")}`);

test("Codex distribution installs supported lifecycle hooks without advertising inert plugin hooks", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "muster-codex-hook-"));
  const hookEnv = { CODEX_HOME: join(tmp, "codex-home") };
  const plugin = selectedPluginRoot;
  const manifest = JSON.parse(await readFile(join(plugin, ".codex-plugin", "plugin.json"), "utf8"));
  assert.equal(manifest.hooks, undefined);
  await assert.rejects(() => readFile(join(plugin, "hooks", "hooks.json"), "utf8"));
  const config = JSON.parse(await readFile(join(repoRoot, "codex", "hooks", "hooks.json"), "utf8"));
  assert.deepEqual(Object.keys(config.hooks).sort(), ["PostToolUse", "PreToolUse", "SessionStart", "Stop", "SubagentStart", "SubagentStop", "UserPromptSubmit"].sort());
  const session = await runCodexHook({ hook_event_name: "SessionStart", session_id: "distribution", source: "startup", cwd: repoRoot }, repoRoot, join(repoRoot, "codex", "hooks", "muster-hook.mjs"), hookEnv);
  assert.match(session.hookSpecificOutput.additionalContext, /Write-capable waves must run in isolated git worktrees/);
  const subagent = await runCodexHook({ hook_event_name: "SubagentStart", session_id: "distribution", agent_id: "investigator", agent_type: "muster-investigator", cwd: repoRoot }, repoRoot, join(repoRoot, "codex", "hooks", "muster-hook.mjs"), hookEnv);
  assert.match(subagent.hookSpecificOutput.additionalContext, /Remain read-only/);
  await mkdir(join(tmp, ".muster"), { recursive: true });
  await writeFile(join(tmp, ".muster", "run-active"), "test\n");
  await writeFile(join(tmp, ".muster", "forbidden-actions"), "publish\n");
  const action = await runCodexHook({ hook_event_name: "PreToolUse", session_id: "distribution", tool_use_id: "push", tool_name: "Bash", tool_input: { command: "git push origin feature" }, cwd: tmp }, tmp, join(repoRoot, "codex", "hooks", "muster-hook.mjs"), hookEnv);
  assert.match(action.systemMessage, /action class "publish" is forbidden/);
  assert.match(action.systemMessage, /advisory/);
  const source = await readFile(join(repoRoot, "codex", "hooks", "muster-hook.mjs"), "utf8");
  assert.doesNotMatch(source, /permissionDecision|permissionDecisionReason/);
});

test("Codex hook emits idempotent context for every event without cross-copy dedupe or CODEX_HOME bookkeeping", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "muster-codex-hook-idempotent-"));
  const codexHome = join(tmp, "codex-home"), copies = [join(tmp, "project-copy"), join(tmp, "user-copy")];
  for (const copy of copies) await cp(join(repoRoot, "codex", "hooks"), copy, { recursive: true });
  const payload = { hook_event_name: "SessionStart", session_id: "session-idempotent", source: "startup", cwd: tmp };
  const outputs = await Promise.all(copies.map(copy => runCodexHook(payload, tmp, join(copy, "muster-hook.mjs"), { CODEX_HOME: codexHome })));
  assert.equal(outputs.filter(output => output.hookSpecificOutput).length, 2, "both installed copies must independently emit; there is no cross-copy dedupe");
  assert.deepEqual(outputs[0], outputs[1], "repeated emission of the same event must be byte-identical (idempotent)");

  const repeatedTurn = { hook_event_name: "UserPromptSubmit", session_id: "session-idempotent", turn_id: "turn-1", prompt: "muster audit", cwd: tmp };
  const firstTurn = await runCodexHook(repeatedTurn, tmp, join(copies[0], "muster-hook.mjs"), { CODEX_HOME: codexHome });
  const sameTurnAgain = await runCodexHook(repeatedTurn, tmp, join(copies[1], "muster-hook.mjs"), { CODEX_HOME: codexHome });
  assert.ok(firstTurn.hookSpecificOutput);
  assert.deepEqual(sameTurnAgain, firstTurn, "a repeated turn_id must still emit; there is no per-event dedupe state to consult");
  await assert.rejects(readdir(codexHome), "the simplified hook must never create a CODEX_HOME bookkeeping directory");
});

test("Codex hook ownership rejects traversal and modified managed groups", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "muster-codex-hook-ownership-"));
  const absent = async () => { throw new Error("not found"); };
  const traversalCwd = join(tmp, "traversal"), hookRoot = join(traversalCwd, ".codex", "muster");
  const victim = join(traversalCwd, "victim.mjs");
  await mkdir(hookRoot, { recursive: true });
  await writeFile(victim, "keep\n");
  await writeFile(join(hookRoot, ".muster-managed.json"), JSON.stringify({ format: 1, owner: "muster", files: ["../../victim.mjs"], hookGroups: {} }));
  await assert.rejects(() => runCodexUninstall({ cwd: traversalCwd, home: join(tmp, "home"), execFile: absent }), /Invalid Muster-owned Codex hook runtime/);
  assert.equal(await readFile(victim, "utf8"), "keep\n");

  const cwd = join(tmp, "modified"), home = join(tmp, "home2");
  await runCodexInstall({ cwd, home, repoRoot, execFile: absent });
  const hooksPath = join(cwd, ".codex", "hooks.json"), hooks = JSON.parse(await readFile(hooksPath, "utf8"));
  const managed = hooks.hooks.SessionStart.find(group => group.hooks?.some(hook => hook.command.includes("/muster/hooks/muster-hook.mjs")));
  managed.hooks[0].timeout = 11;
  await writeFile(hooksPath, JSON.stringify(hooks, null, 2));
  await assert.rejects(() => runCodexUninstall({ cwd, home, execFile: absent }), /Muster-owned hook was modified/);
  assert.match(await readFile(join(cwd, ".codex", "muster", "hooks", "muster-hook.mjs"), "utf8"), /Muster is installed for Codex/);
});

test("Codex hook exports no lock/quarantine/retirement machinery and creates no CODEX_HOME artifacts", async t => {
  const tmp = await mkdtemp(join(tmpdir(), "muster-codex-hook-no-lock-artifacts-"));
  t.after(() => rm(tmp, { recursive: true, force: true }));
  const codexHome = join(tmp, "codex-home");
  await Promise.all(Array.from({ length: 8 }, (_, index) =>
    runCodexHook(
      { hook_event_name: "SessionStart", session_id: `no-artifacts-${index}`, source: "startup", cwd: tmp },
      tmp, join(repoRoot, "codex", "hooks", "muster-hook.mjs"), { CODEX_HOME: codexHome }
    )
  ));
  await assert.rejects(readdir(codexHome), "the simplified hook must never create a CODEX_HOME directory");
  const hookUrl = new URL("../codex/hooks/muster-hook.mjs", import.meta.url).href;
  const script = `const hook = await import(${JSON.stringify(hookUrl)}); process.stdout.write(JSON.stringify(Object.keys(hook)));`;
  const stdout = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "--eval", script, tmp], { stdio: ["pipe", "pipe", "pipe"] });
    let output = "", error = "";
    child.stdout.setEncoding("utf8"); child.stdout.on("data", chunk => { output += chunk; });
    child.stderr.setEncoding("utf8"); child.stderr.on("data", chunk => { error += chunk; });
    child.on("error", reject);
    child.on("exit", code => code === 0 ? resolve(output) : reject(new Error(error || `hook export probe exited ${code}`)));
    child.stdin.end();
  });
  assert.deepEqual(JSON.parse(stdout), [], "the simplified hook must export no lock/quarantine/retirement machinery");
});

test("codex/hooks/muster-hook.mjs and its tracked .codex install copy stay byte-identical", async () => {
  const source = await readFile(join(repoRoot, "codex", "hooks", "muster-hook.mjs"), "utf8");
  const installed = await readFile(join(repoRoot, ".codex", "muster", "hooks", "muster-hook.mjs"), "utf8");
  assert.equal(installed, source, "the checked-in .codex/ install copy must mirror the source hook exactly");
});

test("Codex hook and its installed copy carry no wave-guard/scale-gate/todo-gate enforcement residue", async () => {
  for (const relPath of [join("codex", "hooks", "muster-hook.mjs"), join(".codex", "muster", "hooks", "muster-hook.mjs")]) {
    const source = await readFile(join(repoRoot, relPath), "utf8");
    assert.doesNotMatch(source, /MUSTER_WAVE_GUARD|MUSTER_SCALE_GATE|MUSTER_TODO_GATE/, `${relPath} must carry no deleted-env references`);
    assert.doesNotMatch(source, /wave-guard/i, `${relPath} must carry no wave-guard residue`);
    assert.doesNotMatch(source, /gitDirLooksLikeWorktree/, `${relPath}'s worktree heuristic was only ever a wave-guard consumer and must be gone with it`);
    assert.doesNotMatch(source, /write-capable wave is active outside/i, `${relPath} must drop the blunt wave-active write matcher`);
  }
});

test("Codex PreToolUse no longer keys any advisory off .muster/wave-active (bookkeeping only, never read for enforcement)", async t => {
  const tmp = await mkdtemp(join(tmpdir(), "muster-codex-hook-no-wave-guard-"));
  t.after(() => rm(tmp, { recursive: true, force: true }));
  await mkdir(join(tmp, ".muster"), { recursive: true });
  await writeFile(join(tmp, ".muster", "wave-active"), "wave-1\n");
  const sessionId = uniqueSid("no-wave-guard-session");
  t.after(() => unlink(borderStateFile(sessionId)).catch(() => {}));
  const result = await runCodexHook(
    { hook_event_name: "PreToolUse", session_id: sessionId, tool_use_id: "edit-1", tool_name: "Edit", tool_input: { file_path: join(tmp, "a.txt") }, cwd: tmp },
    tmp, join(repoRoot, "codex", "hooks", "muster-hook.mjs"), { CODEX_HOME: join(tmp, "codex-home") }
  );
  assert.equal(result.systemMessage, undefined, "an active wave-active marker must not, by itself, trigger any advisory -- it is bookkeeping the hook no longer reads for enforcement");
});

test("Codex PreToolUse's border invitation warns exactly once per crossing (3 distinct inline edits, no run active), then re-arms only on a muster run or reset", async t => {
  const tmp = await mkdtemp(join(tmpdir(), "muster-codex-hook-border-"));
  t.after(() => rm(tmp, { recursive: true, force: true }));
  const hookEnv = { CODEX_HOME: join(tmp, "codex-home") };
  const sessionId = uniqueSid("border-crossing-session");
  t.after(() => unlink(borderStateFile(sessionId)).catch(() => {}));
  const hookPath = join(repoRoot, "codex", "hooks", "muster-hook.mjs");
  const editCall = n => runCodexHook(
    { hook_event_name: "PreToolUse", session_id: sessionId, tool_use_id: `edit-${n}`, tool_name: "Edit", tool_input: { file_path: join(tmp, `file-${n}.txt`) }, cwd: tmp },
    tmp, hookPath, hookEnv
  );

  const first = await editCall(1);
  assert.equal(first.systemMessage, undefined, "1 distinct file is below the border");
  const second = await editCall(2);
  assert.equal(second.systemMessage, undefined, "2 distinct files is below the border");
  const third = await editCall(3);
  assert.match(third.systemMessage, /border invitation/i);
  assert.match(third.systemMessage, /parallel dispatch/i, "shares the same value-toned copy as main's CREW_INVITATION");
  const fourth = await editCall(4);
  assert.equal(fourth.systemMessage, undefined, "already nudged this crossing -- stays silent until a run starts or it re-arms");

  await mkdir(join(tmp, ".muster"), { recursive: true });
  await writeFile(join(tmp, ".muster", "run-active"), "test\n");
  const duringRun = await runCodexHook(
    { hook_event_name: "PreToolUse", session_id: sessionId, tool_use_id: "edit-during-run", tool_name: "Edit", tool_input: { file_path: join(tmp, "file-during-run.txt") }, cwd: tmp },
    tmp, hookPath, hookEnv
  );
  assert.equal(duringRun.systemMessage, undefined, "a live muster run resolves drift -- the counter resets instead of warning");

  await rm(join(tmp, ".muster", "run-active"));
  const postRunFirst = await editCall(5);
  assert.equal(postRunFirst.systemMessage, undefined, "counter was reset by the run -- back below the border");
});

test("Codex PreToolUse never counts Bash calls toward the border invitation (no precise write classifier on this port; avoids the blunt-matcher false positive)", async t => {
  const tmp = await mkdtemp(join(tmpdir(), "muster-codex-hook-border-bash-"));
  t.after(() => rm(tmp, { recursive: true, force: true }));
  const sessionId = uniqueSid("border-bash-session");
  t.after(() => unlink(borderStateFile(sessionId)).catch(() => {}));
  const hookPath = join(repoRoot, "codex", "hooks", "muster-hook.mjs");
  const hookEnv = { CODEX_HOME: join(tmp, "codex-home") };
  for (let n = 1; n <= 5; n += 1) {
    const result = await runCodexHook(
      { hook_event_name: "PreToolUse", session_id: sessionId, tool_use_id: `bash-${n}`, tool_name: "Bash", tool_input: { command: `echo ${n} > file-${n}.txt` }, cwd: tmp },
      tmp, hookPath, hookEnv
    );
    assert.equal(result.systemMessage, undefined, `Bash call ${n} must never trigger the border invitation`);
  }
});

test("Codex PreToolUse's border invitation counts every EDIT_TOOLS member (apply_patch, Write, NotebookEdit), keyed by whichever of file_path/path/notebook_path is present", async t => {
  const tmp = await mkdtemp(join(tmpdir(), "muster-codex-hook-border-tools-"));
  t.after(() => rm(tmp, { recursive: true, force: true }));
  const sessionId = uniqueSid("border-tools-session");
  t.after(() => unlink(borderStateFile(sessionId)).catch(() => {}));
  const hookPath = join(repoRoot, "codex", "hooks", "muster-hook.mjs");
  const hookEnv = { CODEX_HOME: join(tmp, "codex-home") };
  const calls = [
    { hook_event_name: "PreToolUse", session_id: sessionId, tool_use_id: "apply-patch-1", tool_name: "apply_patch", tool_input: { path: join(tmp, "patched.txt") }, cwd: tmp },
    { hook_event_name: "PreToolUse", session_id: sessionId, tool_use_id: "write-1", tool_name: "Write", tool_input: { file_path: join(tmp, "written.txt") }, cwd: tmp },
    { hook_event_name: "PreToolUse", session_id: sessionId, tool_use_id: "notebook-1", tool_name: "NotebookEdit", tool_input: { notebook_path: join(tmp, "nb.ipynb") }, cwd: tmp }
  ];
  const first = await runCodexHook(calls[0], tmp, hookPath, hookEnv);
  assert.equal(first.systemMessage, undefined, "1 distinct touch (apply_patch, keyed by .path) is below the border");
  const second = await runCodexHook(calls[1], tmp, hookPath, hookEnv);
  assert.equal(second.systemMessage, undefined, "2 distinct touches (Write, keyed by .file_path) is below the border");
  const third = await runCodexHook(calls[2], tmp, hookPath, hookEnv);
  assert.match(third.systemMessage, /border invitation/i, "3rd distinct touch (NotebookEdit, keyed by .notebook_path) crosses the border");
});

test("Codex PreToolUse's border invitation falls back to tool_name as the distinct key when tool_input carries no path field", async t => {
  const tmp = await mkdtemp(join(tmpdir(), "muster-codex-hook-border-nopath-"));
  t.after(() => rm(tmp, { recursive: true, force: true }));
  const sessionId = uniqueSid("border-nopath-session");
  t.after(() => unlink(borderStateFile(sessionId)).catch(() => {}));
  const hookPath = join(repoRoot, "codex", "hooks", "muster-hook.mjs");
  const hookEnv = { CODEX_HOME: join(tmp, "codex-home") };
  const noPathCall = n => runCodexHook(
    { hook_event_name: "PreToolUse", session_id: sessionId, tool_use_id: `edit-nopath-${n}`, tool_name: "Edit", tool_input: {}, cwd: tmp },
    tmp, hookPath, hookEnv
  );
  const first = await noPathCall(1);
  assert.equal(first.systemMessage, undefined);
  const second = await noPathCall(2);
  assert.equal(second.systemMessage, undefined, "repeated no-path Edit calls collapse onto the same tool_name-fallback key -- still only 1 distinct touch");
  const third = await noPathCall(3);
  assert.equal(third.systemMessage, undefined, "3rd call is still the SAME distinct key (tool_name fallback), so it must not cross the border");
});

test("Codex PreToolUse's border-invitation threshold rejects a non-integer MUSTER_INLINE_SCALE rather than parseInt-truncating it", async t => {
  const tmp = await mkdtemp(join(tmpdir(), "muster-codex-hook-border-badenv-"));
  t.after(() => rm(tmp, { recursive: true, force: true }));
  const sessionId = uniqueSid("border-badenv-session");
  t.after(() => unlink(borderStateFile(sessionId)).catch(() => {}));
  const hookPath = join(repoRoot, "codex", "hooks", "muster-hook.mjs");
  // "2foo" must NOT be accepted as 2 (Number.parseInt would truncate-parse this
  // to 2) -- a malformed override must fall back to the documented default (3).
  const hookEnv = { CODEX_HOME: join(tmp, "codex-home"), MUSTER_INLINE_SCALE: "2foo" };
  const editCall = n => runCodexHook(
    { hook_event_name: "PreToolUse", session_id: sessionId, tool_use_id: `edit-${n}`, tool_name: "Edit", tool_input: { file_path: join(tmp, `file-${n}.txt`) }, cwd: tmp },
    tmp, hookPath, hookEnv
  );
  const first = await editCall(1);
  assert.equal(first.systemMessage, undefined, "1 distinct file is below either threshold");
  const second = await editCall(2);
  assert.equal(second.systemMessage, undefined, "a malformed override must fall back to the default threshold (3), not truncate-parse to 2 -- 2 distinct files must NOT cross");
  const third = await editCall(3);
  assert.match(third.systemMessage, /border invitation/i, "the default threshold (3) still applies once the override is rejected as malformed");
});

test("Codex SessionStart re-arms a previously-nudged border invitation on a fresh session start", async t => {
  const tmp = await mkdtemp(join(tmpdir(), "muster-codex-hook-border-sessionstart-"));
  t.after(() => rm(tmp, { recursive: true, force: true }));
  const sessionId = uniqueSid("border-sessionstart-session");
  t.after(() => unlink(borderStateFile(sessionId)).catch(() => {}));
  const hookPath = join(repoRoot, "codex", "hooks", "muster-hook.mjs");
  const hookEnv = { CODEX_HOME: join(tmp, "codex-home") };
  const editCall = n => runCodexHook(
    { hook_event_name: "PreToolUse", session_id: sessionId, tool_use_id: `edit-${n}`, tool_name: "Edit", tool_input: { file_path: join(tmp, `file-${n}.txt`) }, cwd: tmp },
    tmp, hookPath, hookEnv
  );
  await editCall(1);
  await editCall(2);
  const third = await editCall(3);
  assert.match(third.systemMessage, /border invitation/i, "crossing fires once");
  const fourth = await editCall(4);
  assert.equal(fourth.systemMessage, undefined, "still nudged -- silent before any reset");

  await runCodexHook({ hook_event_name: "SessionStart", session_id: sessionId, source: "startup", cwd: tmp }, tmp, hookPath, hookEnv);

  const postSessionStart = await editCall(5);
  assert.equal(postSessionStart.systemMessage, undefined, "1 distinct file post-reset is below the border");
  await editCall(6);
  const reCrossed = await editCall(7);
  assert.match(reCrossed.systemMessage, /border invitation/i, "a fresh SessionStart re-arms the crossing -- it can nudge again");
});

test("Codex PreToolUse's border invitation re-arms once its state file goes stale past the 60-minute crossing age", async t => {
  const tmp = await mkdtemp(join(tmpdir(), "muster-codex-hook-border-stale-"));
  t.after(() => rm(tmp, { recursive: true, force: true }));
  const sessionId = uniqueSid("border-stale-session");
  const stateFile = borderStateFile(sessionId);
  t.after(() => unlink(stateFile).catch(() => {}));
  const hookPath = join(repoRoot, "codex", "hooks", "muster-hook.mjs");
  const hookEnv = { CODEX_HOME: join(tmp, "codex-home") };
  const editCall = n => runCodexHook(
    { hook_event_name: "PreToolUse", session_id: sessionId, tool_use_id: `edit-${n}`, tool_name: "Edit", tool_input: { file_path: join(tmp, `file-${n}.txt`) }, cwd: tmp },
    tmp, hookPath, hookEnv
  );
  await editCall(1);
  await editCall(2);
  const third = await editCall(3);
  assert.match(third.systemMessage, /border invitation/i, "crossing fires once");

  // Back-date the state file's mtime past BORDER_MAX_AGE_MS (60 minutes) --
  // the next record must treat the crossing as stale and start fresh instead
  // of staying silent.
  const past = new Date(Date.now() - 61 * 60 * 1000);
  await utimes(stateFile, past, past);

  const first = await editCall(4);
  assert.equal(first.systemMessage, undefined, "1 distinct file post-staleness-reset is below the border");
  await editCall(5);
  const reCrossed = await editCall(6);
  assert.match(reCrossed.systemMessage, /border invitation/i, "staleness re-arms the crossing -- it can nudge again");
});
