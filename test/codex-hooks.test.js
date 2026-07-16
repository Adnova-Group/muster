// Split from the former test/codex.test.js monolith: the Codex lifecycle
// hook runtime (muster-hook.mjs) -- distribution, idempotent per-event
// emission, ownership/drift detection, and the no-lock-artifacts guarantee.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { cp, mkdir, mkdtemp, readdir, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCodexInstall, runCodexUninstall } from "../src/codex-install.js";
import { repoRoot, runCodexHook, selectedPluginRoot } from "../test-support/codex-helpers.js";

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
  const sessionId = "no-wave-guard-session";
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
  const sessionId = "border-crossing-session";
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
  const sessionId = "border-bash-session";
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
