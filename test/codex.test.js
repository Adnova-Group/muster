import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile as execFileCb, spawn } from "node:child_process";
import { chmod, cp, lstat, mkdtemp, mkdir, readFile, readdir, rm, symlink, unlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { parse as parseYaml } from "yaml";
import { CODEX_COUNTS, CODEX_MODEL_POLICY, codexModelForRole, codexModelForTier } from "../src/codex.js";
import { readCodexInventory } from "../src/codex-inventory.js";
import { formatCodexWindowsPath, runCodexInstall, runCodexUninstall } from "../src/codex-install.js";
import { runCodexDoctor } from "../src/codex-doctor.js";
import { adaptCatalogForCodex, codexFallbackSkillId } from "../src/codex-catalog.js";
import { resolveCodexRelease } from "../src/codex-release.js";
import { withCodexFileLock } from "../src/codex-lock.js";

const root = new URL("../", import.meta.url);
const repoRoot = new URL("../", import.meta.url).pathname;
const selectedRelease = await resolveCodexRelease(repoRoot);
const selectedPluginRoot = selectedRelease.pluginRoot;
const response = stdout => async () => ({ stdout });
const execFile = promisify(execFileCb);
const canonicalMusterMarketplace = {
  name: "muster",
  root: repoRoot,
  marketplaceSource: { sourceType: "local", source: repoRoot }
};
const localMusterMarketplace = {
  name: "muster",
  root: repoRoot,
  marketplaceSource: { sourceType: "local", source: repoRoot }
};

function packagedMcpTools() {
  return new Promise((resolve, reject) => {
    const server = spawn("node", [join(selectedPluginRoot, "runtime", "muster-mcp.mjs")], {
      cwd: repoRoot,
      stdio: ["pipe", "pipe", "pipe"]
    });
    let buffer = "";
    const timer = setTimeout(() => {
      server.kill();
      reject(new Error("packaged Codex MCP server timed out"));
    }, 10_000);
    const finish = (error, result) => {
      clearTimeout(timer);
      server.kill();
      if (error) reject(error); else resolve(result);
    };
    server.stdout.setEncoding("utf8");
    server.stdout.on("data", chunk => {
      buffer += chunk;
      for (;;) {
        const newline = buffer.indexOf("\n");
        if (newline < 0) return;
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (!line) continue;
        const message = JSON.parse(line);
        if (message.id === 2) finish(null, message.result.tools);
      }
    });
    server.stderr.setEncoding("utf8");
    let stderr = "";
    server.stderr.on("data", chunk => { stderr += chunk; });
    server.on("error", error => finish(error));
    server.on("exit", code => {
      if (code && stderr) finish(new Error(stderr));
    });
    const init = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0" } } };
    server.stdin.write(JSON.stringify(init) + "\n");
    server.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }) + "\n");
  });
}

function runCodexHook(payload, cwd = repoRoot, hookPath = join(repoRoot, "codex", "hooks", "muster-hook.mjs"), env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn("node", [hookPath], { cwd, env: { ...process.env, ...env }, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", chunk => { stdout += chunk; });
    child.stderr.on("data", chunk => { stderr += chunk; });
    child.on("error", reject);
    child.on("exit", code => code === 0 ? resolve(stdout.trim() ? JSON.parse(stdout) : {}) : reject(new Error(stderr || `hook exited ${code}`)));
    child.stdin.end(JSON.stringify(payload));
  });
}

test("Codex policy pins the four tier/model/reasoning combinations", () => {
  assert.deepEqual(CODEX_MODEL_POLICY, {
    haiku: { model: "gpt-5.6-luna", reasoning: "high" },
    sonnet: { model: "gpt-5.6-terra", reasoning: "high" },
    opus: { model: "gpt-5.6-sol", reasoning: "high" },
    fable: { model: "gpt-5.6-sol", reasoning: "max" }
  });
  assert.deepEqual(codexModelForTier("haiku"), CODEX_MODEL_POLICY.haiku);
  assert.throws(() => codexModelForTier("unknown"), /unknown Muster model tier/);
});

test("Codex generated profiles apply manifest reasoning overrides and reviewer sandbox policy", async () => {
  const mapping = JSON.parse(await readFile(join(repoRoot, "codex", "agents.manifest.json"), "utf8"));
  const expected = {
    "muster-builder": { tier: "sonnet", reasoning: "high", readOnly: false },
    "muster-investigator": { tier: "haiku", reasoning: "high", readOnly: true },
    "wsh-code-reviewer": { tier: "sonnet", reasoning: "high", readOnly: true },
    "wsh-security-auditor": { tier: "sonnet", reasoning: "xhigh", readOnly: true },
    "wsh-api-documenter": { tier: "sonnet", reasoning: "medium", readOnly: false },
    "wsh-business-analyst": { tier: "sonnet", reasoning: "medium", readOnly: false },
    "wsh-content-marketer": { tier: "sonnet", reasoning: "medium", readOnly: false },
    "wsh-customer-support": { tier: "sonnet", reasoning: "medium", readOnly: false },
    "wsh-test-automator": { tier: "sonnet", reasoning: "medium", readOnly: false },
    "wsh-tutorial-engineer": { tier: "sonnet", reasoning: "medium", readOnly: false }
  };
  for (const [id, policy] of Object.entries(expected)) {
    const config = mapping.agents[id];
    assert.equal(config.tier, policy.tier, `${id} must retain its model tier`);
    assert.equal(config.reasoning ?? CODEX_MODEL_POLICY[config.tier].reasoning, policy.reasoning, `${id} reasoning policy`);
    assert.equal(Boolean(config.readOnly), policy.readOnly, `${id} read-only policy`);
    const profile = await readFile(join(selectedRelease.releaseRoot, "profiles", `${id}.toml`), "utf8");
    assert.match(profile, new RegExp(`model = ${JSON.stringify(CODEX_MODEL_POLICY[policy.tier].model)}`), `${id} model`);
    assert.match(profile, new RegExp(`model_reasoning_effort = ${JSON.stringify(policy.reasoning)}`), `${id} reasoning`);
    assert.match(profile, new RegExp(`sandbox_mode = ${JSON.stringify(policy.readOnly ? "read-only" : "workspace-write")}`), `${id} sandbox`);
  }
});

test("Codex adapter preserves shared cap and Fable fallback resolution", () => {
  const oldCap = process.env.MUSTER_MAX_TIER, oldFable = process.env.MUSTER_ENABLE_FABLE;
  try {
    delete process.env.MUSTER_ENABLE_FABLE;
    delete process.env.MUSTER_MAX_TIER;
    assert.deepEqual(codexModelForRole("architecture-review"), CODEX_MODEL_POLICY.opus);
    process.env.MUSTER_ENABLE_FABLE = "true";
    assert.deepEqual(codexModelForRole("architecture-review"), CODEX_MODEL_POLICY.fable);
    process.env.MUSTER_MAX_TIER = "sonnet";
    assert.deepEqual(codexModelForRole("architecture-review"), CODEX_MODEL_POLICY.sonnet);
  } finally {
    if (oldCap === undefined) delete process.env.MUSTER_MAX_TIER; else process.env.MUSTER_MAX_TIER = oldCap;
    if (oldFable === undefined) delete process.env.MUSTER_ENABLE_FABLE; else process.env.MUSTER_ENABLE_FABLE = oldFable;
  }
});

test("Codex capability catalog prefers enabled native upstream skills and namespaces GSD fallback", () => {
  const catalog = [
    { id: "sp-plan", kind: "builtin", roles: ["plan"], rank: 50, provenance: { license: "MIT" } },
    { id: "wsh-code-review-excellence", kind: "builtin", roles: ["code-review"], rank: 50, provenance: { license: "MIT" } },
    { id: "gsd-execute-phase", kind: "builtin", roles: ["implement"], rank: 50, provenance: { license: "MIT" } }
  ];
  const adapted = adaptCatalogForCodex(catalog, { skills: ["writing-plans", "code-review-excellence", "gsd-execute-phase"] });
  assert.ok(adapted.some(entry => entry.id === "writing-plans" && entry.kind === "external"));
  assert.ok(adapted.some(entry => entry.id === "code-review-excellence" && entry.kind === "external"));
  assert.ok(adapted.some(entry => entry.id === "gsd-execute-phase" && entry.kind === "external"));
  assert.ok(adapted.some(entry => entry.id === "muster-gsd-execute-phase" && entry.kind === "builtin"));
  assert.equal(codexFallbackSkillId("sp-plan"), "sp-plan");
  assert.equal(codexFallbackSkillId("gsd-plan-phase"), "muster-gsd-plan-phase");
});

test("Codex inventory is driven by live JSON and project/user directories", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "muster-codex-inventory-"));
  const plugin = join(tmp, "live-plugin");
  await mkdir(join(plugin, "skills", "plugin-skill"), { recursive: true });
  await mkdir(join(plugin, "agents"), { recursive: true });
  await mkdir(join(tmp, "project", ".codex", "skills", "project-skill"), { recursive: true });
  await mkdir(join(tmp, "home", "skills", "user-skill"), { recursive: true });
  await mkdir(join(tmp, "project", ".codex", "agents"), { recursive: true });
  await writeFile(join(plugin, "skills", "plugin-skill", "SKILL.md"), "---\nname: plugin-skill\ndescription: test\n---\n");
  await writeFile(join(plugin, "agents", "plugin-agent.toml"), "name = 'plugin-agent'\n");
  await writeFile(join(tmp, "project", ".codex", "skills", "project-skill", "SKILL.md"), "---\nname: project-skill\ndescription: test\n---\n");
  await writeFile(join(tmp, "home", "skills", "user-skill", "SKILL.md"), "---\nname: user-skill\ndescription: test\n---\n");
  await writeFile(join(tmp, "project", ".codex", "agents", "project-agent.toml"), "name = 'project-agent'\n");
  const execFile = async (_bin, args) => {
    if (args[0] === "plugin") return { stdout: JSON.stringify({ installed: [
      { name: "muster", installed: true, enabled: true, source: { path: plugin } },
      { name: "disabled-plugin", installed: true, enabled: false, source: { path: "/never-read" } }
    ], available: [{ name: "stale", installed: false, enabled: true, source: { path: "/never-read" } }] }) };
    return { stdout: JSON.stringify([{ name: "muster", enabled: true }, { name: "disabled-mcp", enabled: false }]) };
  };
  const inventory = await readCodexInventory({ cwd: join(tmp, "project"), codexHome: join(tmp, "home"), execFile });
  assert.deepEqual(inventory.plugins, ["muster"]);
  assert.deepEqual(new Set(inventory.skills), new Set(["plugin-skill", "project-skill", "user-skill"]));
  assert.deepEqual(inventory.mcpServers, ["muster"]);
  assert.deepEqual(new Set(inventory.agents), new Set(["plugin-agent", "project-agent"]));
});

test("Codex inventory excludes disabled plugins and MCP servers", async () => {
  const execFile = async (_bin, args) => args[0] === "plugin"
    ? { stdout: JSON.stringify({ installed: [{ name: "disabled", installed: true, enabled: false, source: { path: "/never-read" } }] }) }
    : { stdout: JSON.stringify([{ name: "disabled", enabled: false }, { name: "active", enabled: true }]) };
  const inventory = await readCodexInventory({ cwd: "/nonexistent", codexHome: "/nonexistent", execFile });
  assert.deepEqual(inventory.plugins, []);
  assert.deepEqual(inventory.skills, []);
  assert.deepEqual(inventory.agents, []);
  assert.deepEqual(inventory.mcpServers, ["active"]);
});

test("packaged Codex MCP runtime registers the shared 21 tools", async () => {
  const tools = await packagedMcpTools();
  assert.equal(tools.length, CODEX_COUNTS.mcpTools);
  assert.ok(tools.every(tool => tool.name.startsWith("muster_")));
  const runtime = await readFile(join(selectedPluginRoot, "runtime", "muster-mcp.mjs"), "utf8");
  assert.match(runtime, /"capabilities", "--codex"/);
  assert.match(runtime, /"assess", "--codex"/);
  assert.doesNotMatch(runtime, /"capabilities", "--cowork"/);
});

test("npm package contents include the selected immutable Codex generation", async () => {
  const { stdout } = await execFile("npm", ["pack", "--dry-run", "--json"], { cwd: repoRoot, maxBuffer: 16 * 1024 * 1024 });
  const files = new Set(JSON.parse(stdout)[0].files.map(file => file.path));
  const release = `.agents/plugins/releases/${selectedRelease.generation}`;
  for (const path of [
    ".agents/plugins/marketplace.json",
    `${release}/release.json`,
    `${release}/plugin/runtime/muster.mjs`,
    `${release}/profiles/muster-builder.toml`
  ]) assert.ok(files.has(path), `npm package is missing ${path}`);
});

test("packaged Codex CLI runs without a consumer npm install", async () => {
  const runtime = join(selectedPluginRoot, "runtime", "muster.mjs");
  const { stdout } = await execFile("node", [runtime, "detect", repoRoot], { cwd: repoRoot });
  const result = JSON.parse(stdout);
  assert.equal(result.vcs.isRepo, true);
});

test("packaged Codex workflows use the bundled CLI and Codex-native mode names", async () => {
  const commands = join(selectedPluginRoot, "commands");
  for (const entry of await readdir(commands, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
    const text = await readFile(join(commands, entry.name), "utf8");
    assert.doesNotMatch(text, /npx -y @adnova-group\/muster/, entry.name);
    assert.doesNotMatch(text, /\/muster:(?:plan|go|plan-backlog|go-backlog|run|autopilot|sprint|diagnose|audit|runner|capture)\b/, entry.name);
  }
  const router = await readFile(join(selectedPluginRoot, "skills", "router", "SKILL.md"), "utf8");
  assert.match(router, /runtime\/muster\.mjs match --codex --skills/);
  const runner = await readFile(join(commands, "runner.md"), "utf8");
  assert.match(runner, /Usage: \$muster-runner/);
  assert.match(runner, /codex exec "\$muster-runner/);
  assert.doesNotMatch(runner, /\$muster-planner|Claude Code Routine|claude -p/);
  const coordination = await readFile(join(selectedPluginRoot, "skills", "coordination", "SKILL.md"), "utf8");
  assert.match(coordination, /plugin cache is not a Git checkout/);
  assert.doesNotMatch(coordination, /git log -1 --format/);
  const orchestrator = await readFile(join(selectedPluginRoot, "skills", "orchestrator", "SKILL.md"), "utf8");
  assert.match(orchestrator, /call `collaboration\.spawn_agent`/);
  assert.match(orchestrator, /agent_type: "<exact chosen\.id>"/);
  assert.match(orchestrator, /fork_turns/);
  assert.match(orchestrator, /never `"all"`/);
  assert.match(orchestrator, /absolute `WORKTREE CWD`/);
  assert.match(orchestrator, /never read the parent checkout's `.muster` artifacts/);
  assert.match(orchestrator, /Only an actual rejected tool call proves the named profile unavailable/);
  assert.match(orchestrator, /Do not silently use a generic agent/);
  assert.doesNotMatch(orchestrator, /generic-subagent fallback|isolation: "worktree"|hook-enforced -- these BLOCK/);

  for (const command of ["plan", "go", "plan-backlog", "go-backlog", "diagnose", "audit", "runner", "capture"]) {
    const commandText = await readFile(join(commands, `${command}.md`), "utf8");
    const skillText = await readFile(join(selectedPluginRoot, "skills", `muster-${command}`, "SKILL.md"), "utf8");
    assert.match(commandText, /runtime\/codex-skill-adapter\.md/, `${command} command must load the Codex adapter`);
    assert.match(skillText, /runtime\/codex-skill-adapter\.md/, `${command} skill must load the Codex adapter`);
  }
  const diagnose = await readFile(join(commands, "diagnose.md"), "utf8");
  assert.match(diagnose, /prints `\{mode, manifest\}` JSON to stdout/);
  assert.match(diagnose, /Extract the emitted `manifest` object/);
  assert.match(diagnose, /manifest validate \.muster\/manifest\.json --codex/);
  const audit = await readFile(join(commands, "audit.md"), "utf8");
  assert.match(audit, /prints the Crew Manifest JSON to stdout/);
  assert.match(audit, /manifest validate \.muster\/manifest\.json --codex/);
  const go = await readFile(join(commands, "go.md"), "utf8");
  assert.match(go, /manifest validate \.muster\/manifest\.json --codex/);
  for (const command of ["go", "diagnose", "audit"]) {
    const text = await readFile(join(commands, `${command}.md`), "utf8");
    assert.doesNotMatch(text, /manifest validate --codex(?:`|\s+until)/, `${command} must name the manifest file`);
  }
});

test("generated Codex orchestration surfaces enforce the bounded agent watch invariant", async () => {
  const surfaces = new Map([
    ["adapter", join(selectedPluginRoot, "runtime", "codex-skill-adapter.md")],
    ["orchestrator", join(selectedPluginRoot, "skills", "orchestrator", "SKILL.md")],
    ...["muster-plan", "muster-go", "muster-plan-backlog", "muster-go-backlog", "muster-diagnose", "muster-audit", "muster-runner", "muster-capture", "run", "autopilot", "sprint"]
      .map(name => [name, join(selectedPluginRoot, "skills", name, "SKILL.md")])
  ]);
  for (const [name, path] of surfaces) {
    const text = await readFile(path, "utf8");
    for (const marker of ["collaboration.list_agents", "collaboration.wait_agent", "60 seconds", "message or completion receipt", "mailbox receipts first", "exactly once", "newly ready work", "timeout is only a heartbeat", "Never tight-poll", "never prompt the user", "live agents", "executable steps", "HUMAN-HOLD", "merge decision"]) {
      assert.match(text, new RegExp(marker.replaceAll(".", "\\.")), `${name} must carry watch marker ${marker}`);
    }
    assert.ok(text.indexOf("collaboration.wait_agent") < text.indexOf("collaboration.list_agents"), `${name} must wait before its first reconciliation poll`);
    assert.ok(text.indexOf("mailbox receipts first") < text.indexOf("collaboration.list_agents"), `${name} must process the wake receipt before reconciling`);
  }
});

test("Codex manifest validation fails closed on a bound skill absent from live Codex inventory", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "muster-codex-manifest-"));
  const file = join(tmp, "manifest.json");
  await writeFile(file, JSON.stringify({
    outcome: "Verify one result",
    successCriteria: ["One check passes"],
    crew: [{ stage: "code-review", provider: "inline", source: "inline", rationale: "Review", evidence: "One check", fallback: "inline" }],
    recommendations: [],
    degradations: [],
    plan: [{ id: "t1", task: "Verify", mode: "single", deps: [], skills: [{ id: "definitely-not-installed", rationale: "Dogfood guard" }] }]
  }));
  const runtime = join(selectedPluginRoot, "runtime", "muster.mjs");
  await assert.rejects(
    () => execFile("node", [runtime, "manifest", "validate", "--codex", file], { cwd: tmp, env: { ...process.env, CODEX_HOME: join(tmp, "home") } }),
    error => error.code === 2 && /definitely-not-installed/.test(error.stdout)
  );
});

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

test("Codex hook emits each logical event once across concurrent installed copies", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "muster-codex-hook-dedupe-"));
  const codexHome = join(tmp, "codex-home"), copies = [join(tmp, "project-copy"), join(tmp, "user-copy")];
  for (const copy of copies) await cp(join(repoRoot, "codex", "hooks"), copy, { recursive: true });
  const payload = { hook_event_name: "SessionStart", session_id: "session-dedupe", source: "startup", cwd: tmp };
  const outputs = await Promise.all(copies.map(copy => runCodexHook(payload, tmp, join(copy, "muster-hook.mjs"), { CODEX_HOME: codexHome })));
  assert.equal(outputs.filter(output => output.hookSpecificOutput).length, 1);

  const firstTurn = await runCodexHook({ hook_event_name: "UserPromptSubmit", session_id: "session-dedupe", turn_id: "turn-1", prompt: "muster audit", cwd: tmp }, tmp, join(copies[0], "muster-hook.mjs"), { CODEX_HOME: codexHome });
  const repeatedTurn = await runCodexHook({ hook_event_name: "UserPromptSubmit", session_id: "session-dedupe", turn_id: "turn-1", prompt: "muster audit", cwd: tmp }, tmp, join(copies[1], "muster-hook.mjs"), { CODEX_HOME: codexHome });
  const secondTurn = await runCodexHook({ hook_event_name: "UserPromptSubmit", session_id: "session-dedupe", turn_id: "turn-2", prompt: "muster audit", cwd: tmp }, tmp, join(copies[1], "muster-hook.mjs"), { CODEX_HOME: codexHome });
  assert.ok(firstTurn.hookSpecificOutput);
  assert.deepEqual(repeatedTurn, {});
  assert.ok(secondTurn.hookSpecificOutput);

  const victim = join(tmp, "stale-cleanup-victim.txt");
  await writeFile(victim, "keep\n");
  await mkdir(join(codexHome, "muster", "hook-events", "aa"));
  await symlink(victim, join(codexHome, "muster", "hook-events", "aa", `${"a".repeat(64)}.json`));
  await runCodexHook({ hook_event_name: "UserPromptSubmit", session_id: "session-dedupe", turn_id: "turn-3", prompt: "muster audit", cwd: tmp }, tmp, join(copies[0], "muster-hook.mjs"), { CODEX_HOME: codexHome });
  assert.equal(await readFile(victim, "utf8"), "keep\n");
});

test("Codex hook dedupe bounds cleanup work and records per shard", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "muster-codex-hook-load-")), codexHome = join(tmp, "codex-home");
  const payload = { hook_event_name: "UserPromptSubmit", session_id: "load", turn_id: "turn-1", prompt: "muster audit", cwd: tmp };
  const key = createHash("sha256").update(JSON.stringify(["UserPromptSubmit", "load", "turn-1", ""])).digest("hex");
  const shard = join(codexHome, "muster", "hook-events", key.slice(0, 2));
  await mkdir(shard, { recursive: true });
  await Promise.all(Array.from({ length: 512 }, (_, index) => {
    const name = createHash("sha256").update(`seed-${index}`).digest("hex");
    return writeFile(join(shard, `${name}.json`), "{}\n");
  }));
  const old = new Date(Date.now() - 10 * 60 * 1000);
  for (const name of [".cleanup-lock", ".capacity-lock"]) {
    const path = join(shard, name);
    await writeFile(path, JSON.stringify({ format: 1, pid: 99999999, createdAt: old.getTime(), token: "crashed" }) + "\n");
    await utimes(path, old, old);
  }
  const started = Date.now();
  const output = await runCodexHook(payload, tmp, join(repoRoot, "codex", "hooks", "muster-hook.mjs"), { CODEX_HOME: codexHome });
  assert.ok(output.hookSpecificOutput);
  assert.ok(Date.now() - started < 5_000, "bounded shard cleanup must not scan an unbounded global event history");
  const records = (await readdir(shard)).filter(name => /^[a-f0-9]{64}\.json$/.test(name));
  assert.ok(records.length <= 64, `expected at most 64 records in one shard, got ${records.length}`);
  await Promise.all([".cleanup-lock", ".capacity-lock"].map(name => assert.rejects(readFile(join(shard, name), "utf8"))));
});

test("Codex hook expires a forged live-PID capacity lock and enforces the shard cap", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "muster-codex-hook-expired-live-lock-")), codexHome = join(tmp, "codex-home");
  const payload = { hook_event_name: "UserPromptSubmit", session_id: "expired-live-lock", turn_id: "turn-1", prompt: "muster audit", cwd: tmp };
  const key = createHash("sha256").update(JSON.stringify(["UserPromptSubmit", "expired-live-lock", "turn-1", ""])).digest("hex");
  const shard = join(codexHome, "muster", "hook-events", key.slice(0, 2));
  await mkdir(shard, { recursive: true });
  await Promise.all(Array.from({ length: 64 }, (_, index) => {
    const name = createHash("sha256").update(`expired-live-lock-${index}`).digest("hex");
    return writeFile(join(shard, `${name}.json`), "{}\n");
  }));
  const lock = join(shard, ".capacity-lock"), old = new Date(Date.now() - 10 * 60 * 1000);
  await writeFile(lock, JSON.stringify({ format: 1, pid: process.pid, createdAt: old.getTime(), token: "forged-live" }) + "\n");
  await utimes(lock, old, old);
  assert.ok((await runCodexHook(payload, tmp, join(repoRoot, "codex", "hooks", "muster-hook.mjs"), { CODEX_HOME: codexHome })).hookSpecificOutput);
  const records = (await readdir(shard)).filter(name => /^[a-f0-9]{64}\.json$/.test(name));
  assert.ok(records.length <= 64, `expired live-PID lock must not bypass the shard cap, got ${records.length}`);
  await assert.rejects(readFile(lock, "utf8"));
});

test("Codex fallbacks are self-contained and package referenced skill assets", async () => {
  const skills = join(selectedPluginRoot, "skills");
  for (const name of ["muster-gsd-plan-phase", "muster-gsd-execute-phase", "muster-gsd-verify-work"]) {
    const text = await readFile(join(skills, name, "SKILL.md"), "utf8");
    assert.match(text, /self-contained|no dependency/i, name);
    assert.doesNotMatch(text, /@~\/\.claude|\$HOME\/\.claude|npx\s+-y\s+@opengsd/, name);
  }
  const api = await readFile(join(skills, "wsh-api-design-principles", "SKILL.md"), "utf8");
  assert.match(api, /references\/details\.md/);
  assert.match(await readFile(join(skills, "wsh-api-design-principles", "references", "details.md"), "utf8"), /API|api/);
  const signed = await readFile(join(skills, "wsh-signed-audit-trails-recipe", "SKILL.md"), "utf8");
  assert.match(signed, /Codex lifecycle hooks/);
  assert.doesNotMatch(signed, /\.claude\/settings\.json/);
  const catalog = await readFile(join(selectedPluginRoot, "catalog", "builtins.muster.yaml"), "utf8");
  assert.match(catalog, /rudra496\/StealthHumanizer/);
});

test("all ported skills declare and load the Codex harness binding", async () => {
  const native = (await readdir(join(repoRoot, "plugin", "skills"), { withFileTypes: true })).filter(entry => entry.isDirectory()).map(entry => entry.name);
  const builtins = (await readdir(join(repoRoot, "plugin", "builtins"), { withFileTypes: true })).filter(entry => entry.isDirectory()).map(entry => entry.name);
  for (const name of new Set([...native, ...builtins])) {
    const id = codexFallbackSkillId(name);
    const skill = await readFile(join(selectedPluginRoot, "skills", id, "SKILL.md"), "utf8");
    const frontmatter = skill.match(/^---\r?\n([\s\S]*?)\r?\n---/)?.[1] || "";
    assert.equal(parseYaml(frontmatter).name, id, id);
    assert.ok(parseYaml(frontmatter).description.startsWith("Codex-compatible Muster workflow."), id);
    assert.doesNotMatch(skill, /AskUserQuestion|\/muster:|Claude Code Agent tool|\bAgent tool|\bTask tool/, id);
    assert.match(skill, /runtime\/codex-skill-adapter\.md/, id);
  }
  assert.match(await readFile(join(selectedPluginRoot, "runtime", "codex-skill-adapter.md"), "utf8"), /Treat `Agent` and `Task` calls as Codex subagent dispatch/);
});

test("Codex installation owns only its profile manifest and is repeatable", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "muster-codex-install-"));
  const cwd = join(tmp, "project"), home = join(tmp, "home");
  await mkdir(join(cwd, ".codex"), { recursive: true });
  const userHook = { hooks: { Stop: [{ hooks: [{ type: "command", command: "printf user-hook" }] }] } };
  await writeFile(join(cwd, ".codex", "hooks.json"), JSON.stringify(userHook, null, 2));
  const execFile = async (_bin, args) => {
    if (args[0] === "--version") return { stdout: "codex-cli test" };
    if (args.slice(0, 3).join(" ") === "plugin marketplace list") return { stdout: JSON.stringify({ marketplaces: [canonicalMusterMarketplace] }) };
    if (args.slice(0, 3).join(" ") === "plugin list --available") return { stdout: JSON.stringify({ installed: [{ pluginId: "muster@muster", installed: true }] }) };
    if (args.slice(0, 2).join(" ") === "plugin add") return { stdout: "refreshed" };
    throw new Error(`unexpected command: ${args.join(" ")}`);
  };
  const result = await runCodexInstall({ cwd, home, repoRoot, execFile });
  assert.equal(result.profiles, CODEX_COUNTS.agents);
  const agents = join(cwd, ".codex", "agents");
  const manifest = JSON.parse(await readFile(join(agents, ".muster-managed.json"), "utf8"));
  assert.equal(manifest.files.length, CODEX_COUNTS.agents);
  assert.equal(manifest.generation, selectedRelease.generation);
  assert.equal(manifest.bootstrapDigest, JSON.parse(await readFile(join(repoRoot, ".agents", "plugins", "marketplace.json"), "utf8")).musterBootstrap.digest);
  assert.equal(result.hooks, 7);
  const hookManifest = JSON.parse(await readFile(join(cwd, ".codex", "muster", ".muster-managed.json"), "utf8"));
  assert.equal(hookManifest.generation, selectedRelease.generation);
  assert.equal(hookManifest.bootstrapDigest, manifest.bootstrapDigest);
  assert.match(hookManifest.hookHash, /^[a-f0-9]{64}$/);
  const hooks = JSON.parse(await readFile(join(cwd, ".codex", "hooks.json"), "utf8"));
  assert.ok(hooks.hooks.Stop.some(group => group.hooks?.[0]?.command === "printf user-hook"));
  const installedHook = join(cwd, ".codex", "muster", "hooks", "muster-hook.mjs");
  assert.ok(hooks.hooks.SessionStart.some(group => group.hooks?.some(hook => hook.command.includes(installedHook))));
  assert.match((await runCodexHook({ hook_event_name: "SessionStart", session_id: "install-repeatable", source: "startup", cwd }, cwd, installedHook, { CODEX_HOME: join(home, ".codex") })).hookSpecificOutput.additionalContext, /Muster is installed for Codex/);
  await assert.doesNotReject(() => runCodexInstall({ cwd, home, repoRoot, execFile }));
  const repeatedHooks = JSON.parse(await readFile(join(cwd, ".codex", "hooks.json"), "utf8"));
  for (const groups of Object.values(repeatedHooks.hooks)) {
    assert.equal(groups.filter(group => group.hooks?.some(hook => hook.command?.includes("/muster/hooks/muster-hook.mjs"))).length, 1);
  }
  await writeFile(join(agents, "user-agent.toml"), "name = 'user-agent'\n");
  const removed = await runCodexUninstall({ cwd, home, execFile });
  assert.equal(removed.files.length, CODEX_COUNTS.agents + 3);
  assert.equal(await readFile(join(agents, "user-agent.toml"), "utf8"), "name = 'user-agent'\n");
  assert.deepEqual(JSON.parse(await readFile(join(cwd, ".codex", "hooks.json"), "utf8")), userHook);
  await assert.rejects(() => readFile(installedHook, "utf8"));
});

test("Codex installation refuses unrelated profiles and dry-run writes nothing", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "muster-codex-conflict-"));
  const cwd = join(tmp, "project"), home = join(tmp, "home"), agents = join(cwd, ".codex", "agents");
  await mkdir(agents, { recursive: true });
  await writeFile(join(agents, "muster-builder.toml"), "name = 'not-muster'\n");
  const absent = async () => { throw new Error("not found"); };
  await assert.rejects(() => runCodexInstall({ cwd, home, repoRoot, execFile: absent }), /Codex profile conflict/);
  const dry = await runCodexInstall({ cwd: join(tmp, "dry"), home, repoRoot, dryRun: true, execFile: absent });
  assert.equal(dry.plugin.skipped, "codex-not-found");
  await assert.rejects(() => readFile(join(tmp, "dry", ".codex", "agents", ".muster-managed.json"), "utf8"));
  await assert.rejects(() => readFile(join(tmp, "dry", ".codex", "hooks.json"), "utf8"));
  assert.deepEqual(dry.nextSteps, ["npm install -g @openai/codex", "muster install codex --scope project"]);
});

test("Codex uninstall rejects traversal in a managed manifest", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "muster-codex-traversal-"));
  const cwd = join(tmp, "project"), home = join(tmp, "home"), agents = join(cwd, ".codex", "agents");
  const victim = join(cwd, "victim.toml");
  await mkdir(agents, { recursive: true });
  await writeFile(victim, "keep me\n");
  await writeFile(join(agents, ".muster-managed.json"), JSON.stringify({ format: 1, owner: "muster", files: ["../../victim.toml"] }));
  const absent = async () => { throw new Error("not found"); };
  await assert.rejects(() => runCodexUninstall({ cwd, home, repoRoot, execFile: absent }), /Invalid Muster-owned Codex profile/);
  assert.equal(await readFile(victim, "utf8"), "keep me\n");
});

test("Codex install rejects symlinked configuration ancestry and targets without touching victims", async t => {
  const tmp = await mkdtemp(join(tmpdir(), "muster-codex-install-symlink-"));
  const absent = async () => { throw new Error("not found"); };
  const cases = [
    [".codex directory", async (cwd, victim) => {
      await mkdir(victim, { recursive: true });
      await writeFile(join(victim, "sentinel.txt"), "keep\n");
      await symlink(victim, join(cwd, ".codex"));
      return async () => assert.deepEqual(await readdir(victim), ["sentinel.txt"]);
    }],
    ["agents directory", async (cwd, victim) => {
      await mkdir(join(cwd, ".codex"), { recursive: true });
      await mkdir(victim, { recursive: true });
      await writeFile(join(victim, "sentinel.txt"), "keep\n");
      await symlink(victim, join(cwd, ".codex", "agents"));
      return async () => assert.deepEqual(await readdir(victim), ["sentinel.txt"]);
    }],
    ["muster directory", async (cwd, victim) => {
      await mkdir(join(cwd, ".codex"), { recursive: true });
      await mkdir(victim, { recursive: true });
      await writeFile(join(victim, "sentinel.txt"), "keep\n");
      await symlink(victim, join(cwd, ".codex", "muster"));
      return async () => assert.deepEqual(await readdir(victim), ["sentinel.txt"]);
    }],
    ["hooks.json", async (cwd, victim) => {
      await mkdir(join(cwd, ".codex"), { recursive: true });
      const bytes = '{"hooks":{}}\n';
      await writeFile(victim, bytes);
      await symlink(victim, join(cwd, ".codex", "hooks.json"));
      return async () => assert.equal(await readFile(victim, "utf8"), bytes);
    }],
    ["agents manifest", async (cwd, victim) => {
      const agents = join(cwd, ".codex", "agents");
      await mkdir(agents, { recursive: true });
      const bytes = JSON.stringify({ format: 1, owner: "muster", files: [] }) + "\n";
      await writeFile(victim, bytes);
      await symlink(victim, join(agents, ".muster-managed.json"));
      return async () => {
        assert.equal(await readFile(victim, "utf8"), bytes);
        assert.deepEqual(await readdir(agents), [".muster-managed.json"]);
      };
    }]
  ];
  for (const [name, setup] of cases) await t.test(name, async () => {
    const cwd = join(tmp, name.replaceAll(/[^a-z]+/gi, "-")), victim = join(tmp, `${name.replaceAll(/[^a-z]+/gi, "-")}-victim`);
    await mkdir(cwd, { recursive: true });
    const verify = await setup(cwd, victim);
    await assert.rejects(() => runCodexInstall({ cwd, home: join(tmp, "home"), repoRoot, execFile: absent }), /symlink|ordinary|regular/i);
    await verify();
  });
});

test("Codex uninstall rejects symlinked configuration ancestry and targets without touching victims", async t => {
  const tmp = await mkdtemp(join(tmpdir(), "muster-codex-uninstall-symlink-"));
  const absent = async () => { throw new Error("not found"); };
  const managedProfiles = JSON.stringify({ format: 1, owner: "muster", files: ["victim.toml"] }) + "\n";
  const managedHooks = JSON.stringify({ format: 1, owner: "muster", files: ["hooks/victim.mjs"], hookGroups: {} }) + "\n";
  const cases = [
    [".codex directory", async (cwd, victim) => {
      await mkdir(join(victim, "agents"), { recursive: true });
      await writeFile(join(victim, "agents", ".muster-managed.json"), managedProfiles);
      await writeFile(join(victim, "agents", "victim.toml"), "keep\n");
      await symlink(victim, join(cwd, ".codex"));
      return async () => assert.equal(await readFile(join(victim, "agents", "victim.toml"), "utf8"), "keep\n");
    }],
    ["agents directory", async (cwd, victim) => {
      await mkdir(join(cwd, ".codex"), { recursive: true });
      await mkdir(victim, { recursive: true });
      await writeFile(join(victim, ".muster-managed.json"), managedProfiles);
      await writeFile(join(victim, "victim.toml"), "keep\n");
      await symlink(victim, join(cwd, ".codex", "agents"));
      return async () => assert.equal(await readFile(join(victim, "victim.toml"), "utf8"), "keep\n");
    }],
    ["agents manifest", async (cwd, victim) => {
      const agents = join(cwd, ".codex", "agents");
      await mkdir(agents, { recursive: true });
      await writeFile(join(agents, "victim.toml"), "keep\n");
      await writeFile(victim, managedProfiles);
      await symlink(victim, join(agents, ".muster-managed.json"));
      return async () => assert.equal(await readFile(join(agents, "victim.toml"), "utf8"), "keep\n");
    }],
    ["muster directory", async (cwd, victim) => {
      await mkdir(join(cwd, ".codex"), { recursive: true });
      await mkdir(join(victim, "hooks"), { recursive: true });
      await writeFile(join(victim, ".muster-managed.json"), managedHooks);
      await writeFile(join(victim, "hooks", "victim.mjs"), "keep\n");
      await symlink(victim, join(cwd, ".codex", "muster"));
      return async () => assert.equal(await readFile(join(victim, "hooks", "victim.mjs"), "utf8"), "keep\n");
    }],
    ["hook manifest", async (cwd, victim) => {
      const runtime = join(cwd, ".codex", "muster"), hook = join(runtime, "hooks", "victim.mjs");
      await mkdir(dirname(hook), { recursive: true });
      await writeFile(hook, "keep\n");
      await writeFile(victim, managedHooks);
      await symlink(victim, join(runtime, ".muster-managed.json"));
      return async () => assert.equal(await readFile(hook, "utf8"), "keep\n");
    }],
    ["hooks.json", async (cwd, victim) => {
      const runtime = join(cwd, ".codex", "muster");
      await mkdir(runtime, { recursive: true });
      await writeFile(join(runtime, ".muster-managed.json"), JSON.stringify({ format: 1, owner: "muster", files: [], hookGroups: {} }));
      const bytes = '{"hooks":{},"keep":true}\n';
      await writeFile(victim, bytes);
      await symlink(victim, join(cwd, ".codex", "hooks.json"));
      return async () => assert.equal(await readFile(victim, "utf8"), bytes);
    }]
  ];
  for (const [name, setup] of cases) await t.test(name, async () => {
    const cwd = join(tmp, name.replaceAll(/[^a-z]+/gi, "-")), victim = join(tmp, `${name.replaceAll(/[^a-z]+/gi, "-")}-victim`);
    await mkdir(cwd, { recursive: true });
    const verify = await setup(cwd, victim);
    await assert.rejects(() => runCodexUninstall({ cwd, home: join(tmp, "home"), execFile: absent }), /symlink|ordinary|regular/i);
    await verify();
  });
});

test("Codex upgrade and uninstall clean historical managed profiles", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "muster-codex-historical-"));
  const cwd = join(tmp, "project"), home = join(tmp, "home"), agents = join(cwd, ".codex", "agents");
  const stale = join(agents, "retired-specialist.toml");
  await mkdir(agents, { recursive: true });
  await writeFile(stale, "name = 'retired'\n");
  await writeFile(join(agents, ".muster-managed.json"), JSON.stringify({ format: 1, owner: "muster", files: ["retired-specialist.toml"] }));
  const absent = async () => { throw new Error("not found"); };
  const upgraded = await runCodexInstall({ cwd, home, repoRoot, execFile: absent });
  assert.ok(upgraded.files.some(item => item.op === "remove" && item.path === stale));
  await assert.rejects(() => readFile(stale, "utf8"));
  const manifest = JSON.parse(await readFile(join(agents, ".muster-managed.json"), "utf8"));
  assert.ok(!manifest.files.includes("retired-specialist.toml"));

  const hookRoot = join(cwd, ".codex", "muster"), retiredHook = join(hookRoot, "hooks", "retired-hook.mjs");
  const hookManifestPath = join(hookRoot, ".muster-managed.json");
  const hookManifest = JSON.parse(await readFile(hookManifestPath, "utf8"));
  hookManifest.files.push("hooks/retired-hook.mjs");
  await writeFile(hookManifestPath, JSON.stringify(hookManifest));
  await writeFile(retiredHook, "// retired\n");
  const hookUpgrade = await runCodexInstall({ cwd, home, repoRoot, execFile: absent });
  assert.ok(hookUpgrade.files.some(item => item.op === "remove" && item.path === retiredHook));
  await assert.rejects(() => readFile(retiredHook, "utf8"));

  await writeFile(stale, "name = 'retired'\n");
  await writeFile(join(agents, ".muster-managed.json"), JSON.stringify({ format: 1, owner: "muster", files: ["retired-specialist.toml"] }));
  const uninstalled = await runCodexUninstall({ cwd, home, execFile: absent });
  assert.ok(uninstalled.files.some(item => item.op === "remove" && item.path === stale));
  assert.ok(uninstalled.files.some(item => item.op === "remove" && item.path.endsWith("muster-hook.mjs")));
  assert.ok(uninstalled.files.some(item => item.op === "remove" && item.path.endsWith("hooks.json")));
  await assert.rejects(() => readFile(stale, "utf8"));
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

test("Codex user-scope install and uninstall use CODEX_HOME without disturbing user hooks", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "muster-codex-user-scope-"));
  const cwd = join(tmp, "project"), home = join(tmp, "home"), target = join(home, ".codex");
  const absent = async () => { throw new Error("not found"); };
  await mkdir(target, { recursive: true });
  const existing = { hooks: { Stop: [{ hooks: [{ type: "command", command: "printf existing" }] }] } };
  await writeFile(join(target, "hooks.json"), JSON.stringify(existing));
  const installed = await runCodexInstall({ scope: "user", cwd, home, repoRoot, execFile: absent });
  assert.ok(installed.files.some(item => item.path === join(target, "agents", "muster-builder.toml")));
  assert.ok(installed.files.some(item => item.path === join(target, "muster", "hooks", "muster-hook.mjs")));
  await runCodexUninstall({ scope: "user", cwd, home, execFile: absent });
  assert.deepEqual(JSON.parse(await readFile(join(target, "hooks.json"), "utf8")), existing);
  await assert.rejects(() => readFile(join(target, "agents", "muster-builder.toml"), "utf8"));
});

test("Codex doctor reports project/user hook overlap as a deduped advisory", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "muster-codex-hook-overlap-"));
  const cwd = join(tmp, "project"), home = join(tmp, "home"), codexHome = join(home, ".codex");
  const absent = async () => { throw new Error("not found"); };
  await runCodexInstall({ scope: "project", cwd, home, repoRoot, execFile: absent });
  await runCodexInstall({ scope: "user", cwd, home, repoRoot, execFile: absent });
  const report = await runCodexDoctor({ root: repoRoot, cwd, codexHome, execFile: absent });
  const overlap = report.checks.find(check => check.name === "codex-hooks-overlap");
  assert.equal(overlap?.ok, true);
  assert.match(overlap?.detail || "", /project and user.*runtime dedupe/i);
});

test("Codex doctor requires exact owned hook groups from source and cache installs", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "muster-codex-hook-doctor-exact-"));
  const cwd = join(tmp, "project"), home = join(tmp, "home"), codexHome = join(home, ".codex");
  const absent = async () => { throw new Error("not found"); };
  await runCodexInstall({ scope: "project", cwd, home, repoRoot, execFile: absent });
  await runCodexInstall({ scope: "user", cwd, home, repoRoot: selectedPluginRoot, execFile: absent });

  const healthy = await runCodexDoctor({ root: repoRoot, cwd, codexHome, execFile: absent });
  assert.equal(healthy.checks.find(check => check.name === "codex-hooks")?.ok, true);
  assert.equal(healthy.checks.find(check => check.name === "codex-hooks-overlap")?.ok, true);

  const hooksPath = join(cwd, ".codex", "hooks.json");
  const original = JSON.parse(await readFile(hooksPath, "utf8"));
  for (const [label, mutate] of [
    ["matcher", hooks => { hooks.hooks.SessionStart.find(group => group.hooks?.some(hook => hook.command.includes("/muster/hooks/muster-hook.mjs"))).matcher = "resume"; }],
    ["timeout", hooks => { hooks.hooks.PreToolUse.find(group => group.hooks?.some(hook => hook.command.includes("/muster/hooks/muster-hook.mjs"))).hooks[0].timeout = 11; }]
  ]) {
    const drifted = structuredClone(original);
    mutate(drifted);
    await writeFile(hooksPath, JSON.stringify(drifted, null, 2));
    const report = await runCodexDoctor({ root: repoRoot, cwd, codexHome, execFile: absent });
    assert.equal(report.checks.find(check => check.name === "codex-hooks")?.ok, false, `${label} drift must fail hook health`);
    assert.equal(report.checks.find(check => check.name === "codex-hooks-overlap")?.ok, false, `${label} drift must make dedupe reporting uncertain`);
  }
  await writeFile(hooksPath, JSON.stringify(original, null, 2));
  await unlink(join(codexHome, "hooks.json"));
  const missingUserConfig = await runCodexDoctor({ root: repoRoot, cwd, codexHome, execFile: absent });
  assert.equal(missingUserConfig.checks.find(check => check.name === "codex-hooks")?.ok, false, "a managed scope missing hooks.json must fail hook health");
  assert.equal(missingUserConfig.checks.find(check => check.name === "codex-hooks-overlap")?.ok, false, "a missing managed scope must make dedupe reporting uncertain");
});

test("Codex uninstall retains the shared plugin until the final managed scope is removed", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "muster-codex-dual-scope-")), cwd = join(tmp, "project"), home = join(tmp, "home"), calls = [];
  const execFile = async (_bin, args) => {
    calls.push(args.join(" "));
    if (args[0] === "--version") return { stdout: "codex-cli test" };
    if (args.slice(0, 3).join(" ") === "plugin marketplace list") return { stdout: JSON.stringify({ marketplaces: [localMusterMarketplace] }) };
    if (args.slice(0, 3).join(" ") === "plugin list --available") return { stdout: JSON.stringify({ installed: [] }) };
    return { stdout: "" };
  };
  await runCodexInstall({ scope: "project", cwd, home, repoRoot, execFile });
  await runCodexInstall({ scope: "user", cwd, home, repoRoot, execFile });
  calls.length = 0;
  const first = await runCodexUninstall({ scope: "project", cwd, home, execFile });
  assert.equal(first.plugin.retained, true);
  assert.equal(calls.includes("plugin remove muster@muster"), false);
  const last = await runCodexUninstall({ scope: "user", cwd, home, execFile });
  assert.equal(last.plugin.removed, true);
  assert.equal(calls.filter(call => call === "plugin remove muster@muster").length, 1);
});

test("Codex managed-scope registry retains the plugin across multiple projects in either uninstall order", async () => {
  for (const order of [["a", "b"], ["b", "a"]]) {
    const tmp = await mkdtemp(join(tmpdir(), "muster-codex-project-registry-")), home = join(tmp, "home"), calls = [];
    const projects = { a: join(tmp, "project-a"), b: join(tmp, "project-b") };
    const execFile = async (_bin, args) => {
      calls.push(args.join(" "));
      if (args[0] === "--version") return { stdout: "codex-cli test" };
      if (args.slice(0, 3).join(" ") === "plugin marketplace list") return { stdout: JSON.stringify({ marketplaces: [localMusterMarketplace] }) };
      if (args.slice(0, 3).join(" ") === "plugin list --available") return { stdout: JSON.stringify({ installed: [] }) };
      return { stdout: "" };
    };
    await runCodexInstall({ cwd: projects.a, home, repoRoot, execFile });
    await runCodexInstall({ cwd: projects.b, home, repoRoot, execFile });
    calls.length = 0;
    assert.equal((await runCodexUninstall({ cwd: projects[order[0]], home, execFile })).plugin.retained, true);
    assert.equal(calls.includes("plugin remove muster@muster"), false);
    assert.equal((await runCodexUninstall({ cwd: projects[order[1]], home, execFile })).plugin.removed, true);
    assert.equal(calls.filter(call => call === "plugin remove muster@muster").length, 1);
  }
});

test("Codex concurrent installs preserve every managed project owner", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "muster-codex-registry-concurrent-install-"));
  const home = join(tmp, "home"), projects = ["a", "b", "c", "d"].map(name => join(tmp, `project-${name}`));
  const absent = async () => { throw new Error("not found"); };
  await Promise.all(projects.map(cwd => runCodexInstall({ cwd, home, repoRoot: selectedPluginRoot, execFile: absent })));
  const registry = JSON.parse(await readFile(join(home, ".codex", "muster", "install-scopes.json"), "utf8"));
  assert.deepEqual(new Set(registry.entries.map(entry => entry.configDir)), new Set(projects.map(cwd => join(cwd, ".codex"))));
});

test("Codex concurrent uninstalls retain the plugin until one final removal", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "muster-codex-registry-concurrent-uninstall-"));
  const home = join(tmp, "home"), projects = ["a", "b"].map(name => join(tmp, `project-${name}`)), calls = [];
  const execFile = async (_bin, args) => {
    calls.push(args.join(" "));
    if (args[0] === "--version") return { stdout: "codex-cli test" };
    if (args.slice(0, 3).join(" ") === "plugin marketplace list") return { stdout: JSON.stringify({ marketplaces: [localMusterMarketplace] }) };
    if (args.slice(0, 3).join(" ") === "plugin list --available") return { stdout: JSON.stringify({ installed: [] }) };
    return { stdout: "" };
  };
  for (const cwd of projects) await runCodexInstall({ cwd, home, repoRoot, execFile });
  calls.length = 0;
  await Promise.all(projects.map(cwd => runCodexUninstall({ cwd, home, execFile })));
  assert.equal(calls.filter(call => call === "plugin remove muster@muster").length, 1);
});

test("Codex recovers a valid stale managed-scope lock and rejects unsafe locks", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "muster-codex-registry-stale-lock-"));
  const home = join(tmp, "home"), cwd = join(tmp, "project"), registryDir = join(home, ".codex", "muster");
  const lockPath = join(registryDir, "install-scopes.json.lock"), absent = async () => { throw new Error("not found"); };
  await mkdir(registryDir, { recursive: true });
  const old = new Date(Date.now() - 10 * 60 * 1000);
  await writeFile(lockPath, JSON.stringify({ format: 1, owner: "muster", pid: 2_147_483_647, token: "stale", createdAt: old.getTime() }) + "\n");
  await utimes(lockPath, old, old);
  await runCodexInstall({ cwd, home, repoRoot, execFile: absent });
  await assert.rejects(() => readFile(lockPath, "utf8"));

  const unsafeCwd = join(tmp, "unsafe-project");
  await writeFile(lockPath, "not-json\n");
  await assert.rejects(() => runCodexInstall({ cwd: unsafeCwd, home, repoRoot, execFile: absent }), /lock.*invalid|invalid.*lock/i);
  await assert.rejects(() => lstat(join(unsafeCwd, ".codex")));
  await assert.rejects(() => readFile(join(unsafeCwd, ".codex", "agents", ".muster-managed.json"), "utf8"));
});

test("Codex managed-scope stale-lock reclaim never deletes a replacement owner", async t => {
  const tmp = await mkdtemp(join(tmpdir(), "muster-codex-registry-lock-race-"));
  t.after(() => rm(tmp, { recursive: true, force: true }));
  const home = join(tmp, "home"), cwd = join(tmp, "project"), registryDir = join(home, ".codex", "muster");
  const lockPath = join(registryDir, "install-scopes.json.lock"), absent = async () => { throw new Error("not found"); };
  await mkdir(registryDir, { recursive: true });
  const old = new Date(Date.now() - 10 * 60 * 1000);
  await writeFile(lockPath, JSON.stringify({ format: 1, owner: "muster", pid: 2_147_483_647, token: "stale", createdAt: old.getTime() }) + "\n");
  await utimes(lockPath, old, old);
  const replacement = { format: 1, owner: "muster", pid: process.pid, token: "fresh-owner", createdAt: Date.now() };
  let interleaved = false;
  await assert.rejects(runCodexInstall({
    cwd, home, repoRoot, execFile: absent,
    scopeLockOptions: {
      maxAttempts: 1,
      afterQuarantine: async () => {
        interleaved = true;
        await writeFile(lockPath, JSON.stringify(replacement) + "\n", { flag: "wx" });
      }
    }
  }), /lock did not become available/);
  assert.equal(interleaved, true, "test did not interleave a replacement after quarantine");
  assert.equal(JSON.parse(await readFile(lockPath, "utf8")).token, replacement.token);
});

test("Codex final stale-lock validation binds general and managed-scope deletion before release", async t => {
  const tmp = await mkdtemp(join(tmpdir(), "muster-codex-final-lock-validation-"));
  t.after(() => rm(tmp, { recursive: true, force: true }));
  const absent = async () => { throw new Error("not found"); };
  const old = new Date(Date.now() - 10 * 60 * 1000);

  const generalLock = join(tmp, "publication.lock");
  await writeFile(generalLock, JSON.stringify({ format: 1, pid: 2_147_483_647, processIdentity: "dead", createdAt: old.getTime(), token: "stale-general" }) + "\n");
  await utimes(generalLock, old, old);
  const staleGeneralReplacement = { format: 1, pid: process.pid, processIdentity: "fresh", createdAt: Date.now(), token: "fresh-general-stale" };
  await assert.rejects(withCodexFileLock(generalLock, async () => {
    throw new Error("replacement owner was bypassed");
  }, {
    timeoutMs: 0,
    afterValidation: async ({ quarantine }) => {
      await unlink(quarantine);
      await writeFile(quarantine, JSON.stringify(staleGeneralReplacement) + "\n", { flag: "wx" });
    }
  }), /timed out waiting for Codex transaction lock/);
  assert.equal(JSON.parse(await readFile(generalLock, "utf8")).token, staleGeneralReplacement.token);

  await unlink(generalLock);
  const normalGeneralReplacement = { format: 1, pid: process.pid, processIdentity: "fresh", createdAt: Date.now(), token: "fresh-general-release" };
  await assert.rejects(withCodexFileLock(generalLock, async () => {}, {
    beforeRelease: async ({ path }) => {
      await unlink(path);
      await writeFile(path, JSON.stringify(normalGeneralReplacement) + "\n", { flag: "wx" });
    }
  }), /lock ownership changed/i);
  assert.equal(JSON.parse(await readFile(generalLock, "utf8")).token, normalGeneralReplacement.token);

  const home = join(tmp, "home"), cwd = join(tmp, "project"), registryDir = join(home, ".codex", "muster");
  const scopeLock = join(registryDir, "install-scopes.json.lock");
  await mkdir(registryDir, { recursive: true });
  await writeFile(scopeLock, JSON.stringify({ format: 1, owner: "muster", pid: 2_147_483_647, token: "stale-scope", createdAt: old.getTime() }) + "\n");
  await utimes(scopeLock, old, old);
  const staleScopeReplacement = { format: 1, owner: "muster", pid: process.pid, token: "fresh-scope-stale", createdAt: Date.now() };
  await assert.rejects(runCodexInstall({
    cwd, home, repoRoot, execFile: absent,
    scopeLockOptions: {
      maxAttempts: 1,
      afterValidation: async ({ quarantine }) => {
        await unlink(quarantine);
        await writeFile(quarantine, JSON.stringify(staleScopeReplacement) + "\n", { flag: "wx" });
      }
    }
  }), /lock did not become available/);
  assert.equal(JSON.parse(await readFile(scopeLock, "utf8")).token, staleScopeReplacement.token);

  await unlink(scopeLock);
  const normalScopeReplacement = { format: 1, owner: "muster", pid: process.pid, token: "fresh-scope-release", createdAt: Date.now() };
  await assert.rejects(runCodexInstall({
    cwd, home, repoRoot, execFile: absent,
    scopeLockOptions: {
      beforeRelease: async ({ path }) => {
        await unlink(path);
        await writeFile(path, JSON.stringify(normalScopeReplacement) + "\n", { flag: "wx" });
      }
    }
  }), /lock ownership changed/i);
  assert.equal(JSON.parse(await readFile(scopeLock, "utf8")).token, normalScopeReplacement.token);
});

test("Codex reclaims a crashed stale managed-scope recovery sentinel", async t => {
  const tmp = await mkdtemp(join(tmpdir(), "muster-codex-stale-recovery-sentinel-"));
  t.after(() => rm(tmp, { recursive: true, force: true }));
  const home = join(tmp, "home"), cwd = join(tmp, "project"), registryDir = join(home, ".codex", "muster");
  const lockPath = join(registryDir, "install-scopes.json.lock"), recoveryPath = `${lockPath}.recover`;
  const absent = async () => { throw new Error("not found"); };
  await mkdir(registryDir, { recursive: true });
  const old = new Date(Date.now() - 10 * 60 * 1000);
  const stale = token => JSON.stringify({ format: 1, owner: "muster", pid: 2_147_483_647, token, createdAt: old.getTime() }) + "\n";
  await writeFile(lockPath, stale("stale-main"));
  await writeFile(recoveryPath, stale("stale-recovery"));
  await utimes(lockPath, old, old);
  await utimes(recoveryPath, old, old);
  await runCodexInstall({ cwd, home, repoRoot, execFile: absent, scopeLockOptions: { maxAttempts: 2 } });
  await assert.rejects(() => readFile(lockPath, "utf8"));
  await assert.rejects(() => readFile(recoveryPath, "utf8"));
});

test("Codex reclaims forged and long-lived live-PID recovery sentinels", async t => {
  const absent = async () => { throw new Error("not found"); };
  const recover = async (label, ageMs, processIdentity) => {
    const tmp = await mkdtemp(join(tmpdir(), `muster-codex-${label}-live-recovery-`));
    const home = join(tmp, "home"), cwd = join(tmp, "project"), registryDir = join(home, ".codex", "muster");
    const lockPath = join(registryDir, "install-scopes.json.lock"), recoveryPath = `${lockPath}.recover`;
    const old = new Date(Date.now() - ageMs);
    const record = (token, pid, identity) => JSON.stringify({ format: 1, owner: "muster", pid, processIdentity: identity, token, createdAt: old.getTime() }) + "\n";
    t.after(() => rm(tmp, { recursive: true, force: true }));
    await mkdir(registryDir, { recursive: true });
    await writeFile(lockPath, record("stale-main", 2_147_483_647, null));
    await writeFile(recoveryPath, record("live-recovery", process.pid, processIdentity));
    await utimes(lockPath, old, old);
    await utimes(recoveryPath, old, old);
    await runCodexInstall({ cwd, home, repoRoot, execFile: absent, scopeLockOptions: { maxAttempts: 2 } });
    await assert.rejects(() => readFile(lockPath, "utf8"));
    await assert.rejects(() => readFile(recoveryPath, "utf8"));
  };
  await recover("forged", 10 * 60 * 1000, "forged-process-identity");
  await recover("hard-expiry", 20 * 60 * 1000, null);
});

test("Codex retirement preserves replaced components and fails closed on weak private permissions", async t => {
  const tmp = await mkdtemp(join(tmpdir(), "muster-codex-retirement-component-"));
  const replacement = { format: 1, pid: process.pid, processIdentity: "replacement", createdAt: Date.now(), token: "replacement-owner" };
  t.after(() => rm(tmp, { recursive: true, force: true }));

  let retired;
  const lockPath = join(tmp, "general.lock");
  await assert.rejects(withCodexFileLock(lockPath, async () => {}, {
    afterRetirement: async state => {
      retired = state.path;
      await unlink(retired);
      await writeFile(retired, JSON.stringify(replacement) + "\n", { flag: "wx" });
    }
  }), /lock ownership changed/i);
  assert.equal(JSON.parse(await readFile(retired, "utf8")).token, replacement.token);

  let weakRetirement;
  const weakLock = join(tmp, "weak-permission.lock");
  await assert.rejects(withCodexFileLock(weakLock, async () => {}, {
    afterRetirement: async state => {
      weakRetirement = state.dir;
      await chmod(weakRetirement, 0o777);
    }
  }), /retirement directory/i);
  assert.equal((await lstat(weakRetirement)).mode & 0o077, 0o077);
});

test("Codex scope and hook retirement preserve replacement components", async t => {
  const tmp = await mkdtemp(join(tmpdir(), "muster-codex-retirement-surface-"));
  const absent = async () => { throw new Error("not found"); };
  const old = new Date(Date.now() - 10 * 60 * 1000);
  t.after(() => rm(tmp, { recursive: true, force: true }));

  const home = join(tmp, "home"), cwd = join(tmp, "project"), registryDir = join(home, ".codex", "muster");
  const scopeLock = join(registryDir, "install-scopes.json.lock"), scopeReplacement = { format: 1, owner: "muster", pid: process.pid, processIdentity: "replacement", token: "scope-replacement", createdAt: Date.now() };
  await mkdir(registryDir, { recursive: true });
  await writeFile(scopeLock, JSON.stringify({ format: 1, owner: "muster", pid: 2_147_483_647, token: "stale-scope", createdAt: old.getTime() }) + "\n");
  await utimes(scopeLock, old, old);
  let scopeRetired;
  await assert.rejects(runCodexInstall({
    cwd, home, repoRoot, execFile: absent,
    scopeLockOptions: {
      maxAttempts: 1,
      afterRetirement: async state => {
        if (scopeRetired) return;
        scopeRetired = state.path;
        await unlink(scopeRetired);
        await writeFile(scopeRetired, JSON.stringify(scopeReplacement) + "\n", { flag: "wx" });
      }
    }
  }), /lock did not become available/);
  assert.equal(JSON.parse(await readFile(scopeRetired, "utf8")).token, scopeReplacement.token);

  const weakHome = join(tmp, "weak-home"), weakCwd = join(tmp, "weak-project");
  let weakScopeRetirement;
  await assert.rejects(runCodexInstall({
    cwd: weakCwd, home: weakHome, repoRoot, execFile: absent,
    scopeLockOptions: {
      afterRetirement: async state => {
        weakScopeRetirement = state.dir;
        await chmod(weakScopeRetirement, 0o777);
      }
    }
  }), /retirement directory/i);
  assert.equal((await lstat(weakScopeRetirement)).mode & 0o077, 0o077);

  const componentHome = join(tmp, "component-home"), componentCwd = join(tmp, "component-project");
  let componentScopeRetired;
  const componentReplacement = { format: 1, owner: "muster", pid: process.pid, processIdentity: "replacement", token: "scope-release-replacement", createdAt: Date.now() };
  await assert.rejects(runCodexInstall({
    cwd: componentCwd, home: componentHome, repoRoot, execFile: absent,
    scopeLockOptions: {
      afterRetirement: async state => {
        componentScopeRetired = state.path;
        await unlink(componentScopeRetired);
        await writeFile(componentScopeRetired, JSON.stringify(componentReplacement) + "\n", { flag: "wx" });
      }
    }
  }), /lock ownership changed/i);
  assert.equal(JSON.parse(await readFile(componentScopeRetired, "utf8")).token, componentReplacement.token);

  const hookUrl = new URL("../codex/hooks/muster-hook.mjs", import.meta.url).href;
  const script = `
    import { chmodSync, lstatSync, readFileSync, rmSync, writeFileSync } from "node:fs";
    import { join } from "node:path";
    const hook = await import(${JSON.stringify(hookUrl)});
    const dir = process.argv[1], replacement = { format: 1, pid: process.pid, createdAt: Date.now(), token: "hook-replacement" };
    let retired = null;
    const released = hook.withShardLock(dir, ".hook-lock", () => {}, Date.now(), {
      afterRetirement: state => {
        retired = state.path;
        rmSync(retired);
        writeFileSync(retired, JSON.stringify(replacement) + "\\n", { flag: "wx" });
      }
    });
    let weakDirectory = null;
    const weakReleased = hook.withShardLock(dir, ".hook-weak-lock", () => {}, Date.now(), {
      afterRetirement: state => {
        weakDirectory = state.dir;
        chmodSync(weakDirectory, 0o777);
      }
    });
    process.stdout.write(JSON.stringify({
      released,
      token: JSON.parse(readFileSync(retired, "utf8")).token,
      weakReleased,
      weakMode: lstatSync(weakDirectory).mode & 0o077
    }));
  `;
  const stdout = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "--eval", script, tmp], { stdio: ["pipe", "pipe", "pipe"] });
    let output = "", error = "";
    child.stdout.setEncoding("utf8"); child.stdout.on("data", chunk => { output += chunk; });
    child.stderr.setEncoding("utf8"); child.stderr.on("data", chunk => { error += chunk; });
    child.on("error", reject);
    child.on("exit", code => code === 0 ? resolve(output) : reject(new Error(error || `hook retirement child exited ${code}`)));
    child.stdin.end();
  });
  assert.deepEqual(JSON.parse(stdout), { released: false, token: "hook-replacement", weakReleased: false, weakMode: 0o077 });
});

test("Codex hook stale-lock reclaim never deletes replacement capacity or cleanup owners", async t => {
  const tmp = await mkdtemp(join(tmpdir(), "muster-codex-hook-lock-race-"));
  t.after(() => rm(tmp, { recursive: true, force: true }));
  const hookUrl = new URL("../codex/hooks/muster-hook.mjs", import.meta.url).href;
  const script = `
    import { writeFileSync, readFileSync, utimesSync } from "node:fs";
    import { join } from "node:path";
    const hook = await import(${JSON.stringify(hookUrl)});
    if (typeof hook.reclaimStaleLock !== "function") throw new Error("hook lock reclaimer is not exported");
    const dir = process.argv[1], old = Date.now() - 10 * 60 * 1000, results = [];
    for (const name of [".capacity-lock", ".cleanup-lock"]) {
      const lockPath = join(dir, name);
      writeFileSync(lockPath, JSON.stringify({ format: 1, pid: 99999999, createdAt: old, token: "stale" }) + "\\n");
      utimesSync(lockPath, new Date(old), new Date(old));
      const replacement = { format: 1, pid: process.pid, createdAt: Date.now(), token: \`fresh-\${name}\` };
      const reclaimed = hook.reclaimStaleLock(lockPath, Date.now(), {
        afterQuarantine: () => writeFileSync(lockPath, JSON.stringify(replacement) + "\\n", { flag: "wx" })
      });
      results.push({ reclaimed, token: JSON.parse(readFileSync(lockPath, "utf8")).token, expected: replacement.token });
    }
    process.stdout.write(JSON.stringify(results));
  `;
  const stdout = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "--eval", script, tmp], { stdio: ["pipe", "pipe", "pipe"] });
    let output = "", error = "";
    child.stdout.setEncoding("utf8"); child.stdout.on("data", chunk => { output += chunk; });
    child.stderr.setEncoding("utf8"); child.stderr.on("data", chunk => { error += chunk; });
    child.on("error", reject);
    child.on("exit", code => code === 0 ? resolve(output) : reject(new Error(error || `hook race child exited ${code}`)));
    child.stdin.end();
  });
  assert.deepEqual(JSON.parse(stdout), [
    { reclaimed: true, token: "fresh-.capacity-lock", expected: "fresh-.capacity-lock" },
    { reclaimed: true, token: "fresh-.cleanup-lock", expected: "fresh-.cleanup-lock" }
  ]);
});

test("Codex hook binds final stale and normal release deletion to its retirement path", async t => {
  const tmp = await mkdtemp(join(tmpdir(), "muster-codex-hook-final-lock-validation-"));
  t.after(() => rm(tmp, { recursive: true, force: true }));
  const hookUrl = new URL("../codex/hooks/muster-hook.mjs", import.meta.url).href;
  const script = `
    import { readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
    import { join } from "node:path";
    const hook = await import(${JSON.stringify(hookUrl)});
    const dir = process.argv[1], now = Date.now(), old = now - 10 * 60 * 1000;
    const stalePath = join(dir, ".stale-lock");
    writeFileSync(stalePath, JSON.stringify({ format: 1, pid: 99999999, createdAt: old, token: "stale" }) + "\\n");
    utimesSync(stalePath, new Date(old), new Date(old));
    const staleReplacement = { format: 1, pid: process.pid, createdAt: now, token: "fresh-stale" };
    const staleReclaimed = hook.reclaimStaleLock(stalePath, now, {
      afterValidation: ({ quarantine }) => {
        rmSync(quarantine);
        writeFileSync(quarantine, JSON.stringify(staleReplacement) + "\\n", { flag: "wx" });
      }
    });
    const normalPath = join(dir, ".normal-lock");
    const normalReplacement = { format: 1, pid: process.pid, createdAt: now, token: "fresh-normal" };
    const normalReleased = hook.withShardLock(dir, ".normal-lock", () => {}, now, {
      beforeRelease: ({ path }) => {
        rmSync(path);
        writeFileSync(path, JSON.stringify(normalReplacement) + "\\n", { flag: "wx" });
      }
    });
    process.stdout.write(JSON.stringify({
      staleReclaimed,
      staleToken: JSON.parse(readFileSync(stalePath, "utf8")).token,
      normalReleased,
      normalToken: JSON.parse(readFileSync(normalPath, "utf8")).token
    }));
  `;
  const stdout = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "--eval", script, tmp], { stdio: ["pipe", "pipe", "pipe"] });
    let output = "", error = "";
    child.stdout.setEncoding("utf8"); child.stdout.on("data", chunk => { output += chunk; });
    child.stderr.setEncoding("utf8"); child.stderr.on("data", chunk => { error += chunk; });
    child.on("error", reject);
    child.on("exit", code => code === 0 ? resolve(output) : reject(new Error(error || `hook final validation child exited ${code}`)));
    child.stdin.end();
  });
  assert.deepEqual(JSON.parse(stdout), {
    staleReclaimed: false,
    staleToken: "fresh-stale",
    normalReleased: false,
    normalToken: "fresh-normal"
  });
});

test("Codex ownership dry-runs never create registry locks or entries", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "muster-codex-registry-dry-run-"));
  const home = join(tmp, "home"), cwd = join(tmp, "project"), absent = async () => { throw new Error("not found"); };
  await runCodexInstall({ cwd, home, repoRoot, dryRun: true, execFile: absent });
  await assert.rejects(() => readFile(join(home, ".codex", "muster", "install-scopes.json"), "utf8"));
  await assert.rejects(() => readFile(join(home, ".codex", "muster", "install-scopes.json.lock"), "utf8"));
});

test("Codex commandWindows maps WSL drive paths to their Windows equivalent", async t => {
  const tmp = await mkdtemp(join(repoRoot, ".muster-codex-wsl-command-"));
  t.after(() => rm(tmp, { recursive: true, force: true }));
  const cwd = join(tmp, "project"), home = join(tmp, "home"), absent = async () => { throw new Error("not found"); };
  assert.match(cwd, /^\/mnt\/c\//i, "fixture must exercise a real WSL C: path");
  await runCodexInstall({ cwd, home, repoRoot, execFile: absent });
  const hooks = JSON.parse(await readFile(join(cwd, ".codex", "hooks.json"), "utf8"));
  const commandWindows = hooks.hooks.SessionStart[0].hooks[0].commandWindows;
  const expectedPath = `C:${join(cwd.slice("/mnt/c".length), ".codex", "muster", "hooks", "muster-hook.mjs").replaceAll("\\", "/")}`;
  assert.equal(commandWindows, `node "${expectedPath}"`);
});

test("Codex commandWindows treats native Windows and WSL drives alike without normalizing POSIX case", () => {
  assert.equal(formatCodexWindowsPath("C:\\Work\\Muster\\hook.mjs"), "C:/Work/Muster/hook.mjs");
  assert.equal(formatCodexWindowsPath("c:\\Work\\Muster\\hook.mjs"), "C:/Work/Muster/hook.mjs");
  assert.equal(formatCodexWindowsPath("/mnt/c/Work/Muster/hook.mjs"), "C:/Work/Muster/hook.mjs");
  assert.equal(formatCodexWindowsPath("/tmp/CaseSensitive/Muster/hook.mjs"), "/tmp/CaseSensitive/Muster/hook.mjs");
});

test("Codex install refreshes an older installed plugin version", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "muster-codex-plugin-upgrade-")), calls = [];
  const execFile = async (_bin, args) => {
    calls.push(args.join(" "));
    if (args[0] === "--version") return { stdout: "codex-cli test" };
    if (args.slice(0, 3).join(" ") === "plugin marketplace list") return { stdout: JSON.stringify({ marketplaces: [canonicalMusterMarketplace] }) };
    if (args.slice(0, 3).join(" ") === "plugin list --available") return { stdout: JSON.stringify({ installed: [{ pluginId: "muster@muster", installed: true, version: "0.4.9" }] }) };
    if (args.slice(0, 2).join(" ") === "plugin add") return { stdout: "updated" };
    throw new Error(`unexpected command: ${args.join(" ")}`);
  };
  await runCodexInstall({ cwd: join(tmp, "project"), home: join(tmp, "home"), repoRoot, execFile });
  assert.ok(calls.includes("plugin add muster@muster"));
});

test("Codex install refreshes an already-installed same-version local plugin", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "muster-codex-plugin-same-version-")), calls = [];
  const plugin = JSON.parse(await readFile(join(selectedPluginRoot, ".codex-plugin", "plugin.json"), "utf8"));
  const execFile = async (_bin, args) => {
    calls.push(args.join(" "));
    if (args[0] === "--version") return { stdout: "codex-cli test" };
    if (args.slice(0, 3).join(" ") === "plugin marketplace list") return { stdout: JSON.stringify({ marketplaces: [localMusterMarketplace] }) };
    if (args.slice(0, 3).join(" ") === "plugin list --available") return { stdout: JSON.stringify({ installed: [{ pluginId: "muster@muster", installed: true, enabled: true, version: plugin.version }] }) };
    if (args.slice(0, 2).join(" ") === "plugin add") return { stdout: "refreshed" };
    throw new Error(`unexpected command: ${args.join(" ")}`);
  };
  await runCodexInstall({ cwd: join(tmp, "project"), home: join(tmp, "home"), repoRoot, execFile });
  assert.ok(calls.includes("plugin add muster@muster"));
});

test("Codex install rejects a mutable GitHub marketplace generation", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "muster-codex-plugin-canonical-")), calls = [];
  const execFile = async (_bin, args) => {
    calls.push(args.join(" "));
    if (args[0] === "--version") return { stdout: "codex-cli test" };
    if (args.slice(0, 3).join(" ") === "plugin marketplace list") return { stdout: JSON.stringify({ marketplaces: [{ name: "muster", root: "/tmp/muster", marketplaceSource: { sourceType: "git", source: "https://github.com/Adnova-Group/muster.git" } }] }) };
    if (args.slice(0, 3).join(" ") === "plugin list --available") return { stdout: JSON.stringify({ installed: [] }) };
    if (args.slice(0, 2).join(" ") === "plugin add") return { stdout: "refreshed" };
    throw new Error(`unexpected command: ${args.join(" ")}`);
  };
  await assert.rejects(runCodexInstall({ cwd: join(tmp, "project"), home: join(tmp, "home"), repoRoot, execFile }), /marketplace conflict/i);
  assert.equal(calls.includes("plugin add muster@muster"), false);
});

test("Codex install accepts the exact local marketplace across WSL drive-path casing", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "muster-codex-plugin-local-")), calls = [];
  const localRoot = repoRoot
    .replace(/^\/mnt\/([a-z])\//i, (_match, drive) => `/mnt/${drive.toUpperCase()}/`)
    .replace(/\/users\//i, "/USERS/");
  const localMarketplace = { name: "muster", root: localRoot, marketplaceSource: { sourceType: "local", source: localRoot } };
  const execFile = async (_bin, args) => {
    calls.push(args.join(" "));
    if (args[0] === "--version") return { stdout: "codex-cli test" };
    if (args.slice(0, 3).join(" ") === "plugin marketplace list") return { stdout: JSON.stringify({ marketplaces: [localMarketplace] }) };
    if (args.slice(0, 3).join(" ") === "plugin list --available") return { stdout: JSON.stringify({ installed: [] }) };
    if (args.slice(0, 2).join(" ") === "plugin add") return { stdout: "refreshed" };
    throw new Error(`unexpected command: ${args.join(" ")}`);
  };
  await runCodexInstall({ cwd: join(tmp, "project"), home: join(tmp, "home"), repoRoot, execFile });
  assert.ok(calls.includes("plugin add muster@muster"));
});

test("Codex install rejects a case-distinct POSIX marketplace root", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "muster-codex-case-root-")), trusted = join(tmp, "development"), attacker = join(tmp, "DEVELOPMENT");
  await mkdir(trusted); await mkdir(attacker);
  await cp(join(repoRoot, ".agents"), join(trusted, ".agents"), { recursive: true });
  await cp(join(repoRoot, "codex"), join(trusted, "codex"), { recursive: true });
  const marketplace = { name: "muster", root: attacker, marketplaceSource: { sourceType: "local", source: attacker } };
  const execFile = async (_bin, args) => {
    if (args[0] === "--version") return { stdout: "codex-cli test" };
    if (args.slice(0, 3).join(" ") === "plugin marketplace list") return { stdout: JSON.stringify({ marketplaces: [marketplace] }) };
    throw new Error(`unexpected command: ${args.join(" ")}`);
  };
  await assert.rejects(runCodexInstall({ cwd: join(tmp, "project"), home: join(tmp, "home"), repoRoot: trusted, execFile }), /marketplace conflict/i);
  await assert.rejects(readFile(join(tmp, "project", ".codex", "agents", ".muster-managed.json"), "utf8"));
});

test("Codex install rejects an attacker-controlled muster marketplace without mutation", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "muster-codex-plugin-collision-"));
  const cwd = join(tmp, "project"), home = join(tmp, "home"), calls = [];
  const attackerMarketplace = {
    name: "muster",
    root: join(tmp, "attacker"),
    marketplaceSource: { sourceType: "local", source: join(tmp, "attacker") }
  };
  const execFile = async (_bin, args) => {
    calls.push(args.join(" "));
    if (args[0] === "--version") return { stdout: "codex-cli test" };
    if (args.slice(0, 3).join(" ") === "plugin marketplace list") return { stdout: JSON.stringify({ marketplaces: [attackerMarketplace] }) };
    if (args.slice(0, 3).join(" ") === "plugin list --available") return { stdout: JSON.stringify({ installed: [] }) };
    if (args.slice(0, 2).join(" ") === "plugin add") return { stdout: "hijacked" };
    throw new Error(`unexpected command: ${args.join(" ")}`);
  };
  await assert.rejects(
    () => runCodexInstall({ cwd, home, repoRoot, execFile }),
    /Codex marketplace conflict.*codex plugin marketplace remove muster/
  );
  assert.equal(calls.includes("plugin list --available --json"), false);
  assert.equal(calls.includes("plugin add muster@muster"), false);
  await assert.rejects(() => readFile(join(cwd, ".codex", "agents", ".muster-managed.json"), "utf8"));
  await assert.rejects(() => readFile(join(cwd, ".codex", "muster", ".muster-managed.json"), "utf8"));
});

test("Codex install rolls profiles and marketplace back when plugin registration fails", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "muster-codex-rollback-"));
  const cwd = join(tmp, "project"), home = join(tmp, "home"), calls = [];
  const execFile = async (_bin, args) => {
    calls.push(args.join(" "));
    if (args[0] === "--version") return { stdout: "codex-cli test" };
    if (args.slice(0, 3).join(" ") === "plugin marketplace list") return { stdout: JSON.stringify({ marketplaces: [] }) };
    if (args.slice(0, 3).join(" ") === "plugin marketplace add") return { stdout: "" };
    if (args.slice(0, 3).join(" ") === "plugin list --available") return { stdout: JSON.stringify({ installed: [], available: [] }) };
    if (args.slice(0, 2).join(" ") === "plugin add") throw new Error("registration failed");
    if (args.slice(0, 3).join(" ") === "plugin marketplace remove") return { stdout: "" };
    throw new Error(`unexpected command: ${args.join(" ")}`);
  };
  await assert.rejects(() => runCodexInstall({ cwd, home, repoRoot, execFile }), /registration failed/);
  const agents = join(cwd, ".codex", "agents");
  await assert.rejects(() => readFile(join(agents, ".muster-managed.json"), "utf8"));
  await assert.rejects(() => readFile(join(agents, "muster-builder.toml"), "utf8"));
  assert.ok(calls.includes("plugin marketplace remove muster"));
});
