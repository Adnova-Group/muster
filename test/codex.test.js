import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile as execFileCb, spawn } from "node:child_process";
import { cp, mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { parse as parseYaml } from "yaml";
import { CODEX_COUNTS, CODEX_MODEL_POLICY, codexModelForRole, codexModelForTier } from "../src/codex.js";
import { readCodexInventory } from "../src/codex-inventory.js";
import { runCodexInstall, runCodexUninstall } from "../src/codex-install.js";
import { adaptCatalogForCodex, codexFallbackSkillId } from "../src/codex-catalog.js";

const root = new URL("../", import.meta.url);
const repoRoot = new URL("../", import.meta.url).pathname;
const response = stdout => async () => ({ stdout });
const execFile = promisify(execFileCb);
const canonicalMusterMarketplace = {
  name: "muster",
  root: "/tmp/codex-muster-marketplace",
  marketplaceSource: { sourceType: "git", source: "https://github.com/Adnova-Group/muster.git" }
};
const localMusterMarketplace = {
  name: "muster",
  root: repoRoot,
  marketplaceSource: { sourceType: "local", source: repoRoot }
};

function packagedMcpTools() {
  return new Promise((resolve, reject) => {
    const server = spawn("node", [join(repoRoot, ".agents", "plugins", "plugins", "muster", "runtime", "muster-mcp.mjs")], {
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

function runCodexHook(payload, cwd = repoRoot, hookPath = join(repoRoot, "codex", "hooks", "muster-hook.mjs")) {
  return new Promise((resolve, reject) => {
    const child = spawn("node", [hookPath], { cwd, stdio: ["pipe", "pipe", "pipe"] });
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
    sonnet: { model: "gpt-5.6-terra", reasoning: "xhigh" },
    opus: { model: "gpt-5.6-sol", reasoning: "high" },
    fable: { model: "gpt-5.6-sol", reasoning: "max" }
  });
  assert.deepEqual(codexModelForTier("haiku"), CODEX_MODEL_POLICY.haiku);
  assert.throws(() => codexModelForTier("unknown"), /unknown Muster model tier/);
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
  const runtime = await readFile(join(repoRoot, ".agents", "plugins", "plugins", "muster", "runtime", "muster-mcp.mjs"), "utf8");
  assert.match(runtime, /"capabilities", "--codex"/);
  assert.match(runtime, /"assess", "--codex"/);
  assert.doesNotMatch(runtime, /"capabilities", "--cowork"/);
});

test("packaged Codex CLI runs without a consumer npm install", async () => {
  const runtime = join(repoRoot, ".agents", "plugins", "plugins", "muster", "runtime", "muster.mjs");
  const { stdout } = await execFile("node", [runtime, "detect", repoRoot], { cwd: repoRoot });
  const result = JSON.parse(stdout);
  assert.equal(result.vcs.isRepo, true);
});

test("Codex bundles are reproducible from symlinked dependency worktrees", async () => {
  const checkout = await mkdtemp(join(tmpdir(), "muster-codex-build-worktree-"));
  try {
    for (const path of ["package.json", "scripts", "src", "plugin", "catalog", "pipelines", "vendor", "codex", "cowork"]) {
      await cp(join(repoRoot, path), join(checkout, path), { recursive: true });
    }
    await symlink(join(repoRoot, "node_modules"), join(checkout, "node_modules"), "dir");
    await execFile("node", [join(checkout, "scripts", "build-codex.mjs")], { cwd: checkout });
    for (const relative of [
      join("runtime", "muster.mjs"),
      join("runtime", "muster-mcp.mjs"),
      join("src", "cli.js")
    ]) {
      const packaged = await readFile(join(repoRoot, ".agents", "plugins", "plugins", "muster", relative), "utf8");
      const rebuilt = await readFile(join(checkout, ".agents", "plugins", "plugins", "muster", relative), "utf8");
      assert.equal(rebuilt, packaged, `${relative} must be byte-identical across checkout roots`);
    }
  } finally {
    await rm(checkout, { recursive: true, force: true });
  }
});

test("packaged Codex workflows use the bundled CLI and Codex-native mode names", async () => {
  const commands = join(repoRoot, ".agents", "plugins", "plugins", "muster", "commands");
  for (const entry of await readdir(commands, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
    const text = await readFile(join(commands, entry.name), "utf8");
    assert.doesNotMatch(text, /npx -y @adnova-group\/muster/, entry.name);
    assert.doesNotMatch(text, /\/muster:(?:plan|go|plan-backlog|go-backlog|run|autopilot|sprint|diagnose|audit|runner|capture)\b/, entry.name);
  }
  const router = await readFile(join(repoRoot, ".agents", "plugins", "plugins", "muster", "skills", "router", "SKILL.md"), "utf8");
  assert.match(router, /runtime\/muster\.mjs match --codex --skills/);
  const runner = await readFile(join(commands, "runner.md"), "utf8");
  assert.match(runner, /Usage: \$muster-runner/);
  assert.match(runner, /codex exec "\$muster-runner/);
  assert.doesNotMatch(runner, /\$muster-planner|Claude Code Routine|claude -p/);
  const coordination = await readFile(join(repoRoot, ".agents", "plugins", "plugins", "muster", "skills", "coordination", "SKILL.md"), "utf8");
  assert.match(coordination, /plugin cache is not a Git checkout/);
  assert.doesNotMatch(coordination, /git log -1 --format/);
  const orchestrator = await readFile(join(repoRoot, ".agents", "plugins", "plugins", "muster", "skills", "orchestrator", "SKILL.md"), "utf8");
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
    const skillText = await readFile(join(repoRoot, ".agents", "plugins", "plugins", "muster", "skills", `muster-${command}`, "SKILL.md"), "utf8");
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
  const runtime = join(repoRoot, ".agents", "plugins", "plugins", "muster", "runtime", "muster.mjs");
  await assert.rejects(
    () => execFile("node", [runtime, "manifest", "validate", "--codex", file], { cwd: tmp, env: { ...process.env, CODEX_HOME: join(tmp, "home") } }),
    error => error.code === 2 && /definitely-not-installed/.test(error.stdout)
  );
});

test("Codex distribution installs supported lifecycle hooks without advertising inert plugin hooks", async () => {
  const plugin = join(repoRoot, ".agents", "plugins", "plugins", "muster");
  const manifest = JSON.parse(await readFile(join(plugin, ".codex-plugin", "plugin.json"), "utf8"));
  assert.equal(manifest.hooks, undefined);
  await assert.rejects(() => readFile(join(plugin, "hooks", "hooks.json"), "utf8"));
  const config = JSON.parse(await readFile(join(repoRoot, "codex", "hooks", "hooks.json"), "utf8"));
  assert.deepEqual(Object.keys(config.hooks).sort(), ["PostToolUse", "PreToolUse", "SessionStart", "Stop", "SubagentStart", "SubagentStop", "UserPromptSubmit"].sort());
  const session = await runCodexHook({ hook_event_name: "SessionStart", source: "startup", cwd: repoRoot });
  assert.match(session.hookSpecificOutput.additionalContext, /Write-capable waves must run in isolated git worktrees/);
  const subagent = await runCodexHook({ hook_event_name: "SubagentStart", agent_type: "muster-investigator", cwd: repoRoot });
  assert.match(subagent.hookSpecificOutput.additionalContext, /Remain read-only/);
  const tmp = await mkdtemp(join(tmpdir(), "muster-codex-hook-"));
  await mkdir(join(tmp, ".muster"), { recursive: true });
  await writeFile(join(tmp, ".muster", "run-active"), "test\n");
  await writeFile(join(tmp, ".muster", "forbidden-actions"), "publish\n");
  const action = await runCodexHook({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "git push origin feature" }, cwd: tmp }, tmp);
  assert.match(action.systemMessage, /action class "publish" is forbidden/);
  assert.match(action.systemMessage, /advisory/);
  const source = await readFile(join(repoRoot, "codex", "hooks", "muster-hook.mjs"), "utf8");
  assert.doesNotMatch(source, /permissionDecision|permissionDecisionReason/);
});

test("Codex fallbacks are self-contained and package referenced skill assets", async () => {
  const skills = join(repoRoot, ".agents", "plugins", "plugins", "muster", "skills");
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
  const catalog = await readFile(join(repoRoot, ".agents", "plugins", "plugins", "muster", "catalog", "builtins.muster.yaml"), "utf8");
  assert.match(catalog, /rudra496\/StealthHumanizer/);
});

test("all ported skills declare and load the Codex harness binding", async () => {
  const native = (await readdir(join(repoRoot, "plugin", "skills"), { withFileTypes: true })).filter(entry => entry.isDirectory()).map(entry => entry.name);
  const builtins = (await readdir(join(repoRoot, "plugin", "builtins"), { withFileTypes: true })).filter(entry => entry.isDirectory()).map(entry => entry.name);
  for (const name of new Set([...native, ...builtins])) {
    const id = codexFallbackSkillId(name);
    const skill = await readFile(join(repoRoot, ".agents", "plugins", "plugins", "muster", "skills", id, "SKILL.md"), "utf8");
    const frontmatter = skill.match(/^---\r?\n([\s\S]*?)\r?\n---/)?.[1] || "";
    assert.equal(parseYaml(frontmatter).name, id, id);
    assert.ok(parseYaml(frontmatter).description.startsWith("Codex-compatible Muster workflow."), id);
    assert.doesNotMatch(skill, /AskUserQuestion|\/muster:|Claude Code Agent tool|\bAgent tool|\bTask tool/, id);
    assert.match(skill, /runtime\/codex-skill-adapter\.md/, id);
  }
  assert.match(await readFile(join(repoRoot, ".agents", "plugins", "plugins", "muster", "runtime", "codex-skill-adapter.md"), "utf8"), /Treat `Agent` and `Task` calls as Codex subagent dispatch/);
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
  assert.equal(result.hooks, 7);
  const hooks = JSON.parse(await readFile(join(cwd, ".codex", "hooks.json"), "utf8"));
  assert.ok(hooks.hooks.Stop.some(group => group.hooks?.[0]?.command === "printf user-hook"));
  const installedHook = join(cwd, ".codex", "muster", "hooks", "muster-hook.mjs");
  assert.ok(hooks.hooks.SessionStart.some(group => group.hooks?.some(hook => hook.command.includes(installedHook))));
  assert.match((await runCodexHook({ hook_event_name: "SessionStart", source: "startup", cwd }, cwd, installedHook)).hookSpecificOutput.additionalContext, /Muster is installed for Codex/);
  await assert.doesNotReject(() => runCodexInstall({ cwd, home, repoRoot, execFile }));
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
  const plugin = JSON.parse(await readFile(join(repoRoot, ".agents", "plugins", "plugins", "muster", ".codex-plugin", "plugin.json"), "utf8"));
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

test("Codex install accepts the canonical GitHub marketplace provenance", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "muster-codex-plugin-canonical-")), calls = [];
  const execFile = async (_bin, args) => {
    calls.push(args.join(" "));
    if (args[0] === "--version") return { stdout: "codex-cli test" };
    if (args.slice(0, 3).join(" ") === "plugin marketplace list") return { stdout: JSON.stringify({ marketplaces: [canonicalMusterMarketplace] }) };
    if (args.slice(0, 3).join(" ") === "plugin list --available") return { stdout: JSON.stringify({ installed: [] }) };
    if (args.slice(0, 2).join(" ") === "plugin add") return { stdout: "refreshed" };
    throw new Error(`unexpected command: ${args.join(" ")}`);
  };
  await runCodexInstall({ cwd: join(tmp, "project"), home: join(tmp, "home"), repoRoot, execFile });
  assert.ok(calls.includes("plugin add muster@muster"));
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
