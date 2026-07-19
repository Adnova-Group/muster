import { build } from "esbuild";
import { createHash } from "node:crypto";
import {
  cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { assertRegularTree, generateCodexProfiles, publishCodexPlugin, resolveCodexPlugin } from "../src/codex-release.js";

// Deliberately synchronous fs throughout this script (mirrors src/codex-release.js).
//
// Generation stages into a fresh directory on the *native* filesystem
// (os.tmpdir(), i.e. Linux tmpfs in this project's usual WSL2 environment)
// rather than under `outDir`. Confirmed root cause: on a WSL2 drvfs (/mnt/c)
// mount, renaming a directory immediately after a large (several-hundred
// file) write burst inside it can return a persistent spurious ENOENT — an
// A/B test reproduced this both sandboxed and unsandboxed, ruling out
// external interference; slowing every syscall down (as `strace` does) makes
// it pass, but a 50-second bounded backoff on the same rename does not, which
// rules out a simple short-lived handle/cache race too. This is drvfs-mount
// state, not a Node or generation-logic defect. Staging on native tmpfs
// avoids ever renaming a hot-written tree on that mount at all — the publish
// step below copies the finished tree into place instead (see
// publishCodexPlugin's docblock for why that no longer needs to be an atomic
// rename).

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

function ensure(dir) { mkdirSync(dir, { recursive: true }); }
function write(path, content) { ensure(dirname(path)); writeFileSync(path, content, "utf8"); }
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
    .replaceAll("plugin/skills/", `${"${PLUGIN_ROOT}"}/internal-skills/`)
    .replaceAll("plugin/hooks/", `${"${PLUGIN_ROOT}"}/hooks/`);
}
function adaptCommandForCodex(text, name) {
  let result = translatePluginPaths(translateCodexProse(text))
    .replaceAll("the `PreToolUse` hook uses to scope the scale-gate", "Muster's Codex lifecycle hooks use for state diagnostics")
    .replaceAll("the whole batch counts as ONE run for the `PreToolUse` hook's scale-gate scoping", "the whole batch counts as ONE run for Muster's Codex lifecycle diagnostics")
    .replaceAll("the whole plan-backlog invocation counts as ONE run for the `PreToolUse` hook's scale-gate scoping", "the whole plan-backlog invocation counts as ONE run for Muster's Codex lifecycle diagnostics")
    .replaceAll("`SessionStart` on a fresh session clears a stale marker automatically.", "Codex hooks never delete state markers automatically; on startup, verify and clear only a marker proven stale and owned by the interrupted workflow.")
    .replace(/when the running session's registry doesn't carry that type[\s\S]*?note the degradation in STATE/, "call `collaboration.spawn_agent` with `agent_type: \"muster-runner\"`, `fork_turns: \"none\"`, and its other ordinary fields. Permit a positive context fork only when the user explicitly requests it; never use `\"all\"`. Codex rejects a named profile combined with a full-history fork. `agent_type` is a Codex runtime extension and may be absent from the simplified displayed signature; include it anyway. Only an actual rejected tool call proves the profile unavailable. If that call rejects the type, fail the item closed with a profile-registration diagnostic and remediation to reinstall/start a new session; do not silently use a generic agent because that loses the pinned role/model policy")
    .replace(/Runner cwd is its worktree; tool calls rely on[\s\S]*?instead of blocking\./, "Runner cwd is its recorded worktree. Codex hooks provide diagnostics but do not replace the worktree path/base-SHA proof or the post-wave ownership check.")
    .replace(/capture only ever writes[\s\S]*?deliberately omitted\./i, "Capture only writes the explicitly approved `.muster/backlog.md` bookkeeping artifact and dispatches no write-capable wave, so it deliberately has no run-active lifecycle.");
  if (["plan.md", "go.md", "plan-backlog.md"].includes(name)) {
    result = result.replaceAll("capabilities --codex", "capabilities --codex --roles-only");
  }
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
      "3. **Quota-bounded dimension sweep (Codex)** — Cover all six dimensions with three nonredundant read-only briefs instead of six overlapping repository scans:",
      "   - **system quality:** architecture, tech debt, simplification, and readability, returned as four separately labeled finding lists;",
      "   - **coverage:** test gaps and untested failure paths;",
      "   - **security:** injection, secrets, unsafe IO, trust boundaries, installers, and lifecycle hooks.",
      "   Dispatch these three briefs concurrently when the configured Codex capacity permits, otherwise in dependency-free batches. Respect `agents.max_threads`; neither lower nor raise it. Every worker uses `fork_turns: \"none\"`, a 25-step ceiling, focused commands only, and one concise receipt. Add prompt-quality as a fourth read-only brief only when the scoped diff changes prompts or agent instructions. Consolidation is forbidden until each required dimension has a receipt."
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
  const section = `## Standing-context preflight\n\nThe installed Codex plugin cache is not a Git checkout, so do not run \`git log\` against plugin paths. At the first read in a runner cycle, record the plugin version from \`${"${PLUGIN_ROOT}"}/package.json\` and a SHA-256 fingerprint over these installed behavior paths: \`internal-skills/coordination/SKILL.md\`, \`commands/go-backlog.md\`, \`commands/go.md\`, and \`commands/runner.md\`. Compute the fingerprint with the host's available SHA-256 tool, sorting paths before hashing. Muster's Codex hooks are installed outside the plugin cache: also locate the selected managed runtime at the git root's \`.codex/muster/hooks/\` or \`$CODEX_HOME/muster/hooks/\` and fingerprint its files plus the sibling Muster ownership manifest. If neither managed hook runtime can be proven, say "I don't know whether the standing context is unchanged," leave a HUMAN-HOLD receipt, and stop.\n\nBefore a later claim or resume in the same cycle, recompute both fingerprints. Unchanged version and fingerprints proceed. Any change means the installed standing context changed or was tampered with during the cycle: leave a HUMAN-HOLD receipt naming the old/new version and hashes, preserve the claim state, and stop. A packaged plugin cannot safely classify such an in-place mutation as confined because there is no authoritative Git history in the cache. A newly started cycle reads the newly installed immutable version and managed hook runtime as its fresh baseline.\n\n`;
  return text.slice(0, start) + section + text.slice(end);
}
const agentWatchProtocol = `## Agent watch invariant\n\n<!-- prompt-lint-disable GUARD-IDK-001: Explicit terminal conditions prevent abandoned live agents while preserving approval, HUMAN-HOLD, blocker, and merge-decision stops. -->\n\nAfter every dispatch, retain every canonical agent id returned by \`collaboration.spawn_agent\` and immediately call \`collaboration.wait_agent\` with a timeout of at most 60 seconds. A message or completion receipt wakes the watch immediately. After each wake, process mailbox receipts first, call \`collaboration.list_agents\` exactly once to reconcile live state, and dispatch any newly ready work. Never tight-poll. Three consecutive heartbeats without a receipt exhaust the Codex worker budget: interrupt the worker, record the incomplete task in STATE, and escalate or continue locally only when safe.\n\nRespect the configured \`agents.max_threads\`; Muster must neither lower nor raise it. Spawn with \`fork_turns: "none"\` unless the user explicitly requests a context fork. Every brief sets a 25-step ceiling, permits at most one follow-up, and defers broad suites to final verification. Do not send the final answer or clear state while executable work remains, but worker budget exhaustion is a terminal escalation condition rather than permission to wait forever. Hooks are advisory and never replace this watch cycle.\n`;
function adaptOrchestratorForCodex(text) {
  let result = text.replace(/- \*\*Hard gate:\*\*[\s\S]*?false positive\.\n/, "- **Codex hook support:** Muster's trusted `PreToolUse` hook surfaces a policy warning for a run-forbidden action class, plus a one-time border-invitation reminder once inline edits with no muster run active cross a threshold. Codex cannot reliably deny every subagent or unified-shell action, so the orchestrator must still enforce dispatch, ownership, and worktree isolation explicitly.\n");
  result = result.replace(
    "one implementer agent, given the task + the Crew Manifest as BRIEF.",
    "one implementer leaf agent, given a minimal dispatch packet: task id/text, relevant success criteria, absolute worktree/manifest/STATE paths, owned and frozen paths, dependency receipts, required provider or skill brief, and the return contract. Never attach unrelated plan items, capability inventories, or prior transcripts."
  );
  result = result.replace("give each its own git worktree (`isolation: \"worktree\"` on the Codex subagent dispatcher)", "create a separate git worktree for each task, start the dispatched Codex subagent in that worktree, and record the path/base SHA in its brief");
  result = result.replaceAll("after a Claude Code restart", "after starting a new Codex session");
  result = result.replace("the `PreToolUse` hook reads this marker to enforce the iron rule", "the trusted Codex `PreToolUse` hook uses this marker to diagnose likely policy violations; the orchestrator still enforces the iron rule through dispatch and repository evidence");
  result = result.replace("the `PreToolUse` hook treats it as stale and applies the scale-gate rather than the full wave-guard", "the Codex hook reports it as potentially stale; verify ownership and state before continuing");
  result = result.replaceAll("the `PreToolUse` hook reads this\nfile to deny matching tool calls", "the trusted Codex `PreToolUse` hook reads this\nfile to surface supported policy warnings for matching tool calls");
  const providerStart = result.indexOf("      - **Provider kind:**");
  const failureStart = result.indexOf("      - **Subagent failure", providerStart);
  if (providerStart < 0 || failureStart < 0) throw new Error("orchestrator provider/model section not found");
  const provider = `      - **Provider and model policy:** look up the role's chosen provider from \`node ${"${PLUGIN_ROOT}"}/runtime/muster.mjs capabilities --codex\`. When \`chosen.kind === "agent"\`, call \`collaboration.spawn_agent\` with the ordinary task fields, \`fork_turns: "none"\`, plus \`agent_type: "<exact chosen.id>"\`. Permit a positive context fork only when the user explicitly requests it; never use \`"all"\`. Workers are leaves and must not spawn descendants unless an approved manifest explicitly delegates nested orchestration. Include a 25-step ceiling, one-follow-up maximum, and focused-test-first rule in every brief. Respect the configured Codex thread concurrency and dispatch only manifest-ready, nonredundant workers. Codex dispatch has no cwd field, so every worktree-scoped brief must include the absolute \`WORKTREE CWD\`, absolute manifest and STATE paths inside it, and require that cwd for every tool call; never read the parent checkout's \`.muster\` artifacts. The profile TOML is the authoritative model, reasoning, and sandbox boundary. If the named type is rejected, stop with a registration diagnostic; do not silently inherit the parent model through a generic agent. For a skill provider, run \`node ${"${PLUGIN_ROOT}"}/runtime/resolve-skill-provider.mjs <chosen.source> <chosen.id>\`; this centrally validates provenance and the safe kebab-case id before constructing a path or invocation. If \`source === "builtin"\`, inject the verified workflow stdout into a general subagent brief and load relative assets through the command's optional third asset argument. If \`source === "installed"\`, follow stdout's explicit \`$skill-id\` invocation contract and never load the bundled fallback. For an MCP/inline provider, inject the resolved provider brief directly. Generic paths inherit the parent model and must follow the same conservation limits.\n`;
  const compactProvider = provider.replace(
    "look up the role's chosen provider from `node ${PLUGIN_ROOT}/runtime/muster.mjs capabilities --codex`.",
    "look up only the needed role with `node ${PLUGIN_ROOT}/runtime/muster.mjs capabilities --codex --role <role>`; do not reprint the full skills inventory during task dispatch."
  );
  result = result.slice(0, providerStart) + compactProvider + result.slice(failureStart);
  result = result.replace("Iron-rule reminder: the `PreToolUse` wave-guard hook enforces dispatch-not-inline; see the opening section.", "Iron-rule reminder: Codex hooks diagnose likely violations, while the orchestrator, named profiles, ownership receipts, and isolated worktrees enforce dispatch-not-inline.");
  // workflow-tool-delegation item: the "Wave dispatch: native Workflow vs prose fallback"
  // section describes a Claude Code CLI-only capability (the agent-teams `Workflow` tool)
  // that Codex has no equivalent of. The generic translateCodexProse/"Agent tool"->"Codex
  // subagent dispatcher" word-swaps upstream of this function cannot safely translate that
  // section's meaning (a blind swap would fabricate a "Codex CLI's deterministic fan-out
  // tool" that does not exist) -- so, same as the provider/model and enforcement-model
  // sections above, replace the section's BODY wholesale with fixed, accurate Codex text
  // instead of relying on word-level substitution. The HEADING itself is left byte-identical
  // so step 4a's "see \"Wave dispatch: native Workflow vs prose fallback\" below" pointer
  // (untouched, upstream of this function) still names a real heading in the Codex output.
  // codex-build-wire-resolvers item: the wholesale replacement below originally covered only
  // the "## Wave dispatch" heading's own body (native Workflow vs prose). Two later PRs
  // (worktree-isolation-native, codex-spawn-agent-dispatch) nested "### Codex-native dispatch:
  // spawn_agent" and "### Worktree isolation per harness + base-SHA receipts" INSIDE this same
  // span on the Claude-side source (both between this heading and the unmoved "## Scope fences"
  // end anchor) without ever extending this replacement text to cover them, so the Codex build
  // silently dropped both subsections' Codex-relevant guidance (the `resolveCodexWaveDispatch`
  // sequential-inline fallback + fail-closed spawn_agent guard, and `resolveWorktreeIsolation`'s
  // receipts-only mechanism + `buildBaseShaReceipt` provenance) — never reaching a CODEX-HOSTED
  // muster running the bundled plugin (test/codex-wave-dispatch.test.js and
  // test/worktree-isolation.test.js only prove the resolvers themselves, not that a generated
  // package exposes them). Restore both, phrased for Codex (no `src/wave-dispatch.js` citation:
  // that path does not exist in the shipped package).
  const waveDispatchHeading = "## Wave dispatch: native Workflow vs prose fallback";
  const waveDispatchStart = result.indexOf(waveDispatchHeading);
  const waveDispatchEnd = result.indexOf("## Scope fences", waveDispatchStart);
  if (waveDispatchStart < 0 || waveDispatchEnd < 0) throw new Error("orchestrator wave-dispatch section not found");
  result = result.slice(0, waveDispatchStart)
    + `${waveDispatchHeading}\n\nCodex has no counterpart to Claude Code CLI's agent-teams \`Workflow\` tool: wave dispatch always rides the \`collaboration.spawn_agent\`/\`wait_agent\`/\`list_agents\` protocol bound in the Provider and model policy above, never a deterministic native fan-out tool. \`node ${"${PLUGIN_ROOT}"}/runtime/muster.mjs wave-dispatch\` always resolves \`mode: "prose"\` on this harness (there is no Codex-side \`--agent-teams\`/\`MUSTER_AGENT_TEAMS\` declaration path); dispatch every wave task through \`collaboration.spawn_agent\` exactly as described above -- gated by this session's OWN \`multi_agent\` capability, declared not auto-probed same as every other check here: Codex ships \`multi_agent\` default-on, so only an explicit \`multiAgent: false\` (or \`MUSTER_CODEX_MULTI_AGENT=0\`) drops dispatch to \`mode: "sequential-inline"\` -- one crew member at a time, never a partial/mixed fan-out.\n\n### Worktree isolation: receipts-only\n\n\`collaboration.spawn_agent\` has no cwd field, so Codex has no native worktree mechanism to select at all: run \`node ${"${PLUGIN_ROOT}"}/runtime/muster.mjs worktree-isolation --harness codex\` to confirm this harness always resolves \`mechanism: "receipts-only"\`. The brief's absolute \`WORKTREE CWD\` (Provider and model policy, above) plus a base-SHA receipt per dispatched crew member -- \`{taskId, mechanism, baseSha, worktreePath}\`, refused over a missing or non-hex \`baseSha\` -- stand in for the isolation guarantee muster cannot get from this harness; append the receipt to STATE alongside the dispatch line. Immediately after, run \`node ${"${PLUGIN_ROOT}"}/runtime/muster.mjs receipt-verify <baseSha> --cwd <absolute worktree path>\` and treat a nonzero exit as a receipt failure -- escalate it, never continue silently.\n\n`
    + result.slice(waveDispatchEnd);
  const enforcement = result.indexOf("## Enforcement model: gates vs conventions");
  if (enforcement < 0) throw new Error("orchestrator enforcement section not found");
  return result.slice(0, enforcement) + `## Codex enforcement model\n\n- **Mechanically validated:** manifest schema, dependency waves, capability resolution, worktree/base-SHA receipts, file ownership checks, tests, reviews, commits, and terminal receipts.\n- **Hook diagnostics:** session/prompt context, supported action-class warnings, a warn-only border-invitation drift reminder, stale-marker diagnostics, and subagent start/stop context after one-time hook trust.\n- **Advisory:** todo-before-spawn and universal dispatch-not-inline blocking. Current Codex hooks cannot reliably intercept every subagent or unified-shell action, so do not claim these are hard gates.\n- **Required invariant:** every write-capable wave runs in explicitly created isolated worktrees and is verified from repository state after the barrier.\n\n${agentWatchProtocol}`;
}
function bindBundledCodexCli(text) {
  const cli = `node ${"${PLUGIN_ROOT}"}/runtime/muster.mjs`;
  return text
    // The Claude-side performance pass resolves `$MUSTER_CLI` once per run
    // (plugin/commands/go.md step -2) because a raw `npx` call pays a cold
    // start on every invocation. The Codex package has no such ambiguity:
    // the bundled runtime IS the resolved CLI, so bind the indirection (and
    // the unbraced plugin-root form its resolution snippet uses) directly to
    // the bundled entrypoint before the per-verb --codex rewrites below.
    .replaceAll("$MUSTER_CLI", cli)
    .replaceAll("$CLAUDE_PLUGIN_ROOT/", "${PLUGIN_ROOT}/")
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
  if (id === "sp-brainstorm") {
    body = body.replaceAll(
      "skills/brainstorming/visual-companion.md",
      `node ${"${PLUGIN_ROOT}"}/runtime/resolve-skill-provider.mjs builtin sp-brainstorm visual-companion.md`
    );
  }
  if (id === "coordination") body = adaptCoordinationForCodex(body);
  if (id === "orchestrator") body = adaptOrchestratorForCodex(body);
  if (id === "router") body = body.replace(
    "For EVERY plan task, consult `AvailableCapabilities.skills` and run",
    "The compact Codex capability snapshot intentionally omits the global skill inventory. For EVERY plan task, run"
  );
  if (id === "review-gate") {
    body = body
      .replace(
        // The Claude-side performance pass reuses the run's cached
        // .muster/capabilities.json for the whole run; the Codex package
        // instead requires compact per-role lookups so reviewer briefs never
        // carry the full skills inventory. Keep the fast-path cumulative-diff
        // clause (it is harness-neutral) and swap only the capability-source
        // phrasing.
        /`AvailableCapabilities` read from the run's already-captured `\.muster\/capabilities\.json` \(written once at[\s\S]*?serves every wave\)\./,
        "compact role lookups from `node ${PLUGIN_ROOT}/runtime/muster.mjs capabilities --codex --role <role>`; never attach the full skills inventory to a reviewer brief."
      )
      .replace(
        // Anchored on the step-1 opening + the step-2 opening ("2. Dispatch") rather than
        // a specific closing sentence, so a Claude-side reword of step 1's OWN prose (e.g.
        // the speed-tuning item's skill-size cuts, or weight-reduction's diff-scaled
        // reviewer-count rewrite before it) cannot silently desync this replacement from
        // its anchor the way the pre-speed-tuning literal "Select reviewers: ... Always at
        // least one." match did (broke silently when weight-reduction reworded step 1).
        /1\.\s+\*\*?Select reviewers[\s\S]*?(?=\n2\.\s+Dispatch)/,
        "1. Select one code reviewer for ordinary waves. Add the security reviewer only when the task is security-scoped or the diff touches authentication, authorization, secrets, cryptography, shell execution, network boundaries, installers, or lifecycle hooks. Add a surface reviewer only when its definition-of-done gate fires. Never dispatch two reviewers for the same quality dimension; always use at least one reviewer."
      )
      .replace(
        "Cap at\n   **3 fix iterations** (`REVIEW_GATE_MAX_ITERATIONS` = 3). If still blocked after the cap, ESCALATE",
        "Allow **one fix-and-re-review iteration**. If the same blocker remains, ESCALATE"
      );
  }
  if (id === "interview") body = body.replace("Present both for approval via the **interactive user input** selection UI", "Render the complete enriched outcome and every success-criteria item inside the approval prompt itself; never refer to unstated criteria as ‘above’ or ‘previous’. Present both for approval via the **interactive user input** selection UI");
  if (id === "wsh-sast-configuration") body = body.replace("# See references/semgrep-rules.md for detailed examples", "# Example custom rule; adapt it to the repository's threat model");
  const binding = `\n\n## Codex harness binding\n\nRead \`${"${PLUGIN_ROOT}"}/runtime/codex-skill-adapter.md\` before following this workflow. Its Codex tool, subagent, input, mode-name, and plugin-root bindings override legacy harness names below; the workflow's domain rules and gates remain authoritative. Load any relative bundled asset named by this workflow through \`node ${"${PLUGIN_ROOT}"}/runtime/resolve-skill-provider.mjs builtin ${id} <relative-asset>\`; never read the internal tree directly.\n`;
  return header + binding + body.replace(/^\r?\n*/, "\n");
}

async function writeInternalRuntime(root, destination) {
  const tree = await assertRegularTree(join(destination, "internal-skills"));
  const metadata = JSON.stringify({ format: 1, files: tree.files }, null, 2) + "\n";
  const digest = createHash("sha256").update(metadata).digest("hex");
  const loader = readFileSync(join(root, "codex", "internal-asset-loader.mjs"), "utf8")
    .replace("__MUSTER_INTERNAL_METADATA_DIGEST__", digest);
  if (loader.includes("__MUSTER_INTERNAL_METADATA_DIGEST__")) throw new Error("internal asset loader digest was not bound");
  write(join(destination, "runtime", "internal-assets.json"), metadata);
  write(join(destination, "runtime", "internal-asset-loader.mjs"), loader);
  cpSync(join(root, "codex", "resolve-skill-provider.mjs"), join(destination, "runtime", "resolve-skill-provider.mjs"));
}
async function adaptPortedSkills(internalSkillDir, names) {
  for (const name of names) {
    const id = codexSkillId(name);
    const path = join(internalSkillDir, id, "SKILL.md");
    write(path, codexSkill(readFileSync(path, "utf8"), id));
  }
}

// Generates the complete Codex plugin (skills, commands, MCP/runtime bundle,
// agent profiles) into a fresh staging directory under `outDir`, then
// publishes it as `outDir/plugin` with `outDir/marketplace.json` pointing at
// it. `outDir` is caller-chosen and is never inside the git-tracked repo tree
// content: the CLI entry below uses a gitignored repo-relative staging
// directory; codex-install.js uses a directory under the user's CODEX_HOME.
// Nothing this function does regenerates a payload git would ever see.
//
// The real fix for the drvfs (WSL2 9p) rename-after-write-burst race lives at
// the actual rename call site (src/codex-release.js's renameWithRetry): a
// short settle-and-retry of that one rename against its still-present source.
// This outer retry is only a last-resort fallback for a full attempt that
// fails for some other transient ENOENT (e.g. mid-generation, before the
// publish rename); it should rarely if ever fire.
//
// Idempotent: skips regeneration entirely when `outDir` already holds a
// published plugin whose packageVersion matches the current package.json.
// This is the one shared implementation both the CLI entry below and
// codex-install.js's install-time trigger use, so `npm run build:codex` /
// `pretest` skip exactly like a `muster install codex` call does — neither
// path had its own separate, possibly-diverging copy of this check before.
// Known limitation: this compares only the package version, not file
// content, so editing a source file without bumping the version will not by
// itself trigger regeneration and this call is a silent no-op — delete
// `outDir`, bump the version, or set `MUSTER_BUILD_FORCE=1` (honored here,
// and therefore by `npm run build:codex` / the `pretest` hook that invokes
// this same script's CLI entry below) to force a fresh build regardless of
// the published version.
export async function buildCodexPlugin(options, retries = 1) {
  const { root, outDir } = options;
  const packageVersion = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;
  if (process.env.MUSTER_BUILD_FORCE !== "1") {
    try {
      const current = await resolveCodexPlugin(root, { pluginsRoot: outDir });
      if (current.packageVersion === packageVersion) return current;
    } catch { /* nothing published yet, or what's there is stale/invalid: generate below */ }
  }
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try { return await buildCodexPluginOnce(options); }
    catch (error) {
      if (error?.code !== "ENOENT") throw error;
      lastError = error;
    }
  }
  throw new Error(`Codex plugin generation did not succeed after ${retries + 1} attempts: ${lastError.message}`, { cause: lastError });
}

async function buildCodexPluginOnce({ root, outDir }) {
  ensure(outDir);
  // Stage on the native filesystem, not under outDir — see the top-of-file
  // comment. outDir itself may still be on drvfs (it usually is: the
  // gitignored repo-relative staging dir, or a directory under CODEX_HOME);
  // only the hot-written intermediate tree needs to avoid that mount.
  const stagingRoot = mkdtempSync(join(tmpdir(), "muster-build-"));
  try {
    const plugin = join(stagingRoot, "plugin");
    const runtime = join(plugin, "runtime");
    const modeDir = join(plugin, "skills");
    const internalSkillDir = join(plugin, "internal-skills");
    for (const source of ["catalog", "codex", "cowork", "pipelines", "plugin", "scripts", "src", "vendor"]) {
      await assertRegularTree(join(root, source));
    }
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
    ensure(plugin); ensure(runtime);

    rmAndCopy(join(root, "plugin", "commands"), join(plugin, "commands"));
    rmAndCopy(join(root, "catalog"), join(plugin, "catalog"));
    rmAndCopy(join(root, "pipelines"), join(plugin, "pipelines"));
    rmAndCopy(join(root, "vendor"), join(plugin, "vendor"));
    write(join(runtime, "codex-skill-adapter.md"), readFileSync(join(root, "codex", "skill-adapter.md"), "utf8"));
    rmAndCopy(join(root, "codex", "hooks"), join(runtime, "install-hooks"));
    write(join(runtime, "sprint-protocol.md"), readFileSync(join(root, "cowork", "sprint-protocol.md"), "utf8"));
    const codexCatalogPath = join(plugin, "catalog", "builtins.muster.yaml");
    write(
      codexCatalogPath,
      readFileSync(codexCatalogPath, "utf8").replace(
        "blader/humanizer + StealthHumanizer (AI-tell removal)",
        "blader/humanizer + rudra496/StealthHumanizer (AI-tell removal)"
      )
    );
    for (const entry of readdirSync(join(plugin, "commands"), { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
      const path = join(plugin, "commands", entry.name);
      write(path, adaptCommandForCodex(bindBundledCodexCli(translateModeNames(readFileSync(path, "utf8"))), entry.name));
    }
    rmAndCopy(join(root, "plugin", "skills"), internalSkillDir);
    rmAndCopy(join(root, "plugin", "builtins"), internalSkillDir, { merge: true });
    for (const entry of readdirSync(join(root, "codex", "skill-assets"), { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      rmAndCopy(join(root, "codex", "skill-assets", entry.name), join(internalSkillDir, entry.name), { merge: true });
    }
    const implementerPromptPath = join(internalSkillDir, "sp-subagents", "implementer-prompt.md");
    write(
      implementerPromptPath,
      readFileSync(implementerPromptPath, "utf8").replace(
        "full suite once before committing, not after every edit.",
        "focused tests before committing; the parent runs the broad suite once at final verification."
      )
    );
    const portedSkillNames = [...new Set([
      ...readdirSync(join(root, "plugin", "skills"), { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => entry.name),
      ...readdirSync(join(root, "plugin", "builtins"), { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => entry.name)
    ])];
    for (const name of portedSkillNames.filter(name => name.startsWith("gsd-"))) {
      renameSync(join(internalSkillDir, name), join(internalSkillDir, codexSkillId(name)));
    }
    for (const name of ["muster-gsd-plan-phase", "muster-gsd-execute-phase", "muster-gsd-verify-work", "wsh-signed-audit-trails-recipe"]) {
      rmSync(join(internalSkillDir, name), { recursive: true, force: true });
      rmAndCopy(join(root, "codex", "fallback-skills", name), join(internalSkillDir, name));
    }
    await adaptPortedSkills(internalSkillDir, portedSkillNames.filter(name => !name.startsWith("gsd-") && name !== "wsh-signed-audit-trails-recipe"));
    await writeInternalRuntime(root, plugin);

    for (const [name, mode] of Object.entries(modes)) write(join(modeDir, name, "SKILL.md"), modeSkill(name, mode));
    write(join(modeDir, "muster", "SKILL.md"), `---\nname: muster\ndescription: ${JSON.stringify("Use for any glass-box Muster orchestration request: plan, implement, backlog, diagnose, audit, runner, capture, pipeline, crew, or wave workflow.")}\n---\n\n<!-- prompt-lint-disable ANTH-ROLE-001, ANTH-FMT-001: Root router delegates to a selected authoritative workflow and intentionally does not impose a second persona or output format. -->\n\n# Muster\n\nRead \`${"${PLUGIN_ROOT}"}/runtime/codex-skill-adapter.md\` before routing so named profiles, bounded context forks, plugin paths, and Codex-native tools are applied consistently.\n\nSelect the matching explicit skill when the request has a clear mode: $muster-plan, $muster-go, $muster-plan-backlog, $muster-go-backlog, $muster-diagnose, $muster-audit, $muster-runner, or $muster-capture. Use the legacy run, autopilot, and sprint skills only for compatibility.\n\nStart with the bundled deterministic MCP tools: detect the project, resolve capabilities, assess the outcome, route the pipeline, validate the crew manifest, then execute dependency waves with receipts and gates. Write-capable waves require isolated worktrees.\n\n${agentWatchProtocol}`);

    const profiles = await generateCodexProfiles(root);
    for (const [name, content] of profiles) write(join(plugin, "agents", name), content);

    ensure(runtime);
    // The source entry point already carries an executable shebang. esbuild
    // preserves it, so only inject createRequire for bundled CommonJS
    // dependencies such as yaml; do not add another shebang. Bundled once and
    // written to its single consumer location — no second identical build.
    const requireBanner = 'import { createRequire as __createRequire } from "node:module"; const require = __createRequire(import.meta.url);';
    // codex-install.js dynamically imports this very module (build-codex.mjs,
    // which pulls in the esbuild package) to trigger install-time plugin
    // generation from an unbundled source/npm-package checkout. That branch
    // never runs from inside a bundled plugin cache (it is gated on
    // `!pluginRoot`), so keep esbuild and this script external instead of
    // letting esbuild bundle a build tool — and a transitive copy of
    // itself — into the runtime it produces.
    const bundleOptions = { bundle: true, platform: "node", format: "esm", target: "node20", preserveSymlinks: true, external: ["esbuild", "../scripts/build-codex.mjs"] };
    await build({ ...bundleOptions, entryPoints: [join(root, "src", "cli.js")], outfile: join(runtime, "muster.mjs"), banner: { js: requireBanner } });
    const sharedMcpSource = readFileSync(join(root, "cowork", "mcp-server.mjs"), "utf8");
    const codexMcpSource = sharedMcpSource
      .replace("muster MCP server — exposes muster's deterministic CLI brain as MCP tools for Claude Cowork.", "muster MCP server — exposes muster's deterministic CLI brain as MCP tools for Codex.")
      .replace("Running muster here: you have these MCP tools plus your own subagent dispatch (parallel fan-out and per-call model override both work). No skills or slash commands, so follow this protocol directly.", "Running Muster in Codex: use the bundled $muster-* skills for orchestration and these MCP tools for deterministic routing, gates, scoring, and wave computation.")
      .replace('{ argv: ["capabilities", "--cowork"], ...S("Resolve every muster role to its best-available provider, fallback chain, and model tier, against Cowork\'s MCP registry (local servers + extensions; declare remote connectors via MUSTER_COWORK_CONNECTORS). Resolution is MCP-only unless MUSTER_COWORK_NATIVE_PLUGIN declares that Cowork\'s own plugin loader accepted muster\'s plugin/ tree (unverified without a live session -- a declared capability check, not a probe).", "home", false) }', '{ argv: ["capabilities", "--codex"], ...S("Resolve every Muster role against enabled Codex plugins, skills, MCP servers, and custom-agent profiles.", "home", false) }')
      .replace('muster_assess: { argv: ["assess"]', 'muster_assess: { argv: ["assess", "--codex"]')
      // codex-mcp-surface-gaps: muster_capabilities_roles resolves through the SAME
      // capabilities.js catalog-selection code path as muster_capabilities above, so it
      // needs the identical --cowork -> --codex swap or it would reintroduce the exact
      // 2026-07-18 dogfood regression (MUSTER_RUNTIME/--cowork resolving against the wrong
      // registry) through this new sibling tool instead.
      .replace('argv: ["capabilities", "--cowork", "--roles-only"]', 'argv: ["capabilities", "--codex", "--roles-only"]')
      // Regression (2026-07-18 Codex dogfood): the shared source spawns every
      // CLI child with MUSTER_RUNTIME: "cowork" (correct for the Cowork
      // bundle -- src/capabilities.js's `cowork` OR-clause is the declared
      // signal a nested CLI child otherwise has no other way to observe). But
      // that same OR-clause honors the env over the `--codex` flag this
      // bundle's tools/list adapters above already switched to, so the
      // Codex-bundled server poisoned every role's resolution to inline. Only
      // "cowork" trips that check (src/capabilities.js:39 is a strict `===
      // "cowork"`) -- verified no other branch anywhere reads
      // MUSTER_RUNTIME, so rewriting the value (rather than deleting the
      // line) is safe and keeps the env var self-documenting for the Codex
      // bundle's own nested CLI children (notably `audit`).
      .replace('env: { ...process.env, MUSTER_RUNTIME: "cowork" }', 'env: { ...process.env, MUSTER_RUNTIME: "codex" }');
    if (!codexMcpSource.includes('["capabilities", "--codex"]') || codexMcpSource.includes('["capabilities", "--cowork"]')) throw new Error("Codex MCP capability adapter was not applied");
    if (!codexMcpSource.includes('muster_assess: { argv: ["assess", "--codex"]')) throw new Error("Codex MCP assess adapter was not applied");
    if (!codexMcpSource.includes('argv: ["capabilities", "--codex", "--roles-only"]') || codexMcpSource.includes('argv: ["capabilities", "--cowork", "--roles-only"]')) throw new Error("Codex MCP capabilities-roles adapter was not applied");
    if (!codexMcpSource.includes('MUSTER_RUNTIME: "codex"') || codexMcpSource.includes('MUSTER_RUNTIME: "cowork"')) throw new Error("Codex MCP runtime-env adapter was not applied");
    await build({ ...bundleOptions, stdin: { contents: codexMcpSource, resolveDir: join(root, "cowork"), sourcefile: "mcp-server.codex.mjs" }, outfile: join(runtime, "muster-mcp.mjs") });
    write(join(plugin, "package.json"), JSON.stringify({ version: pkg.version }, null, 2) + "\n");

    write(join(plugin, ".mcp.json"), JSON.stringify({
      mcpServers: { muster: { command: "node", args: ["./runtime/muster-mcp.mjs"], cwd: "." } }
    }, null, 2) + "\n");
    write(join(plugin, ".codex-plugin", "plugin.json"), JSON.stringify({
      name: "muster", version: pkg.version,
      description: "Glass-box agentic orchestration for Codex: deterministic routing, skills, agents, pipelines, hooks, and MCP tools.",
      author: { name: "Adnova Group", email: "rnbennett@gmail.com", url: "https://github.com/Adnova-Group" },
      homepage: "https://adnova-group.github.io/muster/", repository: "https://github.com/Adnova-Group/muster", license: "Apache-2.0",
      keywords: ["orchestration", "agents", "pipelines", "mcp", "codex"], skills: "./skills/", mcpServers: "./.mcp.json",
      interface: { displayName: "Muster", shortDescription: "Glass-box agentic orchestration for Codex.", longDescription: "Muster provides deterministic routing, custom-agent profiles, pipeline workflows, and the complete MCP toolset.", developerName: "Adnova Group", category: "Productivity", capabilities: ["Read", "Write"], websiteURL: "https://adnova-group.github.io/muster/", defaultPrompt: ["Plan this feature with Muster.", "Run a Muster audit of this repository.", "Use Muster to clear this backlog."] }
    }, null, 2) + "\n");

    // Awaited (not just returned) so the `finally` below — which deletes
    // this whole staging tree — cannot run until the copy-publish below
    // (which reads from this staging tree) has actually finished. A bare
    // `return publishCodexPlugin(...)` would let `finally` fire as soon as
    // this synchronous call yields at its first internal `await`, deleting
    // the source out from under the still-pending copy.
    return await publishCodexPlugin({
      pluginsRoot: outDir,
      stagedPlugin: plugin,
      packageVersion: pkg.version,
      marketplaceTemplate: {
        name: "muster",
        interface: { displayName: "Muster" },
        plugins: [{
          name: "muster",
          // path here is a placeholder: publishCodexPlugin overwrites it with
          // codexMarketplacePluginPath(pluginsRoot) (-> "./.agents/plugins/plugin")
          // before persisting, so this literal is never the shipped value.
          source: { source: "local", path: "./plugin" },
          policy: { installation: "AVAILABLE", authentication: "ON_INSTALL" },
          category: "Productivity"
        }]
      }
    });
  } finally {
    try { rmSync(stagingRoot, { recursive: true, force: true }); } catch { /* best-effort cleanup */ }
  }
}

function rmAndCopy(source, destination, { merge = false } = {}) {
  if (!merge) rmSync(destination, { recursive: true, force: true });
  cpSync(source, destination, { recursive: true });
}

function modeSkill(name, mode) {
  return `---\nname: ${name}\ndescription: ${JSON.stringify(`Use for Muster orchestration when the user asks to ${mode.purpose}. Explicitly invoke with $${name}.`)}\n---\n\n<!-- prompt-lint-disable ANTH-ROLE-001, ANTH-FMT-001: Mode dispatcher delegates to the authoritative workflow and intentionally does not impose a second persona or output format. -->\n\n# Muster ${mode.command}\n\nUse this skill when the request needs to ${mode.purpose}. Treat the user's remaining prompt as the outcome or backlog reference.\n\n1. Read \`${"${PLUGIN_ROOT}"}/runtime/codex-skill-adapter.md\` and apply its Codex tool, named-profile dispatch, bounded-context-fork, and plugin-root bindings.\n2. Read \`${"${PLUGIN_ROOT}"}/commands/${mode.command}.md\` for the authoritative workflow and preserve its approval, isolation, escalation, and receipt gates.\n3. Use the bundled Muster MCP tools for deterministic routing, manifests, waves, scoring, and pipelines. The bundled CLI is \`node ${"${PLUGIN_ROOT}"}/runtime/muster.mjs\` when a tool is not available.\n4. Keep the shared pipeline files authoritative. Do not duplicate pipeline routing in this skill.\n\n${agentWatchProtocol}`;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = fileURLToPath(new URL("../", import.meta.url));
  const outDir = join(root, ".agents", "plugins");
  const result = await buildCodexPlugin({ root, outDir });
  process.stdout.write(`Codex plugin v${result.packageVersion} generated at ${result.pluginRoot}\n`);
}
