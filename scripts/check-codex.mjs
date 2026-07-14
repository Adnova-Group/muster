import { readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import { CODEX_COUNTS, CODEX_MODEL_POLICY } from "../src/codex.js";
import { resolveCodexRelease } from "../src/codex-release.js";

const root = fileURLToPath(new URL("../", import.meta.url));
const selected = await resolveCodexRelease(root);
const plugin = selected.pluginRoot;
const profilesRoot = selected.profilesRoot;
const fail = (message) => { throw new Error(`Codex validation: ${message}`); };
const dirs = async (path) => (await readdir(path, { withFileTypes: true })).filter(x => x.isDirectory()).map(x => x.name);
const files = async (path) => (await readdir(path, { withFileTypes: true })).filter(x => x.isFile()).map(x => x.name);
const json = async (path) => JSON.parse(await readFile(path, "utf8"));

const [pkg, marketplace, manifest, mapping, upstreams, assetManifest] = await Promise.all([
  json(join(root, "package.json")), json(join(root, ".agents/plugins/marketplace.json")), json(join(plugin, ".codex-plugin/plugin.json")), json(join(root, "codex/agents.manifest.json")), json(join(root, "codex/upstreams.json")), json(join(root, "codex/skill-assets/manifest.json"))
]);
if (marketplace.name !== "muster" || marketplace.plugins?.[0]?.name !== "muster"
  || marketplace.plugins[0].source?.path !== "./.agents/plugins/bootstrap/muster"
  || !/^[a-f0-9]{64}$/.test(marketplace.musterBootstrap?.digest || "")
  || !/^[a-f0-9]{64}$/.test(marketplace.musterBootstrap?.initialGeneration || "")) fail("marketplace does not expose the immutable Muster bootstrap contract");
const selectionNames = (await readdir(join(root, ".agents", "plugins", "selections"))).filter(name => /^\d{12}-[a-f0-9]{64}\.json$/.test(name));
let selectedContract = false;
for (const name of selectionNames) {
  const record = await json(join(root, ".agents", "plugins", "selections", name));
  if (record.generation === selected.generation && record.bootstrapDigest === marketplace.musterBootstrap.digest) selectedContract = true;
  if (record.bootstrapDigest !== marketplace.musterBootstrap.digest) fail(`selection ${name} does not match the immutable bootstrap digest`);
}
if (!selectedContract) fail("selected release lacks a direct selector coherent with the marketplace/bootstrap digest");
if (manifest.name !== "muster" || manifest.version !== pkg.version) fail("plugin manifest version is not package version");
if (!manifest.skills || !manifest.mcpServers || manifest.hooks !== undefined) fail("plugin manifest must expose skills and MCP without advertising inert plugin-bundled hooks");
if (Object.keys(mapping.agents || {}).length !== CODEX_COUNTS.agents) fail("mapping does not contain all agent profiles");
for (const family of ["superpowers", "wshobson-agents", "gsd-core", "atomic-codex", "book-genesis-codex", "humanizer-sources", "stealthhumanizer", "promptfoo", "muster"]) {
  if (!upstreams.families?.some(item => item.id === family && item.repository && item.codex && item.musterStrategy)) fail(`missing researched Codex upstream ${family}`);
}
for (const family of ["superpowers", "wshobson-agents"]) {
  const researched = upstreams.families.find(item => item.id === family);
  const assets = assetManifest.sources?.find(item => item.id === family);
  if (!assets || assets.repository !== researched.repository || assets.ref !== researched.ref) fail(`Codex skill assets are not pinned to researched ${family}`);
}
const profiles = await files(profilesRoot);
if (profiles.filter(n => n.endsWith(".toml")).length !== CODEX_COUNTS.agents) fail("generated agent profile count is wrong");
const legacyProfiles = await files(join(root, "codex", "agents")).catch(error => {
  if (error.code === "ENOENT") return [];
  throw error;
});
if (legacyProfiles.some(name => name.endsWith(".toml"))) fail("deprecated static codex/agents profiles must not coexist with generated release profiles");
for (const [id, config] of Object.entries(mapping.agents)) {
  const expected = CODEX_MODEL_POLICY[config.tier];
  if (!expected) fail(`${id} has an unknown model tier`);
  if (config.reasoning !== undefined && !["medium", "high", "xhigh", "max"].includes(config.reasoning)) fail(`${id} has an invalid reasoning override`);
  if (config.model !== undefined && !/^gpt-5\.6-(?:luna|terra|sol)$/.test(config.model)) fail(`${id} has an invalid model override`);
  if (config.readOnly !== undefined && typeof config.readOnly !== "boolean") fail(`${id} has an invalid read/write policy`);
  const name = `${id}.toml`;
  if (!profiles.includes(name)) fail(`missing generated profile ${name}`);
  const text = await readFile(join(profilesRoot, name), "utf8");
  if (!/^name\s*=/m.test(text) || !/^description\s*=/m.test(text) || !/^developer_instructions\s*=/m.test(text)) fail(`${name} is not a custom-agent profile`);
  const reasoning = config.reasoning ?? expected.reasoning;
  const model = config.model ?? expected.model;
  if (!text.includes(`model = ${JSON.stringify(model)}`) || !text.includes(`model_reasoning_effort = ${JSON.stringify(reasoning)}`)) fail(`${name} does not match its model policy`);
  if (!text.includes(`sandbox_mode = ${JSON.stringify(config.readOnly ? "read-only" : "workspace-write")}`)) fail(`${name} does not match its read/write policy`);
}
const skills = new Set(await dirs(join(plugin, "skills")));
const bootstrap = join(root, ".agents", "plugins", "bootstrap", "muster");
const bootstrapSkills = new Set(await dirs(join(bootstrap, "skills")));
if (bootstrapSkills.size !== skills.size || [...skills].some(name => !bootstrapSkills.has(name))) fail("immutable bootstrap skill surface differs from the selected release");
for (const file of ["runtime/resolve-release.mjs", "runtime/muster.mjs", "runtime/muster-mcp.mjs", "bootstrap.json"]) await stat(join(bootstrap, file)).catch(() => fail(`missing bootstrap ${file}`));
const modes = ["muster", "muster-plan", "muster-go", "muster-plan-backlog", "muster-go-backlog", "muster-diagnose", "muster-audit", "muster-runner", "muster-capture"];
const aliases = ["run", "autopilot", "sprint"];
for (const name of [...modes, ...aliases]) if (!skills.has(name)) fail(`missing mode skill ${name}`);
const native = await dirs(join(root, "plugin/skills"));
const builtins = await dirs(join(root, "plugin/builtins"));
const codexSkillId = name => name.startsWith("gsd-") ? `muster-${name}` : name;
for (const name of [...native, ...builtins].map(codexSkillId)) if (!skills.has(name)) fail(`missing ported skill ${name}`);
const ported = new Set([...native, ...builtins].map(codexSkillId));
const allowedSkillKeys = new Set(["name", "description", "license", "allowed-tools", "metadata"]);
for (const name of skills) {
  const text = await readFile(join(plugin, "skills", name, "SKILL.md"), "utf8");
  const frontmatter = text.match(/^---\r?\n([\s\S]*?)\r?\n---/)?.[1];
  if (!frontmatter) fail(`${name} is missing skill frontmatter`);
  let data;
  try { data = parseYaml(frontmatter); } catch (error) { fail(`${name} has invalid skill frontmatter: ${error.message}`); }
  if (typeof data?.name !== "string" || !data.name.trim() || typeof data.description !== "string" || !data.description.trim()) fail(`${name} has invalid skill identity metadata`);
  if (data.name !== name) fail(`${name} frontmatter name must match its directory`);
  for (const key of Object.keys(data)) if (!allowedSkillKeys.has(key)) fail(`${name} has unsupported frontmatter key ${key}`);
  if (ported.has(name)) {
    if (!data.description.startsWith("Codex-compatible Muster workflow.")) fail(`${name} lacks Codex routing metadata`);
    if (!text.includes("runtime/codex-skill-adapter.md")) fail(`${name} lacks the Codex harness binding`);
    if (/AskUserQuestion|\/muster:|Claude Code Agent tool|\bAgent tool|\bTask tool/.test(text)) fail(`${name} retains an untranslated Claude harness instruction`);
  }
  for (const ref of new Set(text.match(/(?:references)\/[A-Za-z0-9_.\/-]+\.md/g) || [])) {
    await stat(join(plugin, "skills", name, ref)).catch(() => fail(`${name} references missing bundled asset ${ref}`));
  }
  if (/@~\/\.claude|\$HOME\/\.claude|npx\s+-y\s+@opengsd/.test(text)) fail(`${name} retains an external Claude/GSD runtime dependency`);
  if (/plugin\/(?:hooks|commands|skills)\//.test(text)) fail(`${name} retains a source-tree-only plugin path`);
}
for (const name of await files(join(plugin, "commands"))) {
  if (!name.endsWith(".md")) continue;
  const text = await readFile(join(plugin, "commands", name), "utf8");
  if (text.includes("npx -y @adnova-group/muster")) fail(`${name} contacts npm instead of using the bundled CLI`);
  if (/\/muster:(?:plan|go|plan-backlog|go-backlog|run|autopilot|sprint|diagnose|audit|runner|capture)\b/.test(text)) fail(`${name} retains a Claude-only command invocation`);
  if (/\$muster-planner|Claude Code Routine|claude -p|plugin\/(?:hooks|commands|skills)\//.test(text)) fail(`${name} retains an invalid Codex command or source-tree path`);
}
for (const name of ["plan.md", "go.md", "plan-backlog.md", "go-backlog.md", "runner.md"]) {
  const text = await readFile(join(plugin, "commands", name), "utf8");
  if (text.includes(" assess ") && !text.includes(" assess --codex ")) fail(`${name} does not use Codex-aware outcome assessment`);
}
const runnerCommand = await readFile(join(plugin, "commands", "runner.md"), "utf8");
if (!runnerCommand.includes("Usage: $muster-runner") || !runnerCommand.includes('codex exec "$muster-runner')) fail("runner command is not bound to the Codex runner skill");
const coordination = await readFile(join(plugin, "skills", "coordination", "SKILL.md"), "utf8");
if (!coordination.includes("plugin cache is not a Git checkout") || /git log -1 --format/.test(coordination)) fail("coordination preflight is not package-cache safe");
const orchestrator = await readFile(join(plugin, "skills", "orchestrator", "SKILL.md"), "utf8");
if (/generic-subagent fallback|isolation: "worktree"|hook-enforced -- these BLOCK|permissionDecision/.test(orchestrator)) fail("orchestrator overclaims Codex dispatch or hook enforcement");
const watchMarkers = ["collaboration.list_agents", "collaboration.wait_agent", "60 seconds", "message or completion receipt", "mailbox receipts first", "exactly once", "newly ready work", "timeout is only a heartbeat", "Never tight-poll", "never prompt the user", "live agents", "executable steps", "HUMAN-HOLD", "merge decision"];
for (const [name, path] of [
  ["adapter", join(plugin, "runtime", "codex-skill-adapter.md")],
  ["orchestrator", join(plugin, "skills", "orchestrator", "SKILL.md")],
  ...[...modes, ...aliases].map(name => [name, join(plugin, "skills", name, "SKILL.md")])
]) {
  const text = await readFile(path, "utf8");
  for (const marker of watchMarkers) if (!text.includes(marker)) fail(`${name} lacks agent watch invariant marker ${marker}`);
  if (text.indexOf("collaboration.wait_agent") > text.indexOf("collaboration.list_agents")) fail(`${name} polls agent state before its first event-driven wait`);
}
if (native.length !== CODEX_COUNTS.nativeSkills || builtins.length !== CODEX_COUNTS.builtinSkills) fail("source skill count drift");
if ((await readdir(join(root, "pipelines"))).filter(n => n.endsWith(".yaml")).length !== CODEX_COUNTS.pipelines) fail("pipeline count drift");
for (const file of ["runtime/muster.mjs", "runtime/muster-mcp.mjs", "runtime/codex-skill-adapter.md", "src/cli.js", "src/package.json", "package.json", ".mcp.json"]) await stat(join(plugin, file)).catch(() => fail(`missing ${file}`));
await stat(join(plugin, "hooks")).then(() => fail("generated plugin must not contain auto-discovered hooks"), () => {});
const hooks = await json(join(root, "codex/hooks/hooks.json"));
for (const event of ["SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "SubagentStart", "SubagentStop", "Stop"]) {
  if (!Array.isArray(hooks.hooks?.[event]) || hooks.hooks[event].length === 0) fail(`missing Codex ${event} hook`);
}
const hookSource = await readFile(join(root, "codex/hooks/muster-hook.mjs"), "utf8");
if (/permissionDecision|permissionDecisionReason/.test(hookSource)) fail("Codex hook must not claim unsupported PreToolUse denial");
const trackedHook = await readFile(join(root, ".codex/muster/hooks/muster-hook.mjs"), "utf8");
if (trackedHook !== hookSource) fail("tracked project Codex hook runtime is stale");
const trackedHookConfig = await readFile(join(root, ".codex/hooks.json"), "utf8");
if (/\/mnt\/[a-z]\//i.test(trackedHookConfig) || /[a-z]:[\\/]/i.test(trackedHookConfig)) fail("tracked project Codex hooks contain a checkout-specific absolute path");
const mcp = await json(join(plugin, ".mcp.json"));
if (mcp.mcpServers?.muster?.command !== "node" || mcp.mcpServers?.muster?.args?.[0] !== "./runtime/muster-mcp.mjs") fail("MCP configuration is not Codex-native");
const bundledMcp = await readFile(join(plugin, "runtime", "muster-mcp.mjs"), "utf8");
if (!bundledMcp.includes('"capabilities", "--codex"') || bundledMcp.includes('"capabilities", "--cowork"')) fail("MCP capability tool is not bound to live Codex inventory");
if (!bundledMcp.includes('"assess", "--codex"')) fail("MCP assess tool is not bound to Codex-aware criteria parsing");
const mcpSource = await readFile(join(root, "cowork", "mcp-server.mjs"), "utf8");
if ((mcpSource.match(/^  muster_[a-z_]+:/gm) || []).length !== CODEX_COUNTS.mcpTools) fail("MCP tool count drift");
if (modes.length - 1 !== CODEX_COUNTS.primaryModes || aliases.length !== CODEX_COUNTS.aliases) fail("mode count drift");
process.stdout.write(JSON.stringify({ ok: true, counts: CODEX_COUNTS }, null, 2) + "\n");
