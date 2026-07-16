// Split from the former test/codex.test.js monolith: the Codex lifecycle
// hook runtime (muster-hook.mjs) -- distribution, idempotent per-event
// emission, ownership/drift detection, and the no-lock-artifacts guarantee.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { cp, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCodexInstall, runCodexUninstall } from "../src/codex-install.js";
import { repoRoot, runCodexHook, selectedPluginRoot } from "../test-support/codex-helpers.js";

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
