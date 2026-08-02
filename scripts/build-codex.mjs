import { build } from "esbuild";
import { createHash } from "node:crypto";
import {
  cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { assertRegularTree, CODEX_BUILD_INPUT_DIRS, computeCodexBuildInputDigest, generateCodexProfiles, publishCodexPlugin, resolveCodexPlugin } from "../src/codex-release.js";
import { escapeRe } from "../src/keyword.js";

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
  "muster-plan": {
    command: "plan",
    purpose: "plan one outcome, assemble and validate a crew manifest, then stop for approval",
    description: "Plan one outcome with Muster, then stop for approval."
  },
  "muster-go": {
    command: "go",
    purpose: "execute one outcome through an isolated worktree, dependency waves, gates, and a final merge decision",
    description: "Execute one Muster outcome through isolated waves and gates."
  },
  "muster-plan-backlog": {
    command: "plan-backlog",
    purpose: "plan every backlog item before any execution",
    description: "Plan a backlog with Muster before execution."
  },
  "muster-go-backlog": {
    command: "go-backlog",
    purpose: "clear a backlog with isolated item worktrees and review gates",
    description: "Clear a backlog with Muster in isolated, reviewed worktrees."
  },
  "muster-diagnose": {
    command: "diagnose",
    purpose: "reproduce, identify root cause, fix, and add a regression test",
    description: "Reproduce and fix one bug with Muster, including a regression test."
  },
  "muster-audit": {
    command: "audit",
    purpose: "run the whole-codebase audit workflow and consolidate actionable findings",
    description: "Audit a codebase with Muster and consolidate actionable findings."
  },
  "muster-design": {
    command: "design",
    purpose: "resolve canonical DESIGN.md context and run one of Muster's pinned design workflows",
    description: "Initialize, inspect, gate, or execute Muster design workflows."
  },
  "muster-runner": {
    command: "runner",
    purpose: "drive one claimed backlog item end-to-end in its own worktree in ordinary full-lifecycle mode, pushing the reviewed item branch and opening its receipts-backed PR",
    description: "Run one backlog item end to end with Muster in its own worktree."
  },
  "muster-capture": {
    command: "capture",
    purpose: "turn conversation decisions into an approval-gated backlog",
    description: "Capture decisions into an approval-gated Muster backlog."
  },
  "muster-init": {
    command: "init",
    purpose: "prepare a repository and coordinate receipted native harness initialization",
    description: "Initialize a repository for Muster's native Codex workflow."
  },
  run: {
    command: "run",
    purpose: "legacy alias of muster-plan",
    description: "Legacy alias for $muster-plan."
  },
  autopilot: {
    command: "autopilot",
    purpose: "legacy alias of muster-go",
    description: "Legacy alias for $muster-go."
  },
  sprint: {
    command: "sprint",
    purpose: "legacy alias of muster-go-backlog",
    description: "Legacy alias for $muster-go-backlog."
  }
};

function ensure(dir) { mkdirSync(dir, { recursive: true }); }
function write(path, content) { ensure(dirname(path)); writeFileSync(path, content, "utf8"); }
function normalizeLf(text) { return text.replace(/\r\n/g, "\n"); }
const codexModeNames = new Map([
  ["plan-backlog", "muster-plan-backlog"], ["go-backlog", "muster-go-backlog"],
  ["autopilot", "muster-go"], ["sprint", "muster-go-backlog"], ["run", "muster-plan"],
  ["plan", "muster-plan"], ["go", "muster-go"], ["diagnose", "muster-diagnose"],
  ["audit", "muster-audit"], ["runner", "muster-runner"], ["capture", "muster-capture"],
  ["init", "muster-init"]
]);
function translateModeNames(text) {
  let result = text;
  for (const [legacy, current] of codexModeNames) {
    result = result.replace(new RegExp(`/muster:${escapeRe(legacy)}(?![a-z-])`, "g"), `$${current}`);
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
// build-anchor-audit item: each name-set below is the known, grepped set of command
// files whose "Run-active lifecycle" boilerplate actually carries the matching literal.
// adaptCommandForCodex runs unconditionally over EVERY plugin/commands/*.md file, so a
// blanket throw-on-miss would false-positive on files that never had the phrase (e.g.
// capture.md has no scale-gate marker at all); scoping the check to the known carriers
// (same `name`-array convention already used below for the --roles-only/manifest-validate
// rewrites) keeps the guard from firing on files it was never meant to touch, while still
// failing loud if one of the CARRIER files' own copy of the sentence is reworded.
const SCALE_GATE_MARKER_FILES = ["go.md", "diagnose.md", "audit.md", "runner.md", "plan.md"];
const BATCH_SCALE_GATE_FILES = ["go-backlog.md"];
const PLAN_BACKLOG_SCALE_GATE_FILES = ["plan-backlog.md"];
const SESSION_START_CLEAR_FILES = ["go.md", "diagnose.md", "audit.md", "runner.md", "plan.md", "go-backlog.md", "plan-backlog.md"];
const backlogWaveDispatchRe = /This transition is executable and authoritative; actual Agent\/Workflow\/spawn\/wait calls remain adapter-owned\.[\s\S]*?wave-sized concurrency always stays within that ceiling\)\./;
// build-anchor-audit item: this previously anchored on a literal ending "instead of
// blocking." that go-backlog.md's own source no longer carries at all (the sentence was
// reworded to require propagated action-fence markers and reject `agent_id` exemptions)
// -- a pre-existing silent no-op this audit's throw-on-miss caught live. Anchored on the
// stable "Runner cwd..."/marker prefix through the sentence's "action fence." close,
// and scoped to leave the FOLLOWING worktree-removal/node_modules-bootstrap sentences
// (harness-neutral, no PreToolUse/hook content) untouched.
const runnerCwdRe = /Runner cwd is its worktree, and the preflight above copies regular `[.]muster\/run-active`[\s\S]*?do not bypass the action fence\./;
const backlogFencePropagationRe = /Before dispatching any writer, propagate the batch fence[\s\S]*?the worker stops or its wave reaches the barrier\.\n/;
const captureWritesRe = /capture only ever writes[\s\S]*?deliberately omitted\./i;
// adapt-command-file-arrays item (PR #163 reviewer nit): the four arrays above
// are hand-maintained -- a NEW command file adopting the same boilerplate would
// silently miss their fail-loud anchor protection (the replaceAll would still
// translate it, but a later rewording of ITS copy could no-op unguarded).
// Inverse coverage check: a command file CARRYING a marker must be LISTED for
// it, or the build stops and names the array to update.
const COMMAND_MARKER_COVERAGE = [
  ["the `PreToolUse` hook uses to scope the scale-gate", SCALE_GATE_MARKER_FILES, "SCALE_GATE_MARKER_FILES"],
  ["the whole batch counts as ONE run for the `PreToolUse` hook's scale-gate scoping", BATCH_SCALE_GATE_FILES, "BATCH_SCALE_GATE_FILES"],
  ["the whole plan-backlog invocation counts as ONE run for the `PreToolUse` hook's scale-gate scoping", PLAN_BACKLOG_SCALE_GATE_FILES, "PLAN_BACKLOG_SCALE_GATE_FILES"],
  ["`SessionStart` on a fresh session clears a stale marker automatically.", SESSION_START_CLEAR_FILES, "SESSION_START_CLEAR_FILES"],
];
// codex-dispatch-single-source item (audit 2026-07-29, slice D): the skill split left TWO
// maintained copies of the Codex dispatch contract -- the wholesale-replacement texts below
// and the canonical reference (plugin/skills/orchestrator/references/codex-dispatch.md) --
// and they had already drifted: the reference called a positive fork_turns string "the
// useful middle" while the replacement texts permitted one "only when the user explicitly
// requests it", and the shipped prose hardcoded v2-only `collaboration.spawn_agent` for
// every role while the reference's per-model table puts muster's core tier gpt-5.6-luna on
// `multi_agent_v1`. The reference is now the SINGLE source: both blocks are extracted
// VERBATIM at build time and embedded into the replacement texts, so the shipped Codex
// prose carries the reference's exact contract and can never silently diverge again.
// Throw-on-miss, same posture as every other anchor in this file. The reference lives
// under plugin/ (a CODEX_BUILD_INPUT_DIRS entry), so the skip-if-current input digest
// observes every edit to it.
function loadCodexDispatchContract(root) {
  // Git may materialize text inputs with CRLF on Windows. Normalize this
  // canonical prose source before locating paragraph boundaries so generated
  // artifacts remain host-independent and the LF-only blank-line delimiter
  // cannot reject an otherwise identical Windows checkout.
  const ref = normalizeLf(readFileSync(join(root, "plugin", "skills", "orchestrator", "references", "codex-dispatch.md"), "utf8"));
  const extract = (startMarker, label) => {
    const start = ref.indexOf(startMarker);
    const end = start < 0 ? -1 : ref.indexOf("\n\n", start);
    if (start < 0 || end < 0) throw new Error(`codex-dispatch reference ${label} block not found`);
    return ref.slice(start, end);
  };
  const forkTurns = extract("`fork_turns` (v2 only)", "fork_turns contract");
  const shapesTable = extract("| | v2 (`sol`, `terra`)", "v1/v2 shapes table");
  if (!forkTurns.includes("explicitly requests") || !forkTurns.includes('never use `"all"`')) {
    throw new Error("codex-dispatch reference fork_turns contract lost its quota-policy sentence");
  }
  if (!shapesTable.includes("multi_agent_v1.spawn_agent")) {
    throw new Error("codex-dispatch reference v1/v2 shapes table lost the v1 shape");
  }
  const contract = { forkTurns, shapesTable };
  return { ...contract, watchProtocol: buildAgentWatchProtocol(root, contract) };
}
// codex-watch-protocol-v1 item (audit 2026-07-30, slice S1): slice D above threaded the
// v1/v2 contract into the orchestrator's wave-dispatch span and the go-backlog registry
// fallback ONLY. The agent watch protocol -- injected into all 13 mode skills, the root
// router, the orchestrator's enforcement section, and shipped as the copied
// runtime/codex-skill-adapter.md -- kept hardcoding v2-only `collaboration.spawn_agent`/
// `wait_agent`/`list_agents`, so a Codex session on muster's CORE tier (gpt-5.6-luna, which
// the catalog puts on v1) was taught tool names its own model rejects, plus `fork_turns`
// where v1 takes a `fork_context` bool and a targets-less wait where v1 requires `targets[]`.
//
// Two copies collapse into one here. codex/skill-adapter.md's own "## Agent watch invariant"
// section is now the SINGLE source of the watch prose (it used to be hand-mirrored by a
// literal const in this file -- byte-identical by convention only), and the reference's
// v1/v2 shapes table is embedded into it VERBATIM, exactly as slice D does for the
// orchestrator. Every anchor is throw-on-miss: edit the prose in codex/skill-adapter.md and
// the shapes in references/codex-dispatch.md; never re-paraphrase either here. Both files
// sit under CODEX_BUILD_INPUT_DIRS entries, so the skip-if-current input digest observes
// every edit to them.
const WATCH_HEADING = "## Agent watch invariant";
function buildAgentWatchProtocol(root, contract) {
  const adapter = normalizeLf(readFileSync(join(root, "codex", "skill-adapter.md"), "utf8"));
  const start = adapter.indexOf(WATCH_HEADING);
  if (start < 0) throw new Error("codex/skill-adapter.md agent-watch section not found");
  const next = adapter.indexOf("\n## ", start + WATCH_HEADING.length);
  const source = (next < 0 ? adapter.slice(start) : adapter.slice(start, next)).trimEnd() + "\n";
  const lintDirective = source.match(/^<!-- prompt-lint-disable GUARD-IDK-001:[\s\S]*?-->\n/m);
  if (!lintDirective) throw new Error("codex/skill-adapter.md agent-watch lint directive not found");
  const versionPreamble = `\n**The dispatch and barrier shapes are VERSION-DEPENDENT**: Codex resolves its subagent API per MODEL from the catalog's \`multi_agent_version\`, so never hardcode one shape -- resolve the version from each dispatched role's model and fail closed to v1 rather than guessing v2. The v2 names below are shorthand for the resolved call: on a v1 model every \`collaboration.*\` call is its \`multi_agent_v1.*\` counterpart, and \`multi_agent_v1.wait_agent\` requires the \`targets[]\` of the ids being waited on.\n\n${contract.shapesTable}\n`;
  let result = source.replace(lintDirective[0], `${lintDirective[0]}${versionPreamble}`);
  const retainAnchor = "retain every canonical agent id returned by `collaboration.spawn_agent`.";
  if (!result.includes(retainAnchor)) throw new Error("codex/skill-adapter.md agent-watch dispatch/barrier anchor not found");
  result = result.replace(
    retainAnchor,
    "retain every canonical agent id returned by the version-resolved spawn -- `collaboration.spawn_agent` on v2, `multi_agent_v1.spawn_agent` on v1."
  );
  const spawnDefaultAnchor = "Spawn with `fork_turns: \"none\"` unless the user explicitly requests a context fork.";
  if (!result.includes(spawnDefaultAnchor)) throw new Error("codex/skill-adapter.md agent-watch spawn-default anchor not found");
  result = result.replace(
    spawnDefaultAnchor,
    "Spawn with `fork_turns: \"none\"` on v2 (`fork_context: false` on v1) unless the user explicitly requests a context fork."
  );
  return result;
}
// codex-watch-protocol-v1 item (audit 2026-07-30, slice S1): the adapter used to be copied
// byte-for-byte into the bundle, shipping a v2-only `collaboration.spawn_agent` dispatch
// bullet and a v2-only watch section to every ported workflow that reads it. Its dispatch
// bullet now carries the reference's fork_turns contract verbatim (same block go-backlog and
// the orchestrator get) and its watch section is replaced by the single-sourced protocol
// above, so all 15 watch surfaces ship one identical, version-resolved contract.
function adaptSkillAdapterForCodex(text, contract) {
  text = normalizeLf(text);
  const dispatchAnchor = "call `collaboration.spawn_agent` with the ordinary `task_name`, `message`, `fork_turns: \"none\"`, and `agent_type: \"<exact chosen.id>\"`. A positive context fork is allowed only when the user explicitly requests one; never use `\"all\"`.";
  if (!text.includes(dispatchAnchor)) throw new Error("codex/skill-adapter.md named-profile dispatch anchor not found");
  const result = text.replace(
    dispatchAnchor,
    "call the model-version-resolved spawn -- `collaboration.spawn_agent` on v2 models, `multi_agent_v1.spawn_agent` on v1, resolved per the role's model from the catalog's `multi_agent_version`, never hardcoded to one shape (the dispatch/barrier shapes table is in the watch invariant below) -- with the ordinary `task_name`, `message`, `fork_turns: \"none\"` on v2 (v1 takes `fork_context: false`), and `agent_type: \"<exact chosen.id>\"`. " + contract.forkTurns
  );
  const start = result.indexOf(WATCH_HEADING);
  if (start < 0) throw new Error("codex/skill-adapter.md agent-watch section not found");
  const next = result.indexOf("\n## ", start + WATCH_HEADING.length);
  if (next >= 0) throw new Error("codex/skill-adapter.md agent-watch section is no longer the final section -- retarget this replacement");
  return result.slice(0, start) + contract.watchProtocol;
}
function adaptCommandForCodex(text, name, contract) {
  text = normalizeLf(text);
  for (const [marker, files, arrayName] of COMMAND_MARKER_COVERAGE) {
    if (text.includes(marker) && !files.includes(name)) {
      throw new Error(`${name}: carries the ${arrayName} boilerplate but is not listed in ${arrayName} -- add it so its anchor stays fail-loud`);
    }
  }
  if (SCALE_GATE_MARKER_FILES.includes(name) && !text.includes("the `PreToolUse` hook uses to scope the scale-gate")) throw new Error(`${name}: run-active scale-gate anchor not found for Codex rewrite`);
  if (BATCH_SCALE_GATE_FILES.includes(name) && !text.includes("the whole batch counts as ONE run for the `PreToolUse` hook's scale-gate scoping")) throw new Error(`${name}: batch scale-gate anchor not found for Codex rewrite`);
  if (PLAN_BACKLOG_SCALE_GATE_FILES.includes(name) && !text.includes("the whole plan-backlog invocation counts as ONE run for the `PreToolUse` hook's scale-gate scoping")) throw new Error(`${name}: plan-backlog scale-gate anchor not found for Codex rewrite`);
  if (SESSION_START_CLEAR_FILES.includes(name) && !text.includes("`SessionStart` on a fresh session clears a stale marker automatically.")) throw new Error(`${name}: SessionStart stale-marker anchor not found for Codex rewrite`);
  if (name === "go-backlog.md" && !backlogWaveDispatchRe.test(text)) throw new Error(`${name}: complete wave-dispatch anchor not found for Codex rewrite`);
  if (name === "go-backlog.md" && !runnerCwdRe.test(text)) throw new Error(`${name}: runner-cwd anchor not found for Codex rewrite`);
  if (name === "go-backlog.md" && !backlogFencePropagationRe.test(text)) throw new Error(`${name}: action-fence propagation anchor not found for Codex rewrite`);
  if (name === "capture.md" && !captureWritesRe.test(text)) throw new Error(`${name}: capture-writes anchor not found for Codex rewrite`);
  let result = translatePluginPaths(translateCodexProse(text))
    .replaceAll("the `PreToolUse` hook uses to scope the scale-gate", "Muster's Codex lifecycle hooks use for state diagnostics")
    .replaceAll("the whole batch counts as ONE run for the `PreToolUse` hook's scale-gate scoping", "the whole batch counts as ONE run for Muster's Codex lifecycle diagnostics")
    .replaceAll("the whole plan-backlog invocation counts as ONE run for the `PreToolUse` hook's scale-gate scoping", "the whole plan-backlog invocation counts as ONE run for Muster's Codex lifecycle diagnostics")
    .replaceAll("`SessionStart` on a fresh session clears a stale marker automatically.", "Codex hooks never delete state markers automatically; on startup, verify and clear only a marker proven stale and owned by the interrupted workflow.")
    .replace(backlogWaveDispatchRe, "This transition is executable and authoritative; Codex production actions are adapter-owned process members. Construct one complete `wave.json` whose members carry the emitted item id, `agentType: \"muster-runner\"`, runner brief as `prompt`, and a distinct freshly created registered linked worktree as `cwd`, then run `node ${PLUGIN_ROOT}/runtime/muster.mjs codex-wave <wave.json> --repository-root <trusted repo root> --base-sha <exact full base SHA>`. Production waves are process-only; never invoke a shared-CWD or inline dispatch path from the backlog or manifest. The runtime authenticates every pristine worktree, loads and digests the installed `muster-runner` policy, pins its model, effort, sandbox, and developer instructions outside the manifest, and owns the all-process barrier; treat missing provenance or any process failure as an item failure. Put the scheduler's cap in `maxConcurrentThreadsPerSession`; the runtime clamps it to trusted Codex capacity.")
    .replace(runnerCwdRe, "Runner cwd is its recorded worktree. Codex hooks provide diagnostics but do not replace the worktree path/base-SHA proof or the post-wave ownership check.")
    .replace(backlogFencePropagationRe, "Do not copy `.muster/run-active` or `.muster/forbidden-actions` into process member worktrees: sealed `codex-wave` admission rejects every ignored artifact. Write the validated fixed-vocabulary member action sets to the separate no-follow fence document; the runtime injects and receipts that policy outside the user brief.\n")
    .replace(captureWritesRe, "Capture only writes the explicitly approved `.muster/backlog.md` bookkeeping artifact and dispatches no write-capable wave, so it deliberately has no run-active lifecycle.");
  if (name === "init.md") {
    const claudeResolver = [
      'if [ -n "$CLAUDE_PLUGIN_ROOT" ] && [ -f "${PLUGIN_ROOT}/runtime/muster.mjs" ]; then',
      '  MUSTER_CLI="node ${PLUGIN_ROOT}/runtime/muster.mjs"',
      'elif [ -n "$PLUGIN_ROOT" ] && [ -f "$PLUGIN_ROOT/runtime/muster.mjs" ]; then',
      '  MUSTER_CLI="node $PLUGIN_ROOT/runtime/muster.mjs"'
    ].join("\n");
    const codexResolver = [
      'if [ -n "$PLUGIN_ROOT" ] && [ -f "${PLUGIN_ROOT}/runtime/muster.mjs" ]; then',
      '  MUSTER_CLI="node ${PLUGIN_ROOT}/runtime/muster.mjs"'
    ].join("\n");
    if (!result.includes(claudeResolver)) throw new Error("init CLI resolver section not found");
    result = result.replace(claudeResolver, codexResolver);
    const coordinatorBoundary = "You are muster's initialization coordinator. Deterministic project learning and";
    if (!result.includes(coordinatorBoundary)) throw new Error("init coordinator boundary not found");
    result = result.replace(
      coordinatorBoundary,
      "You are muster's initialization coordinator. The generated project profile is provider/model-neutral. Deterministic project learning and"
    );
  }
  if (["plan.md", "go.md", "plan-backlog.md"].includes(name)) {
    if (!result.includes("capabilities --codex")) throw new Error(`${name}: capabilities --codex anchor not found for Codex roles-only rewrite`);
    result = result.replaceAll("capabilities --codex", "capabilities --codex --roles-only");
  }
  if (["go-backlog.md", "plan-backlog.md"].includes(name)) {
    const sprintWavesAnchor = "JSON is authoritative";
    const anchorIndex = result.indexOf(sprintWavesAnchor);
    if (anchorIndex < 0) throw new Error(`${name}: sprint-waves result anchor not found for Codex ceiling binding`);
    const lineEnd = result.indexOf("\n", anchorIndex);
    if (lineEnd < 0) throw new Error(`${name}: sprint-waves result line has no insertion boundary`);
    const ceilingBinding = "\n   - **Codex ceiling binding:** for every Codex `sprint-waves` call in this mode, append `--max-concurrent-threads-per-session <effective agents.max_concurrent_threads_per_session>`. The explicit value carries Codex's project/profile/CLI precedence into the deterministic schedule; the user `$CODEX_HOME/config.toml` read is only a fallback when no effective value is supplied.";
    result = result.slice(0, lineEnd) + ceilingBinding + result.slice(lineEnd);
  }
  const cli = `node ${"${PLUGIN_ROOT}"}/runtime/muster.mjs`;
  if (["go.md", "diagnose.md", "audit.md"].includes(name)) {
    if (!result.includes(`${cli} manifest validate --codex`)) throw new Error(`${name}: manifest validate --codex anchor not found for Codex rewrite`);
    result = result.replaceAll(
      `${cli} manifest validate --codex`,
      `${cli} manifest validate .muster/manifest.json --codex`
    );
  }
  if (name === "diagnose.md") {
    if (!result.includes("-> `{mode, manifest}`.")) throw new Error("diagnose.md seed-output anchor not found for Codex rewrite");
    if (!result.includes("Write the manifest to `.muster/manifest.json`")) throw new Error("diagnose.md manifest-write anchor not found for Codex rewrite");
    result = result
      .replace("-> `{mode, manifest}`.", "prints `{mode, manifest}` JSON to stdout.")
      .replace("Write the manifest to `.muster/manifest.json`", "Extract the emitted `manifest` object and write that object to `.muster/manifest.json`");
  }
  if (name === "audit.md") {
    if (!result.includes("` -> Crew Manifest at `.muster/manifest.json`")) throw new Error("audit.md seed-output anchor not found for Codex rewrite");
    if (!result.includes("in parallel via the best available provider per dimension")) throw new Error("audit.md parallel-sweep anchor not found for Codex rewrite");
    if (!result.includes("running parallel dimension sweeps")) throw new Error("audit.md running-parallel-sweeps anchor not found for Codex rewrite");
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
      "   Dispatch these three briefs concurrently when the configured Codex capacity permits, otherwise in dependency-free batches. Respect `agents.max_concurrent_threads_per_session`; neither lower nor raise it. Every worker uses `fork_turns: \"none\"`, a 25-step ceiling, focused commands only, and one concise receipt. Add prompt-quality as a fourth read-only brief only when the scoped diff changes prompts or agent instructions. Consolidation is forbidden until each required dimension has a receipt."
    ].join("\n");
    result = result.slice(0, sweepStart) + capacitySweep + "\n" + result.slice(boardStart);
  }
  if (name === "runner.md") {
    // The Claude lane's Scheduling section discusses Claude-only harness primitives with no
    // Codex equivalent: as settled by backlog item loop-dmi-conflict, native `/loop` is
    // documented-inert against this `disable-model-invocation: true` command (v2.1.196), and
    // `/goal` is named as the native condition-based self-continuing alternative. Both `/loop`
    // and `/goal` (and the earlier `harness-goal-primitives` self-pacing framing) are Claude-only,
    // so the whole paragraph is wholesale-replaced (not merely translated) with a fixed
    // Codex-specific paragraph naming the recurrence gap explicitly and keeping the pre-existing
    // cron/automation guidance. Anchored + asserted, matching the audit.md dimension-sweep
    // and coordination Standing-context-preflight wholesale-replace convention above.
    const schedStart = result.indexOf("**Scheduling**");
    const schedEnd = result.indexOf("\n\nGlass box:", schedStart);
    if (schedStart < 0 || schedEnd < 0) throw new Error("runner.md Scheduling section anchor not found");
    const codexScheduling = "**Scheduling** — fire `$muster-runner` from a Codex automation on a timer, or from cron invoking the Codex CLI (e.g. `codex exec \"$muster-runner issues:agent:todo\"`). Codex has no equivalent recurrence primitive, so a fixed cadence is the only mechanism here: match the backlog's arrival rate, not faster — an idle cycle is cheap, but firing far ahead of new items just piles up idle receipts; start around 15-30 minutes and widen if idle cycles dominate the ledger, tighten if items queue up unclaimed. Safety inventory: pr-only (step 4 never merges/pushes to base), the 2-failure retry cap bounds reclaim loops, and the claim lock (Binding A's comment-race window / Binding B's claim-then-verify) makes concurrent firing safe alongside `$muster-go-backlog`, other scheduled runners, and humans on the same backlog.";
    result = result.slice(0, schedStart) + codexScheduling + result.slice(schedEnd);
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
  result = result.replaceAll(
    "codex-wave <wave.json> --repository-root",
    "codex-wave <wave.json> --fence-file <trusted no-follow action-fence.json> --repository-root",
  );
  return result;
}
function adaptCoordinationForCodex(text) {
  const start = text.indexOf("## Standing-context preflight");
  const end = text.indexOf("## Binding A", start);
  if (start < 0 || end < 0) throw new Error("coordination standing-context section not found");
  const section = `## Standing-context preflight\n\nThe installed Codex plugin cache is not a Git checkout, so do not run \`git log\` against plugin paths. At the first read in a runner cycle, record the plugin version from \`${"${PLUGIN_ROOT}"}/package.json\` and a SHA-256 fingerprint over these installed behavior paths: \`internal-skills/coordination/SKILL.md\`, \`commands/go-backlog.md\`, \`commands/go.md\`, and \`commands/runner.md\`. Compute the fingerprint with the host's available SHA-256 tool, sorting paths before hashing. Muster's Codex hooks are installed outside the plugin cache: also locate the selected managed runtime at the git root's \`.codex/muster/hooks/\` or \`$CODEX_HOME/muster/hooks/\` and fingerprint its files plus the sibling Muster ownership manifest. If neither managed hook runtime can be proven, say "I don't know whether the standing context is unchanged," leave a HUMAN-HOLD receipt, and stop.\n\nBefore a later claim or resume in the same cycle, recompute both fingerprints. Unchanged version and fingerprints proceed. Any change means the installed standing context changed or was tampered with during the cycle: leave a HUMAN-HOLD receipt naming the old/new version and hashes, preserve the claim state, and stop. A packaged plugin cannot safely classify such an in-place mutation as confined because there is no authoritative Git history in the cache. A newly started cycle reads the newly installed immutable version and managed hook runtime as its fresh baseline.\n\n`;
  return text.slice(0, start) + section + text.slice(end);
}
// The agent watch protocol is single-sourced from codex/skill-adapter.md's own
// "## Agent watch invariant" section and version-threaded by buildAgentWatchProtocol above
// (audit 2026-07-30, slice S1) -- it used to live here as a literal const kept
// byte-identical to that section by hand, with no single source of truth and a v2-only
// dispatch/barrier shape. The watch itself is state-based: provider-reported `running` is
// authoritative positive liveness, while terminal/non-running states and explicit stop
// conditions are handled deterministically.
// build-anchor-audit item: this previously anchored on the orchestrator's OLD "**Hard
// gate:**" bullet, describing a real hook-enforced wave-guard deny. Commit 424fcb1
// (refactor(hooks): enforcement follows the run) removed that deny mechanism entirely
// and renamed the bullet to "**SKILL discipline, not a hook block:**" months before this
// audit -- the regex has been silently no-opping ever since, shipping the Claude-only
// "field-proven wave-guard deny was removed (... see CHANGELOG)" historical narrative
// unrewritten into the Codex bundle. Retargeted to the current bullet, tolerant of
// further wording drift between the heading and its closing cross-reference.
const orchestratorHardGateRe = /- \*\*SKILL discipline, not a hook block:\*\*[\s\S]*?"Enforcement model", below\.\)\n/;
function adaptOrchestratorForCodex(text, contract) {
  // Every literal/regex anchor in this function has exactly one possible source
  // (plugin/skills/orchestrator/SKILL.md — the only body ever passed here), so each
  // throw-on-miss check below needs no name-based scoping, unlike adaptCommandForCodex's
  // multi-file anchors above.
  if (!orchestratorHardGateRe.test(text)) throw new Error("orchestrator Hard gate section not found for Codex rewrite");
  let result = text.replace(orchestratorHardGateRe, "- **SKILL discipline, not a hook block:** Codex hooks cannot reliably deny a main-loop Edit/Write during a wave either -- there was never a hard wave-guard deny to remove here, unlike Claude Code's field-tested and since-removed version (unscopable false positives; see CHANGELOG). This rule lives here, plus the review gate diffing what changed against what was dispatched after the fact -- a caught violation is a review-gate finding, not a blocked tool call. (Codex's `PreToolUse` hook still surfaces exactly one policy warning, unrelated to this rule -- see \"Codex enforcement model\", below.)\n");
  const ironDispatchRe = /- \*\*Before you Edit or Write ANY file during a wave,[\s\S]*?Edited files with no dispatch line in STATE is, by definition, drift\.\n/;
  if (!ironDispatchRe.test(result)) throw new Error("orchestrator iron dispatch rule not found for Codex rewrite");
  result = result.replace(ironDispatchRe, "- **Before you Edit or Write ANY file during a wave, the complete process member MUST be recorded in `wave.json` and launched through `codex-wave`.** About to edit in the main loop? STOP -- that is inline drift.\n- **Announce before acting:** write `dispatching <task id> -> process-wave (<role>)` to STATE before launch. Edited files with no process-wave dispatch line are drift.\n");
  const implementerAnchor = "one implementer agent, given the task + the Crew Manifest as BRIEF.";
  if (!result.includes(implementerAnchor)) throw new Error("orchestrator implementer-agent anchor not found for Codex rewrite");
  result = result.replace(
    implementerAnchor,
    "one process-wave member, given a minimal prompt: task id/text, relevant success criteria, absolute worktree/manifest/STATE paths, owned and frozen paths, dependency receipts, required provider or skill brief, and the return contract. Never attach unrelated plan items, capability inventories, or prior transcripts."
  );
  const dispatchIntroRe = /Dispatch every task in the wave \*\*concurrently\*\*[\s\S]*?keep every rule below unchanged\):/;
  if (!dispatchIntroRe.test(result)) throw new Error("orchestrator wave dispatch intro not found for Codex rewrite");
  result = result.replace(dispatchIntroRe, "Build the complete process manifest before launch, then invoke `node ${PLUGIN_ROOT}/runtime/muster.mjs codex-wave <wave.json> --repository-root <trusted repo root> --base-sha <exact full base SHA>` once. The runtime owns bounded concurrency and the all-process barrier:");
  result = result.replaceAll(
    "codex-wave <wave.json> --repository-root",
    "codex-wave <wave.json> --fence-file <trusted no-follow action-fence.json> --repository-root",
  );
  const worktreeIsolationAnchor = "give each its own git worktree (`isolation: \"worktree\"` on the Codex subagent dispatcher)";
  if (!result.includes(worktreeIsolationAnchor)) throw new Error("orchestrator worktree-isolation anchor not found for Codex rewrite");
  result = result.replace(worktreeIsolationAnchor, "create a separate pristine registered linked worktree for each task, bind that absolute path to exactly one process-wave member, and record the path/base SHA in its prompt");
  const readOnlySkip = "Read-only/single-task waves skip worktree creation, but any\n        writer that already runs in another cwd still receives this same propagation.";
  if (!result.includes(readOnlySkip)) throw new Error("orchestrator read-only worktree skip anchor not found for Codex rewrite");
  result = result.replace(readOnlySkip, "Every production member, including a read-only or single-task member, requires its own pristine registered linked worktree. The sealed process lane rejects ignored artifacts, so never copy `.muster/run-active` or `.muster/forbidden-actions` into a member worktree. Supply each validated action set through the separate no-follow fence document.");
  const isolatedFenceRe = /Before dispatch, propagate the\n        active action fence[\s\S]*?after the worker has stopped\. /;
  if (!isolatedFenceRe.test(result)) throw new Error("orchestrator isolated action-fence propagation anchor not found for Codex rewrite");
  result = result.replace(isolatedFenceRe, "The sealed process worktree remains free of ignored `.muster` marker files; the no-follow fence document is the runtime-authenticated action-policy source. ");
  const actionFenceCopyRe = /The hook resolves\nthese files from the tool payload's cwd,[\s\S]*?then remove the propagated files only after that worker stops or at the wave barrier\./;
  if (!actionFenceCopyRe.test(result)) throw new Error("orchestrator action-fence copy anchor not found for Codex rewrite");
  result = result.replace(actionFenceCopyRe, "For Codex process members, write the effective fixed-vocabulary action sets to the separate no-follow fence document. The runtime validates exact member coverage, injects the set separately from the user brief, and receipts its digest. Never copy outer run markers into a sealed member worktree, because admission rejects all ignored artifacts.");
  // build-anchor-audit item: this .replaceAll's target ("after a Claude Code restart") lived in
  // step 4a's old, verbose "Generic-subagent fallback (degraded path)" bullet. The prose-cutting
  // pass (commit 3b0b4d7, "cut prose 48.3%, no rule dropped") condensed that whole bullet down to
  // "the type isn't dispatchable yet in this session (plugin installed mid-session)" -- already
  // harness-neutral, with no "Claude Code"/"restart" wording left anywhere in the file to translate.
  // The transform has had nothing to match since that commit; a throw-on-miss here would only ever
  // fire (the condensed concept is legitimately gone, not merely reworded), so it is removed rather
  // than forced against unrelated text -- verified via `grep -n restart plugin/skills/orchestrator/SKILL.md`
  // finding no remaining occurrence anywhere in the file.
  //
  // build-anchor-audit item: these two `.replace` targets described the wave-active marker as
  // something "the `PreToolUse` hook reads ... to enforce the iron rule" / "treats ... as stale
  // and applies the scale-gate" -- both claims commit 424fcb1 (refactor(hooks): enforcement
  // follows the run) made FALSE and removed from the source: step 4a's wave-active bullet now
  // explicitly says the marker is "glass-box bookkeeping only, not hook-enforced" with no
  // stale/scale-gate framing left anywhere in the file (verified by grep). Nothing remains here
  // to translate for Codex -- both transforms are removed rather than forced against unrelated
  // text, same reasoning as the "after a Claude Code restart" removal just above.
  const denyMatchingAnchor = "the `PreToolUse` hook reads this\nfile to deny matching tool calls";
  if (!result.includes(denyMatchingAnchor)) throw new Error("orchestrator deny-matching anchor not found for Codex rewrite");
  result = result.replaceAll(denyMatchingAnchor, "the trusted Codex `PreToolUse` hook reads this\nfile to surface supported policy warnings for matching tool calls");
  // kimi-subagent-resume-retry item: the step-4a "Subagent failure" bullet's Kimi
  // native-resume branch ships verbatim into this build (it sits below the
  // `      - **Subagent failure` anchor, outside every wholesale-replace span),
  // and the upstream word-swap rewrites its "the Agent tool's `resume`" into
  // "the Codex subagent dispatcher's `resume`" -- fabricating a Codex resume
  // primitive that does not exist (spawn_agent has no resume field; there is no
  // AgentSwarm on this harness). On Codex the generic fresh re-dispatch IS the
  // whole rule, so replace the entire Kimi clause with exactly that. Guarded:
  // if the Claude-side clause drifts and this stops matching, fail the build
  // rather than ship the fabricated claim.
  const kimiResumeClause = /\*\*On Kimi the re-dispatch is\s+a native RESUME, never a fresh spawn\*\*[\s\S]*?Non-Kimi harnesses keep the fresh re-dispatch\.\s+/;
  if (!kimiResumeClause.test(result)) throw new Error("orchestrator Kimi resume clause not found for Codex rewrite");
  result = result.replace(kimiResumeClause, "Retry the failed member once in a fresh bounded process-wave invocation with the error appended; never switch lanes.\n        ");
  if (result.includes("Codex subagent dispatcher's `resume`")) throw new Error("orchestrator Kimi resume clause leaked into the Codex build");
  // kimi-native-steer-binding item: the Channel steering section's Kimi
  // paragraph ships verbatim into this build (the section sits above the
  // enforcement-cut below, outside every wholesale-replace span) and would
  // tell a Codex-hosted run to deliver steers through Kimi's steer queue /
  // Wire / ACP / `kimi web` routes -- mechanisms that do not exist on this
  // harness. On Codex a steering message arrives as ordinary user input and
  // the classify-and-map rule above the paragraph is the whole story, so
  // replace the paragraph with exactly that. Guarded: if the Claude-side
  // paragraph drifts and this stops matching, fail the build rather than ship
  // the fabricated claim.
  const kimiSteerParagraph = /\*\*On Kimi the same message arrives through the harness's native steer seam\.\*\*[\s\S]*?it does not open the connection itself\.\n/;
  if (!kimiSteerParagraph.test(result)) throw new Error("orchestrator Kimi steer paragraph not found for Codex rewrite");
  result = result.replace(kimiSteerParagraph, "**On this harness there is no native between-steps steer seam:** a steering message arrives as ordinary user input -- classify it with the bundled runtime's `steer` verb and apply the mapping above unchanged.\n");
  if (result.includes("prompts::steer") || result.includes("prompts:steer")) throw new Error("orchestrator Kimi steer paragraph leaked into the Codex build");
  const providerStart = result.indexOf("      - **Provider kind:**");
  const failureStart = result.indexOf("      - **Subagent failure", providerStart);
  if (providerStart < 0 || failureStart < 0) throw new Error("orchestrator provider/model section not found");
  const provider = `      - **Provider and model policy:** every production member is exactly \`agentType: "muster-runner"\`; the manifest cannot select a model, effort, sandbox, read-only flag, or developer instructions. Put only the item brief into \`prompt\` and its distinct pristine registered worktree into \`cwd\`. Never call a subagent API from this production-wave step. Include a 25-step ceiling, one-follow-up maximum, focused-test-first rule, absolute manifest/STATE paths, owned and frozen paths, dependency receipts, and the return contract in the prompt. Assemble all members before invoking \`codex-wave\`; trusted repository root/base SHA stay out of the manifest and are passed only as CLI flags. The runtime loads and digests its installed \`muster-runner\` instructions, pins the role's model, effort, and workspace-write sandbox, applies the trusted thread ceiling, launches every member with hermetic \`codex exec -C\`, and owns the barrier. Preserve each returned opaque \`receiptId\`; the authenticated binding stays in an owner-only runtime store, every thread uses a private persistent Codex home, the real Codex home and sibling sessions are masked from worker tools, and returned JSONL redacts the thread UUID.\n`;
  const compactProvider = provider.replace(
    "look up the role's chosen provider from `node ${PLUGIN_ROOT}/runtime/muster.mjs capabilities --codex`.",
    "look up only the needed role with `node ${PLUGIN_ROOT}/runtime/muster.mjs capabilities --codex --role <role>`; do not reprint the full skills inventory during task dispatch."
  );
  result = result.slice(0, providerStart) + compactProvider + result.slice(failureStart);
  // build-anchor-audit item: this closing "Iron-rule reminder: ..." sentence (right after the
  // Channel steering section's "unknown" bullet) was reworded once already by 424fcb1 and has
  // since been cut ENTIRELY -- no "Iron-rule reminder" line remains anywhere in the file (grep
  // verified). Same dead-transform reasoning as the three removals above: nothing left to
  // translate for Codex, so the transform is removed rather than forced against unrelated text.
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
  // silently dropped both subsections' Codex-relevant guidance (the process-only production-wave
  // rule + fail-closed non-wave spawn guard, and `resolveWorktreeIsolation`'s
  // receipts-only mechanism + `buildBaseShaReceipt` provenance) — never reaching a CODEX-HOSTED
  // muster running the bundled plugin (test/codex-wave-dispatch.test.js and
  // test/worktree-isolation.test.js only prove the resolvers themselves, not that a generated
  // package exposes them). Restore both, phrased for Codex (no `src/wave-dispatch.js` citation:
  // that path does not exist in the shipped package).
  // codex-dispatch-single-source item (audit 2026-07-29, slice D): the fork_turns contract
  // paragraph and the v1/v2 dispatch/barrier shapes table embedded below come VERBATIM from
  // the canonical reference via loadCodexDispatchContract -- the replacement text used to
  // hardcode v2-only `collaboration.spawn_agent` for every role even though the catalog puts
  // gpt-5.6-luna (muster's core tier) on v1, and its fork guidance had drifted from the
  // reference's. Do not paraphrase either block here; edit the reference instead.
  const waveDispatchHeading = "## Wave dispatch: native Workflow vs prose fallback";
  const waveDispatchStart = result.indexOf(waveDispatchHeading);
  const waveDispatchEnd = result.indexOf("## Scope fences", waveDispatchStart);
  if (waveDispatchStart < 0 || waveDispatchEnd < 0) throw new Error("orchestrator wave-dispatch section not found");
  result = result.slice(0, waveDispatchStart)
    + `${waveDispatchHeading}\n\nCodex has no counterpart to Claude Code CLI's agent-teams \`Workflow\` tool. Every production wave MUST first run through \`node ${"${PLUGIN_ROOT}"}/runtime/muster.mjs codex-wave <wave.json>\`. Production waves are process-only: never choose or invoke \`spawn_agent\` from a wave manifest, because declared write fences and read-only profile names are not mechanically enforceable in Codex's shared cwd. The process-wave input must name a distinct registered linked worktree root for every member. The runtime canonicalizes and verifies every path plus the trusted repository and exact base SHA before lane resolution, rejecting absent, nested/wrong, base-checkout, unregistered, dirty, or duplicate worktrees before it probes or starts Codex; once validated, it launches one hermetic \`codex exec -C\` process per member under the canonical thread ceiling and owns the all-process barrier.\n\n**The dispatch and barrier shapes are VERSION-DEPENDENT** only for explicit non-wave leaf delegation: Codex resolves its subagent API per MODEL from the catalog's \`multi_agent_version\`, so never hardcode one shape and fail closed to v1 rather than guessing v2. Production waves do not use these spawn shapes.\n\n${contract.shapesTable}\n\n${contract.forkTurns}\n\n\`wait_agent\` BLOCKS until something happens, so there is no interval to tune and nothing to tight-poll -- for explicit non-wave leaf delegation, call it in a loop until every dispatched member has settled and take receipts from the mailbox, not \`list_agents\`. \`node ${"${PLUGIN_ROOT}"}/runtime/muster.mjs wave-dispatch\` always resolves \`mode: "prose"\` on this harness; it never authorizes bypassing the process-only \`codex-wave\` production lane.\n\nNative review routing stays disabled: the paid native-review shadow benchmark rejected adoption with 0/10 schema-valid outputs. Production review continues through muster's canonical independent review gate; never route a wave verdict through \`codex review\`.\n\n### Worktree isolation: registered process roots or receipts-only\n\nThe process-wave lane enforces registered linked worktrees mechanically before execution. Codex subagent dispatch has no cwd field on either API version, so explicit non-wave delegation has no native worktree mechanism to select: run \`node ${"${PLUGIN_ROOT}"}/runtime/muster.mjs worktree-isolation --harness codex\` to confirm it resolves \`mechanism: "receipts-only"\`. Production waves do not use that weaker floor: \`codex-wave\` binds each member's absolute pristine worktree to the trusted common Git directory and exact base SHA before execution.\n\n`
    + `Process-wave invocation is incomplete unless it appends \`--fence-file <trusted no-follow action-fence.json> --repository-root <trusted repo root> --base-sha <exact full base SHA>\` to the command above. The fence document maps every member id to its validated fixed-vocabulary action classes; its no-follow path, trusted repository values, and exact base travel out of band from \`wave.json\`. The runtime injects the fence separately from the user brief, receipts its digest, binds every member to the shared common Git directory and exact base, then revalidates immediately before each bounded launch.\n\n`
    + result.slice(waveDispatchEnd);
  const enforcement = result.indexOf("## Enforcement model: gates vs conventions");
  if (enforcement < 0) throw new Error("orchestrator enforcement section not found");
  return result.slice(0, enforcement) + `## Codex enforcement model\n\n- **Mechanically validated:** manifest schema, dependency waves, capability resolution, worktree/base-SHA receipts, file ownership checks, tests, reviews, commits, and terminal receipts.\n- **Hook diagnostics:** session/prompt context, supported action-class warnings, a warn-only border-invitation drift reminder, stale-marker diagnostics, and subagent start/stop context after one-time hook trust.\n- **Advisory:** todo-before-spawn and universal dispatch-not-inline blocking. Current Codex hooks cannot reliably intercept every subagent or unified-shell action, so do not claim these are hard gates.\n- **Required invariant:** every write-capable wave runs in explicitly created isolated worktrees and is verified from repository state after the barrier.\n\n${contract.watchProtocol}`;
}
// Every muster CLI verb whose Codex-side invocation must carry --codex (the
// Codex-adapted catalog/capability surface). One list, one rewrite loop below:
// the six chains this replaced were byte-identical except for the verb, so a
// seventh verb is now a one-word edit instead of a copied `.replace` line.
const CODEX_ADAPTED_VERBS = ["capabilities", "match", "assess", "diagnose", "audit", "manifest validate"];
function bindBundledCodexCli(text) {
  const cli = `node ${"${PLUGIN_ROOT}"}/runtime/muster.mjs`;
  const escapedCli = escapeRe(cli);
  let result = text
    // The Claude-side performance pass resolves `$MUSTER_CLI` once per run
    // (plugin/commands/go.md step -2) because a raw `npx` call pays a cold
    // start on every invocation. The Codex package has no such ambiguity:
    // the bundled runtime IS the resolved CLI, so bind the indirection (and
    // the unbraced plugin-root form its resolution snippet uses) directly to
    // the bundled entrypoint before the per-verb --codex rewrites below.
    .replaceAll("$MUSTER_CLI", cli)
    .replaceAll("$CLAUDE_PLUGIN_ROOT/", "${PLUGIN_ROOT}/")
    .replaceAll("npx -y @adnova-group/muster", cli);
  for (const verb of CODEX_ADAPTED_VERBS) {
    result = result.replace(new RegExp(`${escapedCli} ${verb}(?! --codex)`, "g"), `${cli} ${verb} --codex`);
  }
  return result;
}
// skill-frontmatter-capabilities item: Claude Code skill frontmatter supports capability
// keys (disallowed-tools, argument-hint, disable-model-invocation, etc. --
// docs/research/claude-code-cli.md:170) that the open agent-skills standard Codex targets
// does not. scripts/check-codex.mjs's own `allowedSkillKeys` gate (kept in sync here by
// hand, same as this file's other Codex-side accept-lists) fails a generated SKILL.md that
// carries any other key, so any Claude-only key must be stripped from a ported skill's
// header before it reaches the Codex output rather than leak through name:/description:'s
// existing line-targeted rewrites below.
const CODEX_SKILL_KEYS = new Set(["name", "description", "license", "allowed-tools", "metadata"]);
const codexSkillId = name => name.startsWith("gsd-") ? `muster-${name}` : name;
function codexSkill(source, id, contract) {
  source = normalizeLf(source);
  const match = source.match(/^(---\r?\n[\s\S]*?\r?\n---)([\s\S]*)$/);
  if (!match) throw new Error("Ported Codex skill is missing YAML frontmatter");
  let header = translateModeNames(match[1]).replaceAll("AskUserQuestion", "interactive user input");
  header = header.replace(/^(?:adapted_from|inspired_by|muster_builtin):.*\r?\n?/gm, "");
  header = header.replace(/^name:\s*.*$/m, `name: ${id}`);
  header = header.replace(/^description:\s*(.*)$/m, (_, description) => {
    const codexDescription = `Codex-compatible Muster workflow. ${description}`.replaceAll("<", "[").replaceAll(">", "]");
    return `description: ${JSON.stringify(codexDescription)}`;
  });
  // Single-line scalar keys only (every key this repo's skills carry today is one line);
  // a future block-scalar value would need a smarter strip, not silently mis-handled here.
  header = header.replace(/^([A-Za-z][\w-]*):.*\r?\n?/gm, (line, key) => (CODEX_SKILL_KEYS.has(key) ? line : ""));
  let body = translatePluginPaths(bindBundledCodexCli(translateCodexProse(translateModeNames(match[2]))))
    .replaceAll("${CLAUDE_PLUGIN_ROOT}", "${PLUGIN_ROOT}")
    .replaceAll("AskUserQuestion", "interactive user input")
    .replaceAll("Claude Code Agent tool", "Codex subagent dispatcher")
    .replaceAll("the Agent tool", "the Codex subagent dispatcher")
    .replaceAll("Agent tool", "Codex subagent dispatcher")
    .replaceAll("Task tool", "Codex subagent dispatcher");
  if (id === "sp-brainstorm") {
    const visualCompanionAnchor = "skills/brainstorming/visual-companion.md";
    if (!body.includes(visualCompanionAnchor)) throw new Error("sp-brainstorm visual-companion anchor not found for Codex rewrite");
    body = body.replaceAll(
      visualCompanionAnchor,
      `node ${"${PLUGIN_ROOT}"}/runtime/resolve-skill-provider.mjs builtin sp-brainstorm visual-companion.md\n\nBefore invoking any \`scripts/...\` command from that guide, run \`node ${"${PLUGIN_ROOT}"}/runtime/resolve-skill-provider.mjs builtin sp-brainstorm --path\`. Treat its verified absolute output as the guide's asset root and resolve every \`scripts/...\` path beneath it; never execute a path from the internal tree without this full-tree verification.`
    );
  }
  if (id === "coordination") body = adaptCoordinationForCodex(body);
  if (id === "orchestrator") body = adaptOrchestratorForCodex(body, contract);
  if (id === "router") {
    const routerSkillsAnchor = "For EVERY plan task, consult `AvailableCapabilities.skills` and run";
    if (!body.includes(routerSkillsAnchor)) throw new Error("router skills-inventory anchor not found for Codex rewrite");
    body = body.replace(
      routerSkillsAnchor,
      "The compact Codex capability snapshot intentionally omits the global skill inventory. For EVERY plan task, run"
    );
  }
  if (id === "review-gate") {
    // Both regexes below sit in the SAME function/skill as fixCapRe just below (the
    // build-anchor-audit item's own reference fix, PR #159): each needs the identical
    // wording-tolerant-regex + throw-on-miss posture, guarded the same way, so a future
    // reword of step 1's capability-source sentence or its reviewer-selection list
    // silently ships stale Claude-side prose into the Codex bundle exactly like the
    // pre-#159 fix-cap anchor did.
    const capabilitySourceRe = /`AvailableCapabilities` read from the run's already-captured `\.muster\/capabilities\.json` \(written once at[\s\S]*?serves every wave\)\./;
    if (!capabilitySourceRe.test(body)) throw new Error("review-gate capability-source anchor not found for Codex rewrite");
    const selectReviewersRe = /1\.\s+\*\*?Select reviewers[\s\S]*?(?=\n2\.\s+Dispatch)/;
    if (!selectReviewersRe.test(body)) throw new Error("review-gate select-reviewers anchor not found for Codex rewrite");
    body = body
      .replace(
        // The Claude-side performance pass reuses the run's cached
        // .muster/capabilities.json for the whole run; the Codex package
        // instead requires compact per-role lookups so reviewer briefs never
        // carry the full skills inventory. Keep the fast-path cumulative-diff
        // clause (it is harness-neutral) and swap only the capability-source
        // phrasing.
        capabilitySourceRe,
        "compact role lookups from `node ${PLUGIN_ROOT}/runtime/muster.mjs capabilities --codex --role <role>`; never attach the full skills inventory to a reviewer brief."
      )
      .replace(
        // Anchored on the step-1 opening + the step-2 opening ("2. Dispatch") rather than
        // a specific closing sentence, so a Claude-side reword of step 1's OWN prose (e.g.
        // the speed-tuning item's skill-size cuts, or weight-reduction's diff-scaled
        // reviewer-count rewrite before it) cannot silently desync this replacement from
        // its anchor the way the pre-speed-tuning literal "Select reviewers: ... Always at
        // least one." match did (broke silently when weight-reduction reworded step 1).
        selectReviewersRe,
        "1. Select one code reviewer for ordinary waves. Add the security reviewer only when the task is security-scoped or the diff touches authentication, authorization, secrets, cryptography, shell execution, network boundaries, installers, or lifecycle hooks. Add a surface reviewer only when its definition-of-done gate fires. Never dispatch two reviewers for the same quality dimension; always use at least one reviewer."
      )
      ;
    const fixLoopPrefixRe = /6\. If `blocked`:[^\n]*\n\s+On Codex,[\s\S]*?available\. Cap at/;
    if (!fixLoopPrefixRe.test(body)) throw new Error("review-gate fix-loop context anchor not found for Codex rewrite");
    body = body.replace(
      fixLoopPrefixRe,
      "6. If `blocked`: load the exact original opaque `receiptId` returned by `codex-wave`, write retained `sentBlockers` plus this review's `currentBlockers` to a review-state file, and run `node ${PLUGIN_ROOT}/runtime/muster.mjs codex-wave-resume <receipt-id> --review-state <file>`. The runtime authenticates its owner-only receipt, independently re-derives the trusted executable/version, canonical worktree/base/HEAD, full `muster-runner` policy and forbidden-action fence, computes only new blocker deltas, labels them as `<remote-text>` DATA, and resumes the exact persisted thread over stdin inside its private persistent Codex home with the same bubblewrap, hermetic environment and resource limits. Never invoke `codex exec resume` directly, use a recency selector, fresh re-dispatch, or repeat the original brief/transcript. Then re-review. Cap at"
    );
    // Anchored as a REGEX tolerant of Claude-side rewording between the cap
    // sentence and its ESCALATE, and guarded fail-loud: the previous literal
    // string here silently no-opped when #158's prose tightening dropped
    // "after the cap" (String.replace misses are invisible), shipping a
    // bundle without the one-iteration clause the codex-workflows guard pins.
    const fixCapRe = /Cap at\n\s+\*\*3 fix iterations\*\* \(`REVIEW_GATE_MAX_ITERATIONS` = 3\)\. If still blocked[^\n]*?ESCALATE/;
    if (!fixCapRe.test(body)) throw new Error("review-gate fix-cap anchor not found for Codex rewrite");
    body = body.replace(fixCapRe, "Allow **one fix-and-re-review iteration**. If the same blocker remains, ESCALATE");
  }
  if (id === "interview") {
    const presentApprovalAnchor = "Present both for approval via the **interactive user input** selection UI";
    if (!body.includes(presentApprovalAnchor)) throw new Error("interview present-approval anchor not found for Codex rewrite");
    body = body.replace(presentApprovalAnchor, "Render the complete enriched outcome and every success-criteria item inside the approval prompt itself; never refer to unstated criteria as ‘above’ or ‘previous’. Present both for approval via the **interactive user input** selection UI");
  }
  if (id === "wsh-sast-configuration") {
    const semgrepRulesAnchor = "# See references/semgrep-rules.md for detailed examples";
    if (!body.includes(semgrepRulesAnchor)) throw new Error("wsh-sast-configuration semgrep-rules anchor not found for Codex rewrite");
    body = body.replace(semgrepRulesAnchor, "# Example custom rule; adapt it to the repository's threat model");
  }
  const binding = `\n\n## Codex harness binding\n\nRead \`${"${PLUGIN_ROOT}"}/runtime/codex-skill-adapter.md\` before following this workflow. Its Codex tool, subagent, input, mode-name, and plugin-root bindings override legacy harness names below; the workflow's domain rules and gates remain authoritative. Load any relative bundled asset named by this workflow through \`node ${"${PLUGIN_ROOT}"}/runtime/resolve-skill-provider.mjs builtin ${id} <relative-asset>\`; never read the internal tree directly. When a bundled asset must execute with sibling files, first run the same resolver with \`--path\`; it verifies the complete skill tree before returning its absolute root.\n`;
  return header + binding + body.replace(/^\r?\n*/, "\n");
}

async function writeInternalRuntime(root, destination) {
  const tree = await assertRegularTree(join(destination, "internal-skills"));
  const metadata = JSON.stringify({ format: 1, files: tree.files }, null, 2) + "\n";
  const digest = createHash("sha256").update(metadata).digest("hex");
  const loaderSource = readFileSync(join(root, "codex", "internal-asset-loader.mjs"), "utf8");
  // Checking the OUTPUT for a leftover placeholder (the previous form of this check) misses
  // the case where the placeholder was renamed/removed from the source entirely: .replace
  // would then silently no-op on a text that never contained it, and the post-check --
  // finding nothing to complain about -- would pass anyway, shipping a loader whose digest
  // was never actually bound. Check the INPUT carries the anchor before relying on the
  // substitution to have done anything.
  if (!loaderSource.includes("__MUSTER_INTERNAL_METADATA_DIGEST__")) throw new Error("internal asset loader digest placeholder not found for Codex rewrite");
  const loader = loaderSource.replace("__MUSTER_INTERNAL_METADATA_DIGEST__", digest);
  if (loader.includes("__MUSTER_INTERNAL_METADATA_DIGEST__")) throw new Error("internal asset loader digest was not bound");
  write(join(destination, "runtime", "internal-assets.json"), metadata);
  write(join(destination, "runtime", "internal-asset-loader.mjs"), loader);
  cpSync(join(root, "codex", "resolve-skill-provider.mjs"), join(destination, "runtime", "resolve-skill-provider.mjs"));
}
async function adaptPortedSkills(internalSkillDir, names, contract) {
  for (const name of names) {
    const id = codexSkillId(name);
    const path = join(internalSkillDir, id, "SKILL.md");
    write(path, codexSkill(readFileSync(path, "utf8"), id, contract));
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
// published plugin whose stored input digest (computeCodexBuildInputDigest,
// src/codex-release.js) matches a fresh digest of the current generation
// inputs. This is the one shared implementation both the CLI entry below and
// codex-install.js's install-time trigger use, so `npm run build:codex` /
// `pretest` skip exactly like a `muster install codex` call does — neither
// path had its own separate, possibly-diverging copy of this check before.
// codex-bundle-cache-key incident fix: this used to compare only the package
// version, so editing a generation input without bumping the version never
// triggered regeneration and the call was a silent no-op -- a stale bundle
// shipped for the rest of a pinned-version window. Keying the skip on the
// input digest instead means any edit to any generation input (or a stored
// digest from a plugin published before this fix, which carries none at all)
// is observed regardless of whether the version changed. `outDir` deletion,
// a version bump, and `MUSTER_BUILD_FORCE=1` (honored here, and therefore by
// `npm run build:codex` / the `pretest` hook that invokes this same script's
// CLI entry below) all still force a fresh build unconditionally.
export async function buildCodexPlugin(options, retries = 1) {
  const { root, outDir } = options;
  if (process.env.MUSTER_BUILD_FORCE !== "1") {
    try {
      const current = await resolveCodexPlugin(root, { pluginsRoot: outDir });
      const inputDigest = await computeCodexBuildInputDigest(root);
      const packageVersion = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;
      const manifest = JSON.parse(readFileSync(join(current.pluginRoot, ".codex-plugin", "plugin.json"), "utf8"));
      const mcp = JSON.parse(readFileSync(join(current.pluginRoot, ".mcp.json"), "utf8"));
      const completeCodexContract = manifest.apps === undefined
        && !existsSync(join(current.pluginRoot, ".app.json"))
        && manifest.name === "muster"
        && manifest.version === packageVersion
        && manifest.skills === "./skills/"
        && manifest.mcpServers === "./.mcp.json"
        && JSON.stringify(mcp) === JSON.stringify({
          mcpServers: { muster: { command: "node", args: ["./runtime/muster-mcp.mjs"], cwd: "." } }
        })
        && readFileSync(join(current.pluginRoot, "runtime", "muster.mjs")).length > 0
        && readFileSync(join(current.pluginRoot, "runtime", "muster-mcp.mjs")).length > 0
        && readFileSync(join(current.pluginRoot, "skills", "muster", "SKILL.md")).length > 0
        && readFileSync(join(current.pluginRoot, "agents", "muster-builder.toml")).length > 0;
      if (current.inputDigest === inputDigest
        && current.packageVersion === packageVersion
        && completeCodexContract) return current;
    } catch { /* nothing published yet, or what's there is stale/invalid, or a generation input is unreadable: generate below */ }
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
    // Single-sourced with computeCodexBuildInputDigest's own declared input set
    // (src/codex-release.js) so this validation loop and the skip-check's digest
    // can never silently drift apart into hashing a different set than this
    // actually validates.
    for (const source of CODEX_BUILD_INPUT_DIRS) {
      await assertRegularTree(join(root, source));
    }
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
    ensure(plugin); ensure(runtime);

    rmAndCopy(join(root, "plugin", "commands"), join(plugin, "commands"));
    rmAndCopy(join(root, "catalog"), join(plugin, "catalog"));
    rmAndCopy(join(root, "pipelines"), join(plugin, "pipelines"));
    rmAndCopy(join(root, "vendor"), join(plugin, "vendor"));
    // The bundled runtime/muster.mjs reads the shared harness-neutral agent
    // manifest at runtime (src/agent-manifest.js: `new URL(
    // "../catalog/agents.manifest.json", import.meta.url)`, resolving to
    // plugin/catalog/ from plugin/runtime/) to resolve `capabilities --codex`/
    // `--kimi` per-role model profiles. It rides into the plugin as part of the
    // catalog/ copy above (rmAndCopy catalog -> plugin/catalog), so no separate
    // staging step is needed — the runtime stays self-contained without a Node
    // experimental-JSON-modules import warning on the Node 20/22 source lane.
    const contract = loadCodexDispatchContract(root);
    write(join(runtime, "codex-skill-adapter.md"), adaptSkillAdapterForCodex(readFileSync(join(root, "codex", "skill-adapter.md"), "utf8"), contract));
    rmAndCopy(join(root, "codex", "hooks"), join(runtime, "install-hooks"));
    write(join(runtime, "sprint-protocol.md"), readFileSync(join(root, "cowork", "sprint-protocol.md"), "utf8"));
    const codexCatalogPath = join(plugin, "catalog", "builtins.muster.yaml");
    const codexCatalogSource = readFileSync(codexCatalogPath, "utf8");
    const humanizerCreditAnchor = "blader/humanizer + StealthHumanizer (AI-tell removal)";
    if (!codexCatalogSource.includes(humanizerCreditAnchor)) throw new Error("builtins.muster.yaml humanizer-credit anchor not found for Codex rewrite");
    write(
      codexCatalogPath,
      codexCatalogSource.replace(humanizerCreditAnchor, "blader/humanizer + rudra496/StealthHumanizer (AI-tell removal)")
    );
    for (const entry of readdirSync(join(plugin, "commands"), { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
      const path = join(plugin, "commands", entry.name);
      write(path, adaptCommandForCodex(bindBundledCodexCli(translateModeNames(readFileSync(path, "utf8"))), entry.name, contract));
    }
    rmAndCopy(join(root, "plugin", "skills"), internalSkillDir);
    rmAndCopy(join(root, "plugin", "builtins"), internalSkillDir, { merge: true });
    for (const entry of readdirSync(join(root, "codex", "skill-assets"), { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      rmAndCopy(join(root, "codex", "skill-assets", entry.name), join(internalSkillDir, entry.name), { merge: true });
    }
    const implementerPromptPath = join(internalSkillDir, "sp-subagents", "implementer-prompt.md");
    const implementerPromptSource = readFileSync(implementerPromptPath, "utf8");
    const fullSuiteAnchor = "full suite once before committing, not after every edit.";
    if (!implementerPromptSource.includes(fullSuiteAnchor)) throw new Error("implementer-prompt.md full-suite anchor not found for Codex rewrite");
    write(
      implementerPromptPath,
      implementerPromptSource.replace(fullSuiteAnchor, "focused tests before committing; the parent runs the broad suite once at final verification.")
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
    await adaptPortedSkills(internalSkillDir, portedSkillNames.filter(name => !name.startsWith("gsd-") && name !== "wsh-signed-audit-trails-recipe"), contract);
    await writeInternalRuntime(root, plugin);

    for (const [name, mode] of Object.entries(modes)) write(join(modeDir, name, "SKILL.md"), modeSkill(name, mode, contract));
    write(join(modeDir, "muster", "SKILL.md"), `---\nname: muster\ndescription: ${JSON.stringify("Route orchestration requests across Muster modes and pipelines.")}\n---\n\n<!-- prompt-lint-disable ANTH-ROLE-001, ANTH-FMT-001: Root router delegates to a selected authoritative workflow and intentionally does not impose a second persona or output format. -->\n\n# Muster\n\nRead \`${"${PLUGIN_ROOT}"}/runtime/codex-skill-adapter.md\` before routing so named profiles, bounded context forks, plugin paths, and Codex-native tools are applied consistently.\n\nSelect the matching explicit skill when the request has a clear mode: $muster-init, $muster-plan, $muster-go, $muster-plan-backlog, $muster-go-backlog, $muster-diagnose, $muster-audit, $muster-design, $muster-runner, or $muster-capture. Use the legacy run, autopilot, and sprint skills only for compatibility.\n\nStart with the bundled deterministic MCP tools: detect the project, resolve capabilities, assess the outcome, route the pipeline, validate the crew manifest, then execute dependency waves with receipts and gates. Write-capable waves require isolated worktrees.\n\n${contract.watchProtocol}`);

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
    await build({
      ...bundleOptions,
      entryPoints: [join(root, "mcp", "codex-server.mjs")],
      outfile: join(runtime, "muster-mcp.mjs"),
    });
    // Installer payload only: Codex never registers this adapter in its own
    // manifest/MCP config and never reads a Work receipt or app mapping.
    await build({
      ...bundleOptions,
      entryPoints: [join(root, "mcp", "chatgpt-work-server.mjs")],
      outfile: join(runtime, "chatgpt-work-server.mjs"),
    });
    // inputDigest is buildCodexPlugin's codex-bundle-cache-key skip key: stamped
    // fresh on every real generation so the NEXT call's skip check compares
    // against what was actually read this time, not merely this version string.
    const inputDigest = await computeCodexBuildInputDigest(root);
    write(join(plugin, "package.json"), JSON.stringify({ version: pkg.version, inputDigest }, null, 2) + "\n");

    write(join(plugin, ".mcp.json"), JSON.stringify({
      mcpServers: { muster: { command: "node", args: ["./runtime/muster-mcp.mjs"], cwd: "." } }
    }, null, 2) + "\n");
    const pluginManifest = {
      name: "muster", version: pkg.version,
      description: "Glass-box agentic orchestration for Codex: deterministic routing, skills, agents, pipelines, hooks, and MCP tools.",
      author: { name: "Adnova Group", email: "rnbennett@gmail.com", url: "https://github.com/Adnova-Group" },
      homepage: "https://adnova-group.github.io/muster/", repository: "https://github.com/Adnova-Group/muster", license: "Apache-2.0",
      keywords: ["orchestration", "agents", "pipelines", "mcp", "codex"], skills: "./skills/", mcpServers: "./.mcp.json",
      interface: { displayName: "Muster", shortDescription: "Glass-box agentic orchestration for Codex.", longDescription: "Muster provides deterministic routing, custom-agent profiles, pipeline workflows, and the complete MCP toolset.", developerName: "Adnova Group", category: "Productivity", capabilities: ["Read", "Write"], websiteURL: "https://adnova-group.github.io/muster/", defaultPrompt: ["Plan this feature with Muster.", "Run a Muster audit of this repository.", "Use Muster to clear this backlog."] }
    };
    write(join(plugin, ".codex-plugin", "plugin.json"), JSON.stringify(pluginManifest, null, 2) + "\n");

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

function modeSkill(name, mode, contract) {
  return `---\nname: ${name}\ndescription: ${JSON.stringify(mode.description)}\n---\n\n<!-- prompt-lint-disable ANTH-ROLE-001, ANTH-FMT-001: Mode dispatcher delegates to the authoritative workflow and intentionally does not impose a second persona or output format. -->\n\n# Muster ${mode.command}\n\nUse this skill when the request needs to ${mode.purpose}. Treat the user's remaining prompt as the outcome or backlog reference.\n\n1. Read \`${"${PLUGIN_ROOT}"}/runtime/codex-skill-adapter.md\` and apply its Codex tool, named-profile dispatch, bounded-context-fork, and plugin-root bindings.\n2. Read \`${"${PLUGIN_ROOT}"}/commands/${mode.command}.md\` for the authoritative workflow and preserve its approval, isolation, escalation, and receipt gates.\n3. Use the bundled Muster MCP tools for deterministic routing, manifests, waves, scoring, and pipelines. The bundled CLI is \`node ${"${PLUGIN_ROOT}"}/runtime/muster.mjs\` when a tool is not available.\n4. Keep the shared pipeline files authoritative. Do not duplicate pipeline routing in this skill.\n\n${contract.watchProtocol}`;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = fileURLToPath(new URL("../", import.meta.url));
  const outDir = join(root, ".agents", "plugins");
  const result = await buildCodexPlugin({ root, outDir });
  process.stdout.write(`Codex plugin v${result.packageVersion} generated at ${result.pluginRoot}\n`);
}
