import { readFile, readdir, realpath, stat } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";
import { parse as parseYaml } from "yaml";
import { CODEX_MODEL_POLICY, codexProfileForConfig } from "../src/codex.js";
import { CODEX_COUNTS } from "../src/codex-inventory.js";
import { resolveCodexPlugin } from "../src/codex-release.js";
import { parseHookCommand } from "../src/codex-install.js";

const execFileP = promisify(execFileCb);
// Any QUOTED absolute filesystem path (POSIX home/mnt/Users root, or a
// Windows drive letter) is machine-specific and must never appear in a file
// this repository tracks under .codex/ -- see the wave-3 review-gate fix for
// why (Codex requires absolute hook command paths in materialized
// hooks.json, so the install-generated files that bake one are gitignored
// instead of tracked; this pattern is the same one the acceptance grep
// runs). Matching only inside quotes (not any bare "letter:slash") avoids
// false positives on unrelated source, e.g. a `[/\\]` regex literal.
// Accepted scope decision: the quote-adjacency requirement guards quoted config values like hooks.json command fields, not a path mentioned in prose bodies.
const MACHINE_PATH_PATTERN = /(["'`])(?:\/home\/|\/mnt\/[a-z]\/|\/Users\/|[a-zA-Z]:[\\/])[^"'`]*\1/i;
const root = fileURLToPath(new URL("../", import.meta.url));
const selected = await resolveCodexPlugin(root);
const plugin = selected.pluginRoot;
const profilesRoot = selected.profilesRoot;
const fail = (message) => { throw new Error(`Codex validation: ${message}`); };
const dirs = async (path) => (await readdir(path, { withFileTypes: true })).filter(x => x.isDirectory()).map(x => x.name);
const files = async (path) => (await readdir(path, { withFileTypes: true })).filter(x => x.isFile()).map(x => x.name);
const json = async (path) => JSON.parse(await readFile(path, "utf8"));

const [pkg, marketplace, manifest, mapping, upstreams, assetManifest] = await Promise.all([
  json(join(root, "package.json")), json(join(root, ".agents/plugins/marketplace.json")), json(join(plugin, ".codex-plugin/plugin.json")), json(join(root, "catalog/agents.manifest.json")), json(join(root, "codex/upstreams.json")), json(join(root, "codex/skill-assets/manifest.json"))
]);
const codexMarketplaceEntry = marketplace.plugins?.find(plugin => plugin?.name === "muster");
if (marketplace.name !== "muster" || codexMarketplaceEntry?.source?.path !== "./.agents/plugins/plugin") {
  fail("marketplace does not point at the generated Muster plugin");
}
if (manifest.name !== "muster" || manifest.version !== pkg.version) fail("plugin manifest version is not package version");
if (manifest.version !== selected.packageVersion) fail("resolved Codex plugin package version does not match package.json");
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
  if (!CODEX_MODEL_POLICY.tiers[config.tier]) fail(`${id} has an unknown model tier`);
  // Kept in exact parity with src/codex-release.js's profileToml effort
  // accept-list -- see test/codex-check.test.js's parity test, which parses both
  // source literals and fails if they ever diverge. This list governs per-agent
  // SEMANTIC effort overrides (workhorse|judgment|peak), not the native reasoning
  // efforts a tier default resolves to.
  if (config.effort !== undefined && !["workhorse", "judgment", "peak"].includes(config.effort)) fail(`${id} has an invalid effort override`);
  // Fail loud on a half-migrated entry: a leftover concrete model/reasoning key
  // would be silently ignored by the neutral resolver.
  if (config.model !== undefined || config.reasoning !== undefined) fail(`${id} has a legacy model/reasoning key; the neutral shape uses { tier, effort? } only`);
  if (config.readOnly !== undefined && typeof config.readOnly !== "boolean") fail(`${id} has an invalid read/write policy`);
  const name = `${id}.toml`;
  if (!profiles.includes(name)) fail(`missing generated profile ${name}`);
  const text = await readFile(join(profilesRoot, name), "utf8");
  if (!/^name\s*=/m.test(text) || !/^description\s*=/m.test(text) || !/^developer_instructions\s*=/m.test(text)) fail(`${name} is not a custom-agent profile`);
  const { model, effort } = codexProfileForConfig(config);
  if (!text.includes(`model = ${JSON.stringify(model)}`) || !text.includes(`model_reasoning_effort = ${JSON.stringify(effort)}`)) fail(`${name} does not match its model policy`);
  if (!text.includes(`sandbox_mode = ${JSON.stringify(config.readOnly ? "read-only" : "workspace-write")}`)) fail(`${name} does not match its read/write policy`);
}
const skills = new Set(await dirs(join(plugin, "skills")));
const internalSkills = new Set(await dirs(join(plugin, "internal-skills")));
const modes = ["muster", "muster-plan", "muster-go", "muster-plan-backlog", "muster-go-backlog", "muster-diagnose", "muster-audit", "muster-runner", "muster-capture", "muster-init", "muster-design"];
const aliases = ["run", "autopilot", "sprint"];
for (const name of [...modes, ...aliases]) if (!skills.has(name)) fail(`missing mode skill ${name}`);
const native = await dirs(join(root, "plugin/skills"));
const builtins = await dirs(join(root, "plugin/builtins"));
const codexSkillId = name => name.startsWith("gsd-") ? `muster-${name}` : name;
for (const name of [...native, ...builtins].map(codexSkillId)) if (!internalSkills.has(name)) fail(`missing internal workflow ${name}`);
const ported = new Set([...native, ...builtins].map(codexSkillId));
const allowedSkillKeys = new Set(["name", "description", "license", "allowed-tools", "metadata"]);
for (const name of internalSkills) {
  const text = await readFile(join(plugin, "internal-skills", name, "SKILL.md"), "utf8");
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
    await stat(join(plugin, "internal-skills", name, ref)).catch(() => fail(`${name} references missing bundled asset ${ref}`));
  }
  if (/@~\/\.claude|\$HOME\/\.claude|npx\s+-y\s+@opengsd/.test(text)) fail(`${name} retains an external Claude/GSD runtime dependency`);
  if (/plugin\/(?:hooks|commands|skills)\//.test(text)) fail(`${name} retains a source-tree-only plugin path`);
  if (/skills\/brainstorming\/visual-companion\.md/.test(text)) fail(`${name} retains an old public-surface asset path`);
}
for (const name of await files(join(plugin, "commands"))) {
  if (!name.endsWith(".md")) continue;
  const text = await readFile(join(plugin, "commands", name), "utf8");
  if (text.includes("npx -y @adnova-group/muster")) fail(`${name} contacts npm instead of using the bundled CLI`);
  if (/\/muster:(?:plan|go|plan-backlog|go-backlog|run|autopilot|sprint|diagnose|audit|runner|capture|init)\b/.test(text)) fail(`${name} retains a Claude-only command invocation`);
  if (/\$muster-planner|Claude Code Routine|claude -p|plugin\/(?:hooks|commands|skills)\//.test(text)) fail(`${name} retains an invalid Codex command or source-tree path`);
}
const initCommand = await readFile(join(plugin, "commands", "init.md"), "utf8");
for (const [label, pattern] of [
  ["HUMAN-HOLD", /HUMAN-HOLD/],
  ["handoff transition", /--to handoff/],
  ["artifact-delta evidence", /--to completed --evidence artifact-delta/],
  ["preexisting evidence", /--to completed --evidence preexisting-confirmed/],
  ["call-result evidence", /--to completed --evidence call-result --evidence-file/],
  ["invocation is not completion", /A request, suggestion, command invocation, refusal to\s+overwrite, or mere artifact existence is not completion/],
  ["completed receipt state", /nativeInit\.state: "completed"/],
  ["unavailable is not completion", /never as native\s+initialization completed/]
]) {
  if (!pattern.test(initCommand)) fail(`init.md is missing native-completion guard: ${label}`);
}
for (const name of ["plan.md", "go.md", "plan-backlog.md", "go-backlog.md", "runner.md"]) {
  const text = await readFile(join(plugin, "commands", name), "utf8");
  if (text.includes(" assess ") && !text.includes(" assess --codex ")) fail(`${name} does not use Codex-aware outcome assessment`);
}
for (const name of ["plan.md", "go.md", "plan-backlog.md"]) {
  const text = await readFile(join(plugin, "commands", name), "utf8");
  if (!text.includes("capabilities --codex --roles-only")) fail(`${name} emits the full Codex skill inventory during routing`);
}
const runnerCommand = await readFile(join(plugin, "commands", "runner.md"), "utf8");
if (!runnerCommand.includes("Usage: $muster-runner") || !runnerCommand.includes('codex exec "$muster-runner')) fail("runner command is not bound to the Codex runner skill");
const coordination = await readFile(join(plugin, "internal-skills", "coordination", "SKILL.md"), "utf8");
if (!coordination.includes("plugin cache is not a Git checkout") || /git log -1 --format/.test(coordination)) fail("coordination preflight is not package-cache safe");
const orchestrator = await readFile(join(plugin, "internal-skills", "orchestrator", "SKILL.md"), "utf8");
if (/generic-subagent fallback|isolation: "worktree"|hook-enforced -- these BLOCK|permissionDecision/.test(orchestrator)) fail("orchestrator overclaims Codex dispatch or hook enforcement");
for (const marker of ["implementer leaf agent", "minimal dispatch packet", "Never attach unrelated plan items", "Workers are leaves and must not spawn descendants"]) {
  if (!orchestrator.includes(marker)) fail(`orchestrator lacks compact leaf-worker marker ${marker}`);
}
const implementerPrompt = await readFile(join(plugin, "internal-skills", "sp-subagents", "implementer-prompt.md"), "utf8");
if (!implementerPrompt.includes("the parent runs the broad suite once at final verification") || implementerPrompt.includes("full suite once before committing")) fail("Codex implementer prompt repeats broad suites inside workers");
const reviewGate = await readFile(join(plugin, "internal-skills", "review-gate", "SKILL.md"), "utf8");
for (const marker of ["capabilities --codex --role <role>", "never attach the full skills inventory", "Select one code reviewer for ordinary waves", "Add the security reviewer only", "3 no-progress fix-and-re-review iterations", "12 total iterations", "strictly increasing score earns another pass", "absent, or non-finite scores exhaust the budget", "progress never bypasses the absolute ceiling"]) {
  if (!reviewGate.includes(marker)) fail(`Codex review gate lacks quota policy marker ${marker}`);
}
// structured-output-binding item: the single-sourced verdict schema must ship with the
// Codex plugin (rmAndCopy already carries it alongside SKILL.md -- this asserts that stays
// true) and the ported prose's plugin-path translation must have resolved to the bundled
// copy, not left a source-tree-only `plugin/skills/` path behind.
await stat(join(plugin, "internal-skills", "review-gate", "verdict.schema.json")).catch(() => fail("missing bundled review-gate verdict schema"));
if (!reviewGate.includes("${PLUGIN_ROOT}/internal-skills/review-gate/verdict.schema.json")) fail("Codex review gate does not cite the bundled verdict schema path");
const auditCommand = await readFile(join(plugin, "commands", "audit.md"), "utf8");
for (const marker of ["Quota-bounded dimension sweep", "three nonredundant read-only briefs", "system quality", "Respect `agents.max_concurrent_threads_per_session`", "codex-audit-provider --role <role>", "full manifest-ordered independent-agent chain", "CODEX_AUDIT_NO_COMPATIBLE_PROVIDER", "dispatch ONLY its returned packet"]) {
  if (!auditCommand.includes(marker)) fail(`Codex audit lacks quota policy marker ${marker}`);
}
if (auditCommand.includes("requested=6") || auditCommand.includes("six core dimensions remain independent")) fail("Codex audit retains redundant six-worker fan-out");
// State-based agent watch: provider-reported running is authoritative liveness, fixed
// silent-heartbeat counts cannot kill it, and every generated orchestration surface carries
// the same deterministic handling for non-running states and explicit stop conditions.
const watchSurfaces = [
  ["adapter", join(plugin, "runtime", "codex-skill-adapter.md")],
  ["orchestrator", join(plugin, "internal-skills", "orchestrator", "SKILL.md")],
  ...[...modes, ...aliases].map(name => [name, join(plugin, "skills", name, "SKILL.md")])
];
if (watchSurfaces.length !== 16) fail(`agent watch coverage drifted to ${watchSurfaces.length} surfaces instead of 16`);
const assertWatchPattern = (text, name, pattern, label) => {
  if (!pattern.test(text)) fail(`${name} ${label}`);
};
for (const [name, path] of watchSurfaces) {
  const text = await readFile(path, "utf8");
  assertWatchPattern(text, name, /collaboration\.list_agents/, "does not reconcile worker state");
  assertWatchPattern(text, name, /collaboration\.wait_agent/, "does not wait for worker updates");
  assertWatchPattern(text, name, /mailbox receipts first/, "does not process receipts before reconciliation");
  assertWatchPattern(text, name, /mailbox receipts first[\s\S]{0,80}call `collaboration\.list_agents` exactly once/i, "does not require exactly one reconciliation after each wake");
  assertWatchPattern(text, name, /running/, "does not identify an actively-running worker");
  assertWatchPattern(text, name, /actively? in (?:a )?turn/, "does not inspect whether a worker is actively in a turn");
  assertWatchPattern(text, name, /authoritative positive liveness/, "does not treat running as authoritative positive liveness");
  assertWatchPattern(text, name, /must not be interrupted solely because any fixed silent-heartbeat count elapsed/i, "can kill running work on a fixed heartbeat count");
  assertWatchPattern(text, name, /each heartbeat[\s\S]{0,160}reconcil(?:e|iation)/i, "does not reconcile state on every heartbeat");
  for (const status of ["idle", "failed", "completed", "unreachable"]) {
    assertWatchPattern(text, name, new RegExp(`\\b${status}\\b`), `does not handle ${status} workers`);
  }
  assertWatchPattern(text, name, /non-running[\s\S]{0,220}(?:exhaust|handle)/i, "does not deterministically exhaust or handle non-running workers");
  assertWatchPattern(text, name, /explicit (?:user )?cancellation/i, "does not preserve explicit user cancellation");
  assertWatchPattern(text, name, /explicit task step violation/i, "does not stop explicit task step violations");
  assertWatchPattern(text, name, /explicit task budget violation/i, "does not stop explicit task budget violations");
  assertWatchPattern(text, name, /long-running active work/i, "does not name long-running active work");
  assertWatchPattern(text, name, /periodic advisory progress/i, "does not surface periodic advisory progress");
  assertWatchPattern(text, name, /advisory escalation[\s\S]{0,80}without killing or interrupting/i, "does not escalate advisory status without killing active work");
  if (/\b(?:6|10|14) consecutive silent heartbeats\b/i.test(text)) fail(`${name} retains fixed 6/10/14-heartbeat ceilings`);
  if (/\bhard ceiling\b/i.test(text)) fail(`${name} retains hard heartbeat-ceiling language`);
  if (/(?:Three|three) consecutive heartbeats|live after three(?: 60-second)? heartbeats/i.test(text)) fail(`${name} retains generic live-after-three interruption language`);
  if (text.indexOf("collaboration.wait_agent") > text.indexOf("collaboration.list_agents")) fail(`${name} polls agent state before its first event-driven wait`);
  if (text.indexOf("mailbox receipts first") > text.indexOf("collaboration.list_agents")) fail(`${name} reconciles before processing its wake receipt`);
}
if (native.length !== CODEX_COUNTS.nativeSkills || builtins.length !== CODEX_COUNTS.builtinSkills) fail("source skill count drift");
if (skills.size !== CODEX_COUNTS.publicSkills || internalSkills.size !== CODEX_COUNTS.internalSkills) fail("Codex public/internal skill surface count drift");
if ((await readdir(join(root, "pipelines"))).filter(n => n.endsWith(".yaml")).length !== CODEX_COUNTS.pipelines) fail("pipeline count drift");
for (const file of ["runtime/muster.mjs", "runtime/muster-mcp.mjs", "runtime/codex-skill-adapter.md", "runtime/resolve-skill-provider.mjs", "runtime/internal-asset-loader.mjs", "runtime/internal-assets.json", "package.json", ".mcp.json", "internal-skills"]) await stat(join(plugin, file)).catch(() => fail(`missing ${file}`));
const adapter = await readFile(join(plugin, "runtime", "codex-skill-adapter.md"), "utf8");
if (!adapter.includes("resolve-skill-provider.mjs <chosen.source> <chosen.id>") || adapter.includes("read `${PLUGIN_ROOT}/internal-skills/${chosen.id}")) fail("adapter bypasses the verified provider resolver");
const providerResolver = await readFile(join(plugin, "runtime", "resolve-skill-provider.mjs"), "utf8");
if (!providerResolver.includes('new Set(["builtin", "installed"])') || !providerResolver.includes("already-enabled Codex skill explicitly")) fail("provider resolver does not validate provenance and preserve installed skill invocation");
const internalLoader = await readFile(join(plugin, "runtime", "internal-asset-loader.mjs"), "utf8");
if (internalLoader.includes("__MUSTER_INTERNAL_METADATA_DIGEST__") || !internalLoader.includes("O_NOFOLLOW") || !internalLoader.includes("internal asset changed after packaging")) fail("internal asset loader is not bound to point-of-use integrity checks");
await stat(join(plugin, "hooks")).then(() => fail("generated plugin must not contain auto-discovered hooks"), () => {});
const hooks = await json(join(root, "codex/hooks/hooks.json"));
for (const event of ["SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "SubagentStart", "SubagentStop", "Stop"]) {
  if (!Array.isArray(hooks.hooks?.[event]) || hooks.hooks[event].length === 0) fail(`missing Codex ${event} hook`);
}
const hookSource = await readFile(join(root, "codex/hooks/muster-hook.mjs"), "utf8");
if (/permissionDecision|permissionDecisionReason/.test(hookSource)) fail("Codex hook must not claim unsupported PreToolUse denial");
const trackedHook = await readFile(join(root, ".codex/muster/hooks/muster-hook.mjs"), "utf8");
if (trackedHook !== hookSource) fail("tracked project Codex hook runtime is stale");

// `.codex/hooks.json` and `.codex/muster/.muster-managed.json` are
// install-generated and gitignored (see CHANGELOG), not tracked -- Codex
// requires absolute hook command paths in materialized hooks.json, so a
// tracked copy would bake one clone's absolute path into every other
// clone. When present (post `muster install codex --scope project`),
// coherence-check it against THIS checkout instead of trusting it; when
// absent (fresh clone, pre-install) skip cleanly with a note.
const notes = [];
const hooksConfigPath = join(root, ".codex", "hooks.json");
const hooksConfigPresent = await stat(hooksConfigPath).then(() => true, () => false);
if (hooksConfigPresent) {
  const trackedHookConfig = JSON.parse(await readFile(hooksConfigPath, "utf8"));
  const commands = Object.values(trackedHookConfig.hooks || {}).flat()
    .flatMap(group => group?.hooks || [])
    .map(hook => hook?.command)
    .filter(Boolean);
  if (!commands.length) fail(".codex/hooks.json is present but declares no hook commands");
  const repoRootResolved = resolve(root);
  for (const command of commands) {
    const parsed = parseHookCommand(command);
    if (!parsed) fail(`.codex/hooks.json hook command has an unexpected shape: ${command}`);
    const { interpreter, script } = parsed;
    // Security (run-5 audit Med #5): the interpreter must be an absolute, pinned
    // Node path, never bare `node` (PATH-hijackable at every hook event).
    if (!/^(?:\/|[a-zA-Z]:[\\/])/.test(interpreter)) fail(`.codex/hooks.json hook interpreter must be an absolute pinned Node path, not bare node: ${command}`);
    if (!script.startsWith(`${repoRootResolved}${sep}`)) fail(`.codex/hooks.json points outside this checkout (stale install from another machine?): ${script}`);
    await stat(script).catch(() => fail(`.codex/hooks.json references a hook runtime missing from this checkout: ${script}`));
  }
} else {
  notes.push(".codex/hooks.json is absent (fresh clone before `muster install codex --scope project`); hook coherence check skipped");
}

// Widened tracked-file guard: after untracking hooks.json/.muster-managed.json,
// every file still tracked under .codex/ (the generated agent profile TOMLs
// and their file-list/version manifest) must carry zero machine-specific
// absolute paths -- catches any future accidental re-introduction.
const trackedCodexFiles = (await execFileP("git", ["ls-files", ".codex"], { cwd: root })).stdout
  .split("\n").map(line => line.trim()).filter(Boolean);
for (const relativePath of trackedCodexFiles) {
  const text = await readFile(join(root, relativePath), "utf8");
  if (MACHINE_PATH_PATTERN.test(text)) fail(`tracked ${relativePath} contains a machine-specific absolute path`);
}

const mcp = await json(join(plugin, ".mcp.json"));
const canonicalNode = await realpath(process.execPath);
if (mcp.mcpServers?.muster?.command !== canonicalNode || mcp.mcpServers?.muster?.args?.[0] !== "./runtime/muster-mcp.mjs") fail("MCP configuration is not pinned to the canonical Codex host Node executable");
const bundledMcp = await readFile(join(plugin, "runtime", "muster-mcp.mjs"), "utf8");
if (!bundledMcp.includes('runtimeIdentity: "codex"') || !bundledMcp.includes('"capabilities", "--codex"')) fail("MCP capability tool is not bound to live Codex inventory");
if (bundledMcp.includes("MUSTER_MCP_HOST")) fail("MCP runtime must use the explicit adapter contract, not the retired environment host selector");
if (!bundledMcp.includes('"assess", "--codex"')) fail("MCP assess tool is not bound to Codex-aware criteria parsing");
const mcpSource = await readFile(join(root, "mcp", "server.mjs"), "utf8");
if ((mcpSource.match(/^  muster_[a-z_]+:/gm) || []).length !== CODEX_COUNTS.mcpTools) fail("MCP tool count drift");
if (modes.length - 1 !== CODEX_COUNTS.primaryModes || aliases.length !== CODEX_COUNTS.aliases) fail("mode count drift");
process.stdout.write(JSON.stringify({ ok: true, counts: CODEX_COUNTS, notes }, null, 2) + "\n");
