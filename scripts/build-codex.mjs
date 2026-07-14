import { build } from "esbuild";
import { cp, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { assertRegularFile, assertRegularTree, prepareCodexBootstrap, publishCodexRelease } from "../src/codex-release.js";

const root = fileURLToPath(new URL("../", import.meta.url));
const pluginParent = join(root, ".agents", "plugins");
let stagingRoot, plugin, runtime, profiles, modeDir, pkg, mapping;

const policy = {
  haiku: { model: "gpt-5.6-luna", reasoning: "high" },
  sonnet: { model: "gpt-5.6-terra", reasoning: "high" },
  opus: { model: "gpt-5.6-sol", reasoning: "high" },
  fable: { model: "gpt-5.6-sol", reasoning: "max" }
};

const modes = {
  "muster-plan": { command: "plan", purpose: "plan one outcome, assemble and validate a crew manifest, then stop for approval" },
  "muster-go": { command: "go", purpose: "execute one outcome through an isolated worktree, dependency waves, gates, and a final merge decision" },
  "muster-plan-backlog": { command: "plan-backlog", purpose: "plan every backlog item before any execution" },
  "muster-go-backlog": { command: "go-backlog", purpose: "clear a backlog with isolated item worktrees and review gates" },
  "muster-diagnose": { command: "diagnose", purpose: "reproduce, identify root cause, fix, and add a regression test" },
  "muster-audit": { command: "audit", purpose: "run the whole-codebase audit workflow and consolidate actionable findings" },
  "muster-runner": { command: "runner", purpose: "drive one claimed backlog item end-to-end in its own worktree" },
  "muster-capture": { command: "capture", purpose: "turn conversation decisions into an approval-gated backlog" },
  run: { command: "run", purpose: "legacy alias of muster-plan" },
  autopilot: { command: "autopilot", purpose: "legacy alias of muster-go" },
  sprint: { command: "sprint", purpose: "legacy alias of muster-go-backlog" }
};

async function ensure(dir) { await mkdir(dir, { recursive: true }); }
async function write(path, content) { await ensure(dirname(path)); await writeFile(path, content, "utf8"); }
const leaseStaleMs = Math.max(1_000, Number(process.env.MUSTER_CODEX_BUILD_LEASE_STALE_MS) || 5 * 60 * 1000);
function processAlive(pid) {
  if (!Number.isInteger(pid) || pid < 1) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code === "EPERM"; }
}
async function cleanStaleStages() {
  await ensure(pluginParent);
  for (const entry of await readdir(pluginParent, { withFileTypes: true })) {
    if (!entry.name.startsWith(".muster-build-")) continue;
    const path = join(pluginParent, entry.name), stat = await lstat(path);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`stale Codex build stage must be an ordinary directory: ${path}`);
    let lease = null;
    try {
      const leasePath = join(path, ".lease.json"), leaseStat = await lstat(leasePath);
      if (leaseStat.isSymbolicLink() || !leaseStat.isFile()) throw new Error(`Codex build lease must be a regular file: ${leasePath}`);
      lease = JSON.parse(await readFile(leasePath, "utf8"));
    } catch (error) { if (error.code !== "ENOENT") throw error; }
    const startedAt = Number(lease?.startedAt || stat.mtimeMs);
    if (Date.now() - startedAt < leaseStaleMs || processAlive(Number(lease?.pid))) continue;
    await assertRegularTree(path);
    await rm(path, { recursive: true, force: true });
  }
}
function frontmatter(text, field) {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  const line = m?.[1].match(new RegExp(`^${field}:\\s*(.+)$`, "m"));
  return line ? line[1].trim().replace(/^['"]|['"]$/g, "") : "";
}
function tomlMultiline(text) { return text.replace(/"""/g, '\\\"\\\"\\\"'); }
const codexModeNames = new Map([
  ["plan-backlog", "muster-plan-backlog"], ["go-backlog", "muster-go-backlog"],
  ["autopilot", "muster-go"], ["sprint", "muster-go-backlog"], ["run", "muster-plan"],
  ["plan", "muster-plan"], ["go", "muster-go"], ["diagnose", "muster-diagnose"],
  ["audit", "muster-audit"], ["runner", "muster-runner"], ["capture", "muster-capture"]
]);
function translateModeNames(text) {
  let result = text;
  for (const [legacy, current] of codexModeNames) {
    const escaped = legacy.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    result = result.replace(new RegExp(`/muster:${escaped}(?![a-z-])`, "g"), `$${current}`);
  }
  return result;
}
function translateCodexProse(text) {
  return text
    .replaceAll("Claude Code Routine", "Codex automation")
    .replaceAll("Claude Code CLI", "Codex CLI")
    .replaceAll("claude -p", "codex exec");
}
function translatePluginPaths(text) {
  return text
    .replaceAll("plugin/commands/", `${"${PLUGIN_ROOT}"}/commands/`)
    .replaceAll("plugin/skills/", `${"${PLUGIN_ROOT}"}/skills/`)
    .replaceAll("plugin/hooks/", `${"${PLUGIN_ROOT}"}/hooks/`);
}
function adaptCommandForCodex(text, name) {
  let result = translatePluginPaths(translateCodexProse(text))
    .replaceAll("the `PreToolUse` hook uses to scope the scale-gate", "Muster's Codex lifecycle hooks use for state diagnostics")
    .replaceAll("the whole batch counts as ONE run for the `PreToolUse` hook's scale-gate scoping", "the whole batch counts as ONE run for Muster's Codex lifecycle diagnostics")
    .replaceAll("the whole plan-backlog invocation counts as ONE run for the `PreToolUse` hook's scale-gate scoping", "the whole plan-backlog invocation counts as ONE run for Muster's Codex lifecycle diagnostics")
    .replaceAll("`SessionStart` on a fresh session clears a stale marker automatically.", "Codex hooks never delete state markers automatically; on startup, verify and clear only a marker proven stale and owned by the interrupted workflow.")
    .replace(/when the running session's registry doesn't carry that type[\s\S]*?note the degradation in STATE/, "call `collaboration.spawn_agent` with `agent_type: \"muster-runner\"`, `fork_turns: \"none\"` (or a positive bounded turn count, never `\"all\"`), and its other ordinary fields. Codex rejects a named profile combined with a full-history fork. `agent_type` is a Codex runtime extension and may be absent from the simplified displayed signature; include it anyway. Only an actual rejected tool call proves the profile unavailable. If that call rejects the type, fail the item closed with a profile-registration diagnostic and remediation to reinstall/start a new session; do not silently use a generic agent because that loses the pinned role/model policy")
    .replace(/Runner cwd is its worktree; tool calls rely on[\s\S]*?instead of blocking\./, "Runner cwd is its recorded worktree. Codex hooks provide diagnostics but do not replace the worktree path/base-SHA proof or the post-wave ownership check.")
    .replace(/capture only ever writes[\s\S]*?deliberately omitted\./i, "Capture only writes the explicitly approved `.muster/backlog.md` bookkeeping artifact and dispatches no write-capable wave, so it deliberately has no run-active lifecycle.");
  const cli = `node ${"${PLUGIN_ROOT}"}/runtime/muster.mjs`;
  if (["go.md", "diagnose.md", "audit.md"].includes(name)) {
    result = result.replaceAll(
      `${cli} manifest validate --codex`,
      `${cli} manifest validate .muster/manifest.json --codex`
    );
  }
  if (name === "diagnose.md") {
    result = result
      .replace("-> `{mode, manifest}`.", "prints `{mode, manifest}` JSON to stdout.")
      .replace("Write the manifest to `.muster/manifest.json`", "Extract the emitted `manifest` object and write that object to `.muster/manifest.json`");
  }
  if (name === "audit.md") {
    result = result
      .replace(
        "` -> Crew Manifest at `.muster/manifest.json`",
        "` prints the Crew Manifest JSON to stdout; capture that exact JSON and write it to `.muster/manifest.json`"
      )
      .replace("in parallel via the best available provider per dimension", "in capacity-bounded batches via the best available provider per dimension")
      .replace("running parallel dimension sweeps", "running capacity-batched dimension sweeps");
    const sweepStart = result.indexOf("3. **Parallel dimension sweep**");
    const boardStart = result.indexOf("Maintain a board task per dimension", sweepStart);
    if (sweepStart < 0 || boardStart < 0) throw new Error("audit dimension-sweep section not found");
    const capacitySweep = [
      "3. **Capacity-batched dimension sweep (Codex)** — The six core dimensions remain independent and READ-ONLY: architecture, tech-debt, coverage, simplification, readability, and security. Each uses the chosen provider on its role's model and returns severity (P0/P1/P2), location (file:line), problem, and suggested fix. Identical in both modes.",
      "   - **Capacity:** Codex permits four total agents in this run (this orchestrator plus at most three workers). Determine the currently available worker slots, cap the batch width at three, and never dispatch more workers than the live capacity permits.",
      "   - **Batching:** Dispatch the maximum available subset concurrently, wait at a barrier until every worker in that batch finishes, then dispatch the next subset. Repeat until all six core dimensions complete. Do not claim full six-way concurrency.",
      "   - **Receipt:** Before the first dispatch, append `CAPACITY-DEGRADED requested=6 available-worker-slots=<n> batches=<batch composition>` to STATE. Record the exact ordered dimension ids in each batch; the composition must cover every core dimension exactly once.",
      "   - **Optional prompt audit:** If the crew manifest includes `prompt-quality`, keep it READ-ONLY and place it in the same capacity-bounded batching sequence without displacing any core dimension.",
      "   - **Barrier gate:** Consolidation is forbidden until all six core dimension receipts, plus the optional prompt-quality receipt when selected, are present."
    ].join("\n");
    result = result.slice(0, sweepStart) + capacitySweep + "\n" + result.slice(boardStart);
  }
  const directives = {
    "run.md": "ANTH-XML-001, GUARD-SEP-003",
    "autopilot.md": "ANTH-XML-001, GUARD-SEP-003",
    "sprint.md": "ANTH-XML-001, GUARD-SEP-003",
    "plan-backlog.md": "ANTH-POS-001",
    "audit.md": "ANTH-POS-001",
    "runner.md": "ANTH-POS-001, GUARD-CITE-002"
  };
  if (directives[name]) result += `\n<!-- prompt-lint-disable ${directives[name]}: Codex compatibility transformation preserves the source workflow's safety directives and treats its deterministic STATE receipts as the evidence contract. -->\n`;
  const commandBinding = `\n\n## Codex harness binding\n\nRead \`${"${PLUGIN_ROOT}"}/runtime/codex-skill-adapter.md\` before following this command. Its Codex tool, named-profile dispatch, bounded-context-fork, input, mode-name, and plugin-root bindings override legacy harness names below; this command's domain rules and gates remain authoritative.\n`;
  result = result.replace(/^(---\r?\n[\s\S]*?\r?\n---)/, `$1${commandBinding}`);
  return result;
}
function adaptCoordinationForCodex(text) {
  const start = text.indexOf("## Standing-context preflight");
  const end = text.indexOf("## Binding A", start);
  if (start < 0 || end < 0) throw new Error("coordination standing-context section not found");
  const section = `## Standing-context preflight\n\nThe installed Codex plugin cache is not a Git checkout, so do not run \`git log\` against plugin paths. At the first read in a runner cycle, record the plugin version from \`${"${PLUGIN_ROOT}"}/package.json\` and a SHA-256 fingerprint over these installed behavior paths: \`skills/coordination/SKILL.md\`, \`commands/go-backlog.md\`, \`commands/go.md\`, and \`commands/runner.md\`. Compute the fingerprint with the host's available SHA-256 tool, sorting paths before hashing. Muster's Codex hooks are installed outside the plugin cache: also locate the selected managed runtime at the git root's \`.codex/muster/hooks/\` or \`$CODEX_HOME/muster/hooks/\` and fingerprint its files plus the sibling Muster ownership manifest. If neither managed hook runtime can be proven, say "I don't know whether the standing context is unchanged," leave a HUMAN-HOLD receipt, and stop.\n\nBefore a later claim or resume in the same cycle, recompute both fingerprints. Unchanged version and fingerprints proceed. Any change means the installed standing context changed or was tampered with during the cycle: leave a HUMAN-HOLD receipt naming the old/new version and hashes, preserve the claim state, and stop. A packaged plugin cannot safely classify such an in-place mutation as confined because there is no authoritative Git history in the cache. A newly started cycle reads the newly installed immutable version and managed hook runtime as its fresh baseline.\n\n`;
  return text.slice(0, start) + section + text.slice(end);
}
const agentWatchProtocol = `## Agent watch invariant\n\n<!-- prompt-lint-disable GUARD-IDK-001: Explicit terminal conditions prevent abandoned live agents while preserving approval, HUMAN-HOLD, blocker, and merge-decision stops. -->\n\nAfter every dispatch, retain every canonical agent id returned by \`collaboration.spawn_agent\` and immediately call \`collaboration.wait_agent\` with a timeout of at most 60 seconds. A message or completion receipt wakes the watch immediately. After each wake, process the mailbox receipts first, call \`collaboration.list_agents\` exactly once to reconcile live state, dispatch any newly ready work whose dependencies are satisfied, and, while any agent remains live, immediately call \`collaboration.wait_agent\` again. A timeout is only a heartbeat: reconcile once and return to waiting; it is not completion. Never tight-poll \`collaboration.list_agents\` and never prompt the user merely because workers are still running.\n\nDo not send the final answer, clear active run/wave state, or stop watching while live agents or executable steps remain. Stop only when all work is terminal, an explicit approval or HUMAN-HOLD requires user input, a proven blocker leaves no ready work, or a merge decision requires the user. Hooks are advisory and never replace this watch cycle.\n`;
function adaptOrchestratorForCodex(text) {
  let result = text.replace(/- \*\*Hard gate:\*\*[\s\S]*?false positive\.\n/, "- **Codex hook support:** Muster's trusted `PreToolUse` hook surfaces a policy warning when a write-capable wave appears outside a detected worktree. Codex cannot reliably deny every subagent or unified-shell action, so the orchestrator must still enforce dispatch, ownership, and worktree isolation explicitly.\n");
  result = result.replace("give each its own git worktree (`isolation: \"worktree\"` on the Codex subagent dispatcher)", "create a separate git worktree for each task, start the dispatched Codex subagent in that worktree, and record the path/base SHA in its brief");
  result = result.replaceAll("after a Claude Code restart", "after starting a new Codex session");
  result = result.replace("the `PreToolUse` hook reads this marker to enforce the iron rule", "the trusted Codex `PreToolUse` hook uses this marker to diagnose likely policy violations; the orchestrator still enforces the iron rule through dispatch and repository evidence");
  result = result.replace("the `PreToolUse` hook treats it as stale and applies the scale-gate rather than the full wave-guard", "the Codex hook reports it as potentially stale; verify ownership and state before continuing");
  result = result.replaceAll("the `PreToolUse` hook reads this\nfile to deny matching tool calls", "the trusted Codex `PreToolUse` hook reads this\nfile to surface supported policy warnings for matching tool calls");
  const providerStart = result.indexOf("      - **Provider kind:**");
  const failureStart = result.indexOf("      - **Subagent failure", providerStart);
  if (providerStart < 0 || failureStart < 0) throw new Error("orchestrator provider/model section not found");
  const provider = `      - **Provider and model policy:** look up the role's chosen provider from \`node ${"${PLUGIN_ROOT}"}/runtime/muster.mjs capabilities --codex\`. When \`chosen.kind === "agent"\`, call \`collaboration.spawn_agent\` with the ordinary task fields, a bounded \`fork_turns\` value (\`"none"\` or a positive turn count, never \`"all"\`), plus \`agent_type: "<exact chosen.id>"\`. Codex rejects a named profile combined with a full-history fork because that fork inherits the parent's type/model/effort. Codex dispatch also has no cwd field, so every worktree-scoped brief must include the absolute \`WORKTREE CWD\`, absolute manifest and STATE paths inside it, and require that cwd as the first verification command's and all later tool calls' \`workdir\`; never read the parent checkout's \`.muster\` artifacts. This runtime extension may be absent from a simplified displayed tool signature; include it anyway. The profile TOML is the authoritative Codex adapter boundary for the pinned model, reasoning effort, sandbox, and developer instructions. Only an actual rejected tool call proves the named profile unavailable; schema inspection or an omitted displayed field is not a dispatch attempt. If the call rejects the type, stop that task with an explicit profile-registration diagnostic and remediation to reinstall/start a new session. Do not silently use a generic agent: that would lose the strict model and role policy. For a skill/MCP/inline provider, dispatch a general subagent and inject the resolved provider brief; record that this path inherits the parent model because Codex has no per-call model override for generic subagents.\n`;
  result = result.slice(0, providerStart) + provider + result.slice(failureStart);
  result = result.replace("Iron-rule reminder: the `PreToolUse` wave-guard hook enforces dispatch-not-inline; see the opening section.", "Iron-rule reminder: Codex hooks diagnose likely violations, while the orchestrator, named profiles, ownership receipts, and isolated worktrees enforce dispatch-not-inline.");
  const enforcement = result.indexOf("## Enforcement model: gates vs conventions");
  if (enforcement < 0) throw new Error("orchestrator enforcement section not found");
  return result.slice(0, enforcement) + `## Codex enforcement model\n\n- **Mechanically validated:** manifest schema, dependency waves, capability resolution, worktree/base-SHA receipts, file ownership checks, tests, reviews, commits, and terminal receipts.\n- **Hook diagnostics:** session/prompt context, supported action-class warnings, worktree warnings, stale-marker diagnostics, and subagent start/stop context after one-time hook trust.\n- **Advisory:** todo-before-spawn and universal dispatch-not-inline blocking. Current Codex hooks cannot reliably intercept every subagent or unified-shell action, so do not claim these are hard gates.\n- **Required invariant:** every write-capable wave runs in explicitly created isolated worktrees and is verified from repository state after the barrier.\n\n${agentWatchProtocol}`;
}
function bindBundledCodexCli(text) {
  const cli = `node ${"${PLUGIN_ROOT}"}/runtime/muster.mjs`;
  return text
    .replaceAll("npx -y @adnova-group/muster", cli)
    .replace(new RegExp(`${cli.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} capabilities(?! --codex)`, "g"), `${cli} capabilities --codex`)
    .replace(new RegExp(`${cli.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} match(?! --codex)`, "g"), `${cli} match --codex`)
    .replace(new RegExp(`${cli.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} assess(?! --codex)`, "g"), `${cli} assess --codex`)
    .replace(new RegExp(`${cli.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} diagnose(?! --codex)`, "g"), `${cli} diagnose --codex`)
    .replace(new RegExp(`${cli.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} audit(?! --codex)`, "g"), `${cli} audit --codex`)
    .replace(new RegExp(`${cli.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} manifest validate(?! --codex)`, "g"), `${cli} manifest validate --codex`);
}
const codexSkillId = name => name.startsWith("gsd-") ? `muster-${name}` : name;
function codexSkill(source, id) {
  const match = source.match(/^(---\r?\n[\s\S]*?\r?\n---)([\s\S]*)$/);
  if (!match) throw new Error("Ported Codex skill is missing YAML frontmatter");
  let header = translateModeNames(match[1]).replaceAll("AskUserQuestion", "interactive user input");
  header = header.replace(/^(?:adapted_from|inspired_by|muster_builtin):.*\r?\n?/gm, "");
  header = header.replace(/^name:\s*.*$/m, `name: ${id}`);
  header = header.replace(/^description:\s*(.*)$/m, (_, description) => {
    const codexDescription = `Codex-compatible Muster workflow. ${description}`.replaceAll("<", "[").replaceAll(">", "]");
    return `description: ${JSON.stringify(codexDescription)}`;
  });
  let body = translatePluginPaths(bindBundledCodexCli(translateCodexProse(translateModeNames(match[2]))))
    .replaceAll("${CLAUDE_PLUGIN_ROOT}", "${PLUGIN_ROOT}")
    .replaceAll("AskUserQuestion", "interactive user input")
    .replaceAll("Claude Code Agent tool", "Codex subagent dispatcher")
    .replaceAll("the Agent tool", "the Codex subagent dispatcher")
    .replaceAll("Agent tool", "Codex subagent dispatcher")
    .replaceAll("Task tool", "Codex subagent dispatcher");
  if (id === "coordination") body = adaptCoordinationForCodex(body);
  if (id === "orchestrator") body = adaptOrchestratorForCodex(body);
  if (id === "interview") body = body.replace("Present both for approval via the **interactive user input** selection UI", "Render the complete enriched outcome and every success-criteria item inside the approval prompt itself; never refer to unstated criteria as ‘above’ or ‘previous’. Present both for approval via the **interactive user input** selection UI");
  if (id === "wsh-sast-configuration") body = body.replace("# See references/semgrep-rules.md for detailed examples", "# Example custom rule; adapt it to the repository's threat model");
  const binding = `\n\n## Codex harness binding\n\nRead \`${"${PLUGIN_ROOT}"}/runtime/codex-skill-adapter.md\` before following this workflow. Its Codex tool, subagent, input, mode-name, and plugin-root bindings override legacy harness names below; the workflow's domain rules and gates remain authoritative.\n`;
  return header + binding + body.replace(/^\r?\n*/, "\n");
}
async function adaptPortedSkills(names) {
  for (const name of names) {
    const id = codexSkillId(name);
    const path = join(modeDir, id, "SKILL.md");
    await write(path, codexSkill(await readFile(path, "utf8"), id));
  }
}
function profileToml(id, source, config) {
  const body = source.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "").trim();
  const description = frontmatter(source, "description") || `${id} Muster specialist.`;
  const defaultModel = policy[config.tier];
  if (!defaultModel) throw new Error(`unknown Codex profile tier for ${id}: ${config.tier}`);
  if (config.reasoning !== undefined && !["medium", "high", "xhigh", "max"].includes(config.reasoning)) {
    throw new Error(`invalid Codex profile reasoning override for ${id}: ${config.reasoning}`);
  }
  const model = { ...defaultModel, reasoning: config.reasoning ?? defaultModel.reasoning };
  const isolation = config.readOnly
    ? "Remain read-only. Do not edit files or run commands that mutate the workspace."
    : "Before writing, verify the task is running in an isolated git worktree; do not write directly on a base branch.";
  return [
    `name = ${JSON.stringify(id)}`,
    `description = ${JSON.stringify(description)}`,
    `model = ${JSON.stringify(model.model)}`,
    `model_reasoning_effort = ${JSON.stringify(model.reasoning)}`,
    `sandbox_mode = ${JSON.stringify(config.readOnly ? "read-only" : "workspace-write")}`,
    "developer_instructions = \"\"\"",
    body,
    "",
    isolation,
    "\"\"\"",
    ""
  ].join("\n");
}
function modeSkill(name, mode) {
  return `---\nname: ${name}\ndescription: ${JSON.stringify(`Use for Muster orchestration when the user asks to ${mode.purpose}. Explicitly invoke with $${name}.`)}\n---\n\n<!-- prompt-lint-disable ANTH-ROLE-001, ANTH-FMT-001: Mode dispatcher delegates to the authoritative workflow and intentionally does not impose a second persona or output format. -->\n\n# Muster ${mode.command}\n\nUse this skill when the request needs to ${mode.purpose}. Treat the user's remaining prompt as the outcome or backlog reference.\n\n1. Read \`${"${PLUGIN_ROOT}"}/runtime/codex-skill-adapter.md\` and apply its Codex tool, named-profile dispatch, bounded-context-fork, and plugin-root bindings.\n2. Read \`${"${PLUGIN_ROOT}"}/commands/${mode.command}.md\` for the authoritative workflow and preserve its approval, isolation, escalation, and receipt gates.\n3. Use the bundled Muster MCP tools for deterministic routing, manifests, waves, scoring, and pipelines. The bundled CLI is \`node ${"${PLUGIN_ROOT}"}/runtime/muster.mjs\` when a tool is not available.\n4. Keep the shared pipeline files authoritative. Do not duplicate pipeline routing in this skill.\n\n${agentWatchProtocol}`;
}

async function buildBootstrapCandidate(destination) {
  const wrapper = (header, kind, name) => `${header}\n\n<!-- prompt-lint-disable ANTH-ROLE-001, ANTH-FMT-001: Bootstrap delegates to the role and output contract in the validated selected release. -->\n\n# Immutable Muster bootstrap\n\nRun \`node \${PLUGIN_ROOT}/runtime/resolve-release.mjs ${kind} ${name}\`. The command revalidates the selected asset through a no-follow file descriptor and writes its verified contents to stdout. Follow those contents as the authoritative workflow; never follow a release pathname printed or inferred before validation. If resolution fails, stop with the diagnostic; never use a partial or unvalidated generation.\n`;
  await cp(join(plugin, "agents"), join(destination, "agents"), { recursive: true });
  const manifest = JSON.parse(await readFile(join(plugin, ".codex-plugin", "plugin.json"), "utf8"));
  manifest.version = "0.0.0-bootstrap";
  await write(join(destination, ".codex-plugin", "plugin.json"), JSON.stringify(manifest, null, 2) + "\n");
  await write(join(destination, ".mcp.json"), JSON.stringify({ mcpServers: { muster: { command: "node", args: ["./runtime/muster-mcp.mjs"], cwd: "." } } }, null, 2) + "\n");
  await write(join(destination, "package.json"), JSON.stringify({ version: "0.0.0-bootstrap", private: true }, null, 2) + "\n");
  await ensure(join(destination, "runtime"));
  for (const name of await readdir(join(plugin, "skills"))) {
    const source = await readFile(join(plugin, "skills", name, "SKILL.md"), "utf8");
    const header = source.match(/^---\r?\n[\s\S]*?\r?\n---/)?.[0];
    if (!header) throw new Error(`bootstrap skill lacks frontmatter: ${name}`);
    await write(join(destination, "skills", name, "SKILL.md"), wrapper(header, "skill", name));
  }
  for (const file of await readdir(join(plugin, "commands"))) {
    if (!file.endsWith(".md")) continue;
    const source = await readFile(join(plugin, "commands", file), "utf8");
    const header = source.match(/^---\r?\n[\s\S]*?\r?\n---/)?.[0] || "";
    await write(join(destination, "commands", file), wrapper(header, "command", file.slice(0, -3)));
  }
  await Promise.all([
    cp(join(root, "codex", "bootstrap", "resolve-release.mjs"), join(destination, "runtime", "resolve-release.mjs")),
    cp(join(root, "codex", "bootstrap", "muster.mjs"), join(destination, "runtime", "muster.mjs")),
    cp(join(root, "codex", "bootstrap", "muster-mcp.mjs"), join(destination, "runtime", "muster-mcp.mjs"))
  ]);
  await write(join(destination, "runtime", "codex-skill-adapter.md"), "# Immutable Muster bootstrap adapter\n\nRun `node ${PLUGIN_ROOT}/runtime/resolve-release.mjs adapter`; it writes the no-follow, point-of-use revalidated adapter contents to stdout. Read and apply those contents.\n");
  await write(join(destination, "runtime", "sprint-protocol.md"), "# Immutable Muster bootstrap protocol\n\nRun `node ${PLUGIN_ROOT}/runtime/resolve-release.mjs sprint`; it writes the no-follow, point-of-use revalidated protocol contents to stdout. Read and apply those contents.\n");
}

try {
await cleanStaleStages();
stagingRoot = await mkdtemp(join(pluginParent, ".muster-build-"));
await write(join(stagingRoot, ".lease.json"), JSON.stringify({ format: 1, pid: process.pid, startedAt: Date.now() }) + "\n");
plugin = join(stagingRoot, "release", "plugin");
runtime = join(plugin, "runtime");
profiles = join(stagingRoot, "release", "profiles");
modeDir = join(plugin, "skills");
for (const source of ["catalog", "codex", "cowork", "pipelines", "plugin", "scripts", "src", "vendor"]) {
  await assertRegularTree(join(root, source));
}
await assertRegularFile(join(root, "package.json"));
pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
mapping = JSON.parse(await readFile(join(root, "codex", "agents.manifest.json"), "utf8"));
await Promise.all([ensure(plugin), ensure(runtime)]);

await Promise.all([
  cp(join(root, "plugin", "commands"), join(plugin, "commands"), { recursive: true }),
  cp(join(root, "catalog"), join(plugin, "catalog"), { recursive: true }),
  cp(join(root, "pipelines"), join(plugin, "pipelines"), { recursive: true }),
  cp(join(root, "vendor"), join(plugin, "vendor"), { recursive: true }),
  cp(join(root, "codex", "skill-adapter.md"), join(runtime, "codex-skill-adapter.md")),
  cp(join(root, "codex", "hooks"), join(runtime, "install-hooks"), { recursive: true }),
  cp(join(root, "cowork", "sprint-protocol.md"), join(runtime, "sprint-protocol.md"))
]);
const codexCatalogPath = join(plugin, "catalog", "builtins.muster.yaml");
await write(
  codexCatalogPath,
  (await readFile(codexCatalogPath, "utf8")).replace(
    "blader/humanizer + StealthHumanizer (AI-tell removal)",
    "blader/humanizer + rudra496/StealthHumanizer (AI-tell removal)"
  )
);
for (const entry of await readdir(join(plugin, "commands"), { withFileTypes: true })) {
  if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
  const path = join(plugin, "commands", entry.name);
  await write(path, adaptCommandForCodex(bindBundledCodexCli(translateModeNames(await readFile(path, "utf8"))), entry.name));
}
await cp(join(root, "plugin", "skills"), join(plugin, "skills"), { recursive: true });
await cp(join(root, "plugin", "builtins"), join(plugin, "skills"), { recursive: true });
for (const entry of await readdir(join(root, "codex", "skill-assets"), { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;
  await cp(join(root, "codex", "skill-assets", entry.name), join(modeDir, entry.name), { recursive: true });
}
const portedSkillNames = [...new Set([
  ...(await readdir(join(root, "plugin", "skills"), { withFileTypes: true })).filter(entry => entry.isDirectory()).map(entry => entry.name),
  ...(await readdir(join(root, "plugin", "builtins"), { withFileTypes: true })).filter(entry => entry.isDirectory()).map(entry => entry.name)
])];
for (const name of portedSkillNames.filter(name => name.startsWith("gsd-"))) {
  await rename(join(modeDir, name), join(modeDir, codexSkillId(name)));
}
for (const name of ["muster-gsd-plan-phase", "muster-gsd-execute-phase", "muster-gsd-verify-work", "wsh-signed-audit-trails-recipe"]) {
  await rm(join(modeDir, name), { recursive: true, force: true });
  await cp(join(root, "codex", "fallback-skills", name), join(modeDir, name), { recursive: true });
}
await adaptPortedSkills(portedSkillNames.filter(name => !name.startsWith("gsd-") && name !== "wsh-signed-audit-trails-recipe"));

for (const [name, mode] of Object.entries(modes)) await write(join(modeDir, name, "SKILL.md"), modeSkill(name, mode));
await write(join(modeDir, "muster", "SKILL.md"), `---\nname: muster\ndescription: ${JSON.stringify("Use for any glass-box Muster orchestration request: plan, implement, backlog, diagnose, audit, runner, capture, pipeline, crew, or wave workflow.")}\n---\n\n<!-- prompt-lint-disable ANTH-ROLE-001, ANTH-FMT-001: Root router delegates to a selected authoritative workflow and intentionally does not impose a second persona or output format. -->\n\n# Muster\n\nRead \`${"${PLUGIN_ROOT}"}/runtime/codex-skill-adapter.md\` before routing so named profiles, bounded context forks, plugin paths, and Codex-native tools are applied consistently.\n\nSelect the matching explicit skill when the request has a clear mode: $muster-plan, $muster-go, $muster-plan-backlog, $muster-go-backlog, $muster-diagnose, $muster-audit, $muster-runner, or $muster-capture. Use the legacy run, autopilot, and sprint skills only for compatibility.\n\nStart with the bundled deterministic MCP tools: detect the project, resolve capabilities, assess the outcome, route the pipeline, validate the crew manifest, then execute dependency waves with receipts and gates. Write-capable waves require isolated worktrees.\n\n${agentWatchProtocol}`);

for (const [id, config] of Object.entries(mapping.agents)) {
  const source = await readFile(join(root, config.source), "utf8");
  const content = profileToml(id, source, config);
  await Promise.all([
    write(join(profiles, `${id}.toml`), content),
    write(join(plugin, "agents", `${id}.toml`), content)
  ]);
}

await ensure(runtime);
// The source entry points already carry executable shebangs. esbuild preserves
// them, so only inject createRequire for bundled CommonJS dependencies such as
// yaml; do not add another shebang.
const requireBanner = 'import { createRequire as __createRequire } from "node:module"; const require = __createRequire(import.meta.url);';
const bundleOptions = { bundle: true, platform: "node", format: "esm", target: "node20", preserveSymlinks: true };
await build({ ...bundleOptions, entryPoints: [join(root, "src", "cli.js")], outfile: join(runtime, "muster.mjs"), banner: { js: requireBanner } });
await build({ ...bundleOptions, entryPoints: [join(root, "src", "cli.js")], outfile: join(plugin, "src", "cli.js"), banner: { js: requireBanner } });
const sharedMcpSource = await readFile(join(root, "cowork", "mcp-server.mjs"), "utf8");
const codexMcpSource = sharedMcpSource
  .replace("muster MCP server — exposes muster's deterministic CLI brain as MCP tools for Claude Cowork.", "muster MCP server — exposes muster's deterministic CLI brain as MCP tools for Codex.")
  .replace("Running muster here: you have these MCP tools plus your own subagent dispatch (parallel fan-out and per-call model override both work). No skills or slash commands, so follow this protocol directly.", "Running Muster in Codex: use the bundled $muster-* skills for orchestration and these MCP tools for deterministic routing, gates, scoring, and wave computation.")
  .replace('{ argv: ["capabilities", "--cowork"], ...S("Resolve every muster role to its best-available provider, fallback chain, and model tier, against Cowork\'s MCP registry (local servers + extensions; declare remote connectors via MUSTER_COWORK_CONNECTORS).", "home", false) }', '{ argv: ["capabilities", "--codex"], ...S("Resolve every Muster role against enabled Codex plugins, skills, MCP servers, and custom-agent profiles.", "home", false) }')
  .replace('muster_assess: { argv: ["assess"]', 'muster_assess: { argv: ["assess", "--codex"]');
if (!codexMcpSource.includes('["capabilities", "--codex"]') || codexMcpSource.includes('["capabilities", "--cowork"]')) throw new Error("Codex MCP capability adapter was not applied");
if (!codexMcpSource.includes('muster_assess: { argv: ["assess", "--codex"]')) throw new Error("Codex MCP assess adapter was not applied");
await build({ ...bundleOptions, stdin: { contents: codexMcpSource, resolveDir: join(root, "cowork"), sourcefile: "mcp-server.codex.mjs" }, outfile: join(runtime, "muster-mcp.mjs") });
await write(join(plugin, "package.json"), JSON.stringify({ version: pkg.version }, null, 2) + "\n");
await write(join(plugin, "src", "package.json"), JSON.stringify({ type: "module" }) + "\n");

await write(join(plugin, ".mcp.json"), JSON.stringify({
  mcpServers: { muster: { command: "node", args: ["./runtime/muster-mcp.mjs"], cwd: "." } }
}, null, 2) + "\n");
await write(join(plugin, ".codex-plugin", "plugin.json"), JSON.stringify({
  name: "muster", version: pkg.version,
  description: "Glass-box agentic orchestration for Codex: deterministic routing, skills, agents, pipelines, hooks, and MCP tools.",
  author: { name: "Adnova Group", email: "rnbennett@gmail.com", url: "https://github.com/Adnova-Group" },
  homepage: "https://adnova-group.github.io/muster/", repository: "https://github.com/Adnova-Group/muster", license: "Apache-2.0",
  keywords: ["orchestration", "agents", "pipelines", "mcp", "codex"], skills: "./skills/", mcpServers: "./.mcp.json",
  interface: { displayName: "Muster", shortDescription: "Glass-box agentic orchestration for Codex.", longDescription: "Muster provides deterministic routing, custom-agent profiles, pipeline workflows, and the complete MCP toolset.", developerName: "Adnova Group", category: "Productivity", capabilities: ["Read", "Write"], websiteURL: "https://adnova-group.github.io/muster/", defaultPrompt: ["Plan this feature with Muster.", "Run a Muster audit of this repository.", "Use Muster to clear this backlog."] }
}, null, 2) + "\n");

const stagedBootstrap = join(stagingRoot, "bootstrap", "muster");
await buildBootstrapCandidate(stagedBootstrap);
const bootstrap = await prepareCodexBootstrap({
  repoRoot: root,
  stagedBootstrap,
  allowMaintenance: process.env.MUSTER_CODEX_BOOTSTRAP_MAINTENANCE === "1"
});

const published = await publishCodexRelease({
  repoRoot: root,
  stagedRelease: join(stagingRoot, "release"),
  packageVersion: pkg.version,
  bootstrapDigest: bootstrap.digest,
  allowBootstrapMigration: process.env.MUSTER_CODEX_BOOTSTRAP_MAINTENANCE === "1",
  marketplaceTemplate: {
    name: "muster",
    interface: { displayName: "Muster" },
    plugins: [{
      name: "muster",
      source: { source: "local", path: "./.agents/plugins/bootstrap/muster" },
      policy: { installation: "AVAILABLE", authentication: "ON_INSTALL" },
      category: "Productivity"
    }]
  }
});
const packageFiles = (pkg.files || []).filter(item => item !== ".agents" && !item.startsWith(".agents/"));
const allSelections = (await readdir(join(root, ".agents", "plugins", "selections")))
  .filter(name => /^\d{12}-[a-f0-9]{64}\.json$/.test(name)).sort().reverse();
const initialGeneration = JSON.parse(await readFile(join(root, ".agents", "plugins", "marketplace.json"), "utf8")).musterBootstrap.initialGeneration;
const retainedGenerations = [];
for (const generation of [published.generation, initialGeneration, ...allSelections.map(name => name.match(/-([a-f0-9]{64})\.json$/)[1])]) {
  if (!retainedGenerations.includes(generation) && retainedGenerations.length < 3) retainedGenerations.push(generation);
}
const retainedSelections = [];
for (const generation of retainedGenerations) {
  const name = allSelections.find(candidate => candidate.endsWith(`-${generation}.json`));
  if (!name) throw new Error(`Codex package LKG generation lacks a coherent selection: ${generation}`);
  retainedSelections.push(name);
}
if (retainedGenerations.length < 1 || retainedGenerations.length > 3 || !retainedGenerations.includes(published.generation)) {
  throw new Error("Codex package retention must contain only the selected generation and at most two LKG generations");
}
packageFiles.push(".agents/plugins/marketplace.json", ".agents/plugins/bootstrap/muster");
packageFiles.push(...retainedSelections.map(name => `.agents/plugins/selections/${name}`));
packageFiles.push(...retainedGenerations.map(generation => `.agents/plugins/releases/${generation}`));
await write(join(root, "package.json"), JSON.stringify({ ...pkg, files: packageFiles }, null, 2) + "\n");
} finally {
  if (stagingRoot) await rm(stagingRoot, { recursive: true, force: true });
}
