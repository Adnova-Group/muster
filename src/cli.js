#!/usr/bin/env node
import { detectProject, hasPromptingSignal } from "./detect.js";
import { loadCatalog } from "./catalog.js";
import { readInstalled, readInstalledCowork, readInstalledKimi, readInstalledWork } from "./harness.js";
import { resolveCapabilities } from "./capabilities.js";
import { validateManifest, manifestWarnings } from "./manifest.js";
import { writeMemory, readMemory } from "./memory.js";
import { computeWaves, nextTasks } from "./wave.js";
import {
  buildSprintReceipt,
  computeSprintWaves,
  integrationApprovalDigest,
  reconcileSprintProgress,
} from "./sprint-waves.js";
import { tallyReview, verdictsTallyCorruptionErrors } from "./review.js";
import { validateVerdicts } from "./verdict-schema.js";
import { pickWinner } from "./tournament.js";
import { homedir } from "node:os";
import { constants as fsConstants } from "node:fs";
import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { lstat, readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { runDoctor } from "./doctor.js";
import { initScratchpad } from "./scratchpad.js";
import { readProfile } from "./profile.js";
import { buildSignals } from "./signals.js";
import { validateVendorManifest, runVendor } from "./vendor.js";
import { parse as parseYaml } from "yaml";
import { scaffoldProject } from "./setup.js";
import {
  acknowledgeNativeInitHandoff,
  finalizeInitialization,
  initializeProject,
  transitionNativeInit,
} from "./init.js";
import { renderPlanChecklist } from "./checklist.js";
import { classifyDomain } from "./domain.js";
import { loadPipelines, pipelineForDomain, routePipeline } from "./pipeline.js";
import { scoreArtifact } from "./score.js";
import { classifyFailure, buildDiagnoseManifest } from "./diagnose.js";
import { buildAuditManifest } from "./audit.js";
import { runInstall, runUninstall } from "./install.js";
import { runCodexInstall, runCodexUninstall } from "./codex-install.js";
import { runChatgptWorkInstall } from "./chatgpt-work-install.js";
import { runKimiInstall, runKimiUninstall } from "./kimi-install.js";
import { runCodexDoctor } from "./codex-doctor.js";
import { readCodexInventory } from "./codex-inventory.js";
import { adaptCatalogForCodex } from "./codex-catalog.js";
import { readAgentPluginInventory } from "./agent-plugins.js";
import { assessOutcome } from "./interview.js";
import { parseDomainArgs, formatError, requireArg, flagValue } from "./cli-args.js";
import { dirFromImportMeta } from "./fs-util.js";
import { matchProviders, matchSkills, suggestSkillsForStack, signalsFromTask } from "./match.js";
import { prioritize } from "./prioritize.js";
import { parseIssueRef, resolveIssue } from "./issue.js";
import { classifySteer } from "./steer.js";
import { kimiSteerDelivery } from "./kimi-steer.js";
import { lintPrompt, lintChat, lintWorkflow } from "./prompt-lint.js";
import { scoreHumanness } from "./humanizer-score.js";
import { checkCitations } from "./citation-guard.js";
import { gradeCollected } from "./prompt-eval.js";
import { proposeVariations, selectWinner } from "./prompt-optimize.js";
import { scanRepoPrompts } from "./prompt-scan.js";
import { fuse } from "./fusion.js";
import { validateAdviceRequest } from "./advisor.js";
import { modelForRole } from "./model.js";
import { claudeModelForTier } from "./claude.js";
import { detectScope } from "./scope.js";
import { runHygiene, renderHygieneReport, DEFAULT_WORKTREE_THRESHOLD } from "./hygiene.js";
import { resolveMusterCli } from "./cli-resolve.js";
import { planGateCadence, DEFAULT_REVIEW_DIFF_THRESHOLD } from "./gate-cadence.js";
import { resolveWaveDispatch, resolveWorktreeIsolation, makeGitShaVerifier, codexSpawnAgentCall, codexWaitAgentCall } from "./wave-dispatch.js";
import { kimiGoalInvocation, kimiProcessDispatch } from "./kimi-dispatch.js";
import { captureSessionId, resolveSessionForCwd, readSessionUsage, summarizeItemReceipts, DEFAULT_SESSION_INDEX } from "./kimi-receipts.js";
import { resolvePlanSurface } from "./plan-surface.js";
import { envInt, isTruthyFlag } from "./env-util.js";
import { scoreOutcomeForFastPath, buildFastPathManifest } from "./fast-path.js";
import { detectReviewTriggers, lightBriefEligible } from "./review-brief.js";
import {
  codexThreadLimitConfigPath,
  resolveCodexThreadCeiling,
} from "./codex-thread-limits.js";
import {
  assertContainedNoSymlinkPath,
  atomicWrite,
  ensureContainedDirectory,
  inspectContainedPath,
  isUnsafePathToken,
  readNoFollowRegular,
  resolveContainedRealpath,
  withFileMutationLock,
  writeContainedFile,
} from "./fs-safe.js";
import { readDispatchReceipts, runKimiProcess } from "./dispatch-receipts.js";
import {
  DESIGN_SOURCE,
  DESIGN_WORKFLOWS,
  addDesignIgnore,
  detectAuditDesignEvidence,
  designGate,
  designProviderCheck,
  designStatus,
  initializeDesign,
  installDesignProvider,
  readDesignIgnores,
  resolveDesignContext,
  runDesignWorkflow,
  scanDesign,
} from "./design.js";

const CATALOG_DIR = new URL("../catalog/", import.meta.url);
// One array element per command group, each carrying its own "|" separators and
// joined with "" so the rendered single-line usage stays byte-identical to the
// pre-split string (website-docs.test.js reassembles this array from source).
const USAGE = [
  // routing: project detection, capability discovery, task→provider matching
  "Usage: muster <detect|capabilities [--cowork] [--codex] [--kimi] [--work] [--agent-plugins] [--role <role>] [--roles-only]|match [--skills] <task> [--stack <csv>] [--work]|",
  // manifest + waves: validate, order, and drive a plan
  "manifest validate <file> [--work]|wave <file>|next <manifest.json> [--done a,b]|",
  // performance pass + gate helpers
  "resolve-cli|gate-cadence <manifest.json> [--changed-lines N]|wave-dispatch [--agent-teams|--no-agent-teams]|worktree-isolation --harness <claude-code|claude-desktop|hermes|codex|kimi>|plan-surface <runtime>|receipt-verify <sha> --cwd <repo>|fast-path <outcome> [--capabilities <file>]|review-brief --reviewer-count <n> [--diff-files <file>] [--diff-text-file <file>]|",
  // sprint waves, review tally, tournament pick/fuse, advisor
  "sprint-waves <backlog.md> [--max-concurrent-threads-per-session N]|sprint-reconcile <progress.json>|backlog-publish <backlog.md> --expect <sha256|absent>|tally <file>|pick <file>|fuse <candidates.json> <fusion-map.json>|advise <advice-request.json>|",
  // harness-native dispatch packets + session receipts (kimi/codex lanes)
  "kimi-goal-invocation <objective> [--stream-json] [--secondary <model>]|kimi-process-dispatch --brief <text> --agent-file <name|path> --cwd <dir> --lane <primary|secondary>|kimi-process-run --brief <text> --agent-file <name|path> --cwd <dir> --lane <primary|secondary>|kimi-session-usage <--session-dir <dir>|--cwd <dir> [--stdout-file <f>]>|kimi-summarize-receipts <items.json>|codex-spawn-packet --task-id <id> --agent-type <id> [--message <text>|--message-file <f>] [--version v1|v2] [--fork-turns <none|N>]|codex-wait-packet [--version v1|v2] [--targets a,b] [--timeout-ms N]|",
  // memory + vendor + init lifecycle
  "memory read|write ...|vendor|init [dir]|init transition [dir] --to <handoff|attempted|completed>|init acknowledge [dir] --reason unavailable|init finalize [dir]|setup [dir]|design <init|status|resolve|detect|ignores|provider|gate|workflows|run> ...|",
  // planning + routing artifacts
  "plan-checklist <file>|domain <outcome>|pipeline <domain|id>|route <outcome>|score <file>|",
  // prompt tooling
  "prompt <lint|variations|eval|optimize|scan> [file|dir]|humanize-score <file> [--threshold N]|citation-check <file>|prioritize <file> [--model rice|ice|wsjf|weighted]|",
  // diagnose/audit/issue/assess/steer/scope
  "diagnose <symptom>|--ci <file>|audit [--backlog] [path...]|issue <ref>|assess <outcome>|steer [--harness kimi [--session <id>] [--prompt-id <id>]] <message>|scope [text]|",
  // doctor/conformance/scratchpad/profile/install/signals/hygiene/help
  "doctor [--codex]|codex-conformance [YYYY/MM/DD | --days N] [--cwd <repo>] [--current-pins-only]|scratchpad <runId>|profile|install <codex [--scope project-or-user]|chatgpt-work --connection-id <id> --profile <pro-safe|full> [--scope project|user] [--allow-full-actions]|kimi [--probe]> [--dry-run]|uninstall <codex [--scope project-or-user]|kimi> [--dry-run]|signals [dir]|hygiene [--reap] [--json] [--backlog <file>] [--worktree-threshold N] [--zombie-stale-min N] [--claim-stale-min N]|help [command]>",
].join("");

function out(obj) { process.stdout.write(JSON.stringify(obj, null, 2) + "\n"); }
function fail(msg) { process.stderr.write(`muster: ${msg}\n`); process.exit(1); }

// Shared stdin/text reader for every command that accepts a file-or-stdin arg. Caps stdin so an
// untrusted caller can't pump unbounded input into a linter/scorer (used by `prompt` and `humanize-score`).
const MAX_STDIN_BYTES = 1_048_576; // 1 MB — far above any realistic prompt
const MAX_HYGIENE_BACKLOG_BYTES = 16 * 1_048_576;
function readStdin(maxBytes = MAX_STDIN_BYTES) {
  return new Promise((resolve, reject) => {
    let d = "", bytes = 0; process.stdin.setEncoding("utf8");
    process.stdin.on("data", c => {
      bytes += Buffer.byteLength(c, "utf8");
      if (bytes > maxBytes) { process.stdin.destroy(); reject(new Error(`stdin exceeds ${maxBytes} byte limit`)); return; }
      d += c;
    });
    process.stdin.on("end", () => resolve(d));
    process.stdin.on("error", reject);
  });
}
// A "-", a missing arg, or a flag (e.g. `lint --agent`) all mean: read stdin.
const readText = async (arg) =>
  (!arg || arg === "-" || arg.startsWith("--")) ? await readStdin() : await readFile(arg, "utf8");

// Single source for the codex-aware catalog+inventory pair every command branch
// resolves against: --codex swaps the ~/.claude inventory for the live Codex
// inventory AND adapts the catalog for Codex (enabled upstream-native skills win,
// gsd-* ids get the muster- prefix); without it both stay untouched. Per-branch
// consumers layer their own differences on top of this pair (e.g. manifest
// validate's unresolved-skill warning filtering stays local to that branch).
async function loadEffectiveCatalog(args) {
  const catalog = await loadCatalog(CATALOG_DIR);
  const codex = args.includes("--codex");
  const work = args.includes("--work");
  const agentPlugins = args.includes("--agent-plugins");
  const installed = codex
    ? await readCodexInventory({ cwd: process.cwd() })
    : agentPlugins
    ? await readAgentPluginInventory(
      process.env.PLUGIN_ROOT || process.cwd(),
      { pluginDataRoot: process.env.PLUGIN_DATA }
    )
    : work
    ? readInstalledWork()
    : await readInstalled(homedir());
  return { catalog: codex ? adaptCatalogForCodex(catalog, installed) : catalog, installed };
}

async function resolveModeCapabilities(args) {
  const { catalog, installed } = await loadEffectiveCatalog(args);
  return resolveCapabilities(catalog, installed);
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  try {
    // Help is resolved before every command branch so even mutating verbs are safe to
    // inspect (`muster install --help`, `muster signals --help`, etc.).
    if (cmd === "help" || cmd === "--help" || cmd === "-h" || rest.includes("--help") || rest.includes("-h")) {
      process.stdout.write(USAGE + "\n");
      return;
    }
    // ── routing: project detection, capability discovery, task→provider matching ──
    if (cmd === "detect") {
      out(await detectProject(rest[0] || process.cwd()));
    } else if (cmd === "capabilities") {
      const catalog = await loadCatalog(CATALOG_DIR);
      // The optional positional home-dir override is found by elimination: take the
      // first arg that neither looks like a flag nor is a value a flag consumed. In
      // this branch only --role and --connectors take values; every other flag
      // (--codex/--kimi/--cowork/--work/--agent-plugins/--roles-only/--native-plugin) is a boolean switch.
      const role = flagValue(rest, "--role");
      const connectors = flagValue(rest, "--connectors");
      const consumedValues = new Set([role, connectors].filter(Boolean));
      const home = rest.find(a => !a.startsWith("-") && !consumedValues.has(a)) || homedir();
      // --cowork resolves providers from Cowork's MCP registry instead of ~/.claude;
      // declared remote connectors (not disk-discoverable) come from --connectors or env.
      let installed;
      if (rest.includes("--codex")) {
        installed = await readCodexInventory({ cwd: process.cwd() });
      } else if (rest.includes("--agent-plugins")) {
        installed = await readAgentPluginInventory(
          process.env.PLUGIN_ROOT || process.cwd(),
          { pluginDataRoot: process.env.PLUGIN_DATA }
        );
      } else if (rest.includes("--kimi")) {
        installed = await readInstalledKimi(home);
      } else if (rest.includes("--work")) {
        installed = readInstalledWork();
      } else if (rest.includes("--cowork")) {
        const declared = (flagValue(rest, "--connectors") || process.env.MUSTER_COWORK_CONNECTORS || "")
          .split(",").map(s => s.trim()).filter(Boolean);
        // Native plugin ride: whether Cowork's own plugin loader (see
        // docs/research/claude-cowork.md section 3d) actually accepted muster's
        // plugin/ tree is unverified and has no on-disk/protocol detection signal,
        // so it is DECLARED the same way remote connectors are -- --native-plugin
        // or MUSTER_COWORK_NATIVE_PLUGIN (MCPB-boolean-safe: only "1"/"true"-ish
        // values enable -- isTruthyFlag in src/env-util.js, the same parse
        // MUSTER_ENABLE_APEX uses in src/model.js).
        const nativePluginRide = rest.includes("--native-plugin")
          || isTruthyFlag(process.env.MUSTER_COWORK_NATIVE_PLUGIN);
        installed = await readInstalledCowork(home, { declaredConnectors: declared, nativePluginRide });
      } else {
        installed = await readInstalled(home);
      }
      // --codex lane resolves through the codex-adapted catalog AND augments each
      // agent-backed role with its resolved codexModel {model, effort} (opts.codex).
      // EVERY lane threads `home` (audit S3): the inventory readers above all honor
      // the positional home override, so dropping it on the default/--cowork/--work
      // arm made resolveCapabilities resolve installed-skill DESCRIPTIONS against
      // the real homedir while reporting skill NAMES from the override home --
      // every description came back empty.
      const capabilities = rest.includes("--codex")
        ? resolveCapabilities(adaptCatalogForCodex(catalog, installed), installed, home, { codex: true })
        : rest.includes("--kimi")
        ? resolveCapabilities(catalog, installed, home, { kimi: true })
        : rest.includes("--agent-plugins")
        ? resolveCapabilities(catalog, installed, home, { agentPlugins: true })
        : resolveCapabilities(catalog, installed, home);
      if (role) {
        if (!capabilities.roles[role]) fail(`capabilities --role ${role}: unknown role`);
        out({ role, ...capabilities.roles[role] });
      } else if (rest.includes("--roles-only")) {
        out({ roles: capabilities.roles });
      } else {
        out(capabilities);
      }
    } else if (cmd === "match" && rest.includes("--skills")) {
      // Skills mode: rank the live skills inventory by keyword overlap against the task
      // text (matchSkills), and separately suggest stack→skill mappings (deterministic,
      // no LLM). Signals for the stack map come from --stack <csv> when given, else are
      // derived from the task text itself (signalsFromTask) so a bare `match --skills
      // "<task>"` still surfaces stack-relevant skills without an extra flag.
      const task = flagValue(rest, "--skills");
      if (!task) fail("match --skills <task>: missing task");
      const { catalog: effectiveCatalog, installed } = await loadEffectiveCatalog(rest);
      const { skills } = resolveCapabilities(effectiveCatalog, installed);
      const ranked = matchSkills(task, skills);
      const stackArg = flagValue(rest, "--stack");
      const signals = stackArg
        ? { frameworks: stackArg.split(",").map(s => s.trim().toLowerCase()).filter(Boolean),
            languages: [], keywords: stackArg.split(",").map(s => s.trim().toLowerCase()).filter(Boolean) }
        : signalsFromTask(task);
      const suggested = rest.includes("--work") ? [] : suggestSkillsForStack(signals, skills);
      out({ ranked, suggested });
    } else if (cmd === "match") {
      const work = rest.includes("--work");
      const args = rest.filter(arg => arg !== "--codex" && arg !== "--work" && arg !== "--agent-plugins");
      if (!args[0]) fail("match <task>: missing task");
      const { catalog, installed } = await loadEffectiveCatalog(rest);
      out(matchProviders(args[0], catalog, installed, { callableOnly: work }));
    // ── manifest + waves: validate, order, and drive a plan ──
    } else if (cmd === "manifest" && rest[0] === "validate") {
      const args = rest.filter(arg => arg !== "--codex" && arg !== "--work" && arg !== "--agent-plugins");
      const file = requireArg(args, 1, "manifest validate <file>: missing file path", fail);
      const obj = JSON.parse(await readFile(file, "utf8"));
      const r = validateManifest(obj);
      // Cross-check plan[].skills bindings against the same live skills inventory
      // `capabilities`/`match --skills` resolve (resolveCapabilities().skills), so a
      // hallucinated or uninstalled bound id is actually caught here, not just at the
      // manifestWarnings unit level.
      const codex = rest.includes("--codex");
      const work = rest.includes("--work");
      const { catalog: effectiveCatalog, installed } = await loadEffectiveCatalog(rest);
      const capabilities = resolveCapabilities(effectiveCatalog, installed);
      const { skills } = capabilities;
      const manifestAdvisories = manifestWarnings(obj, skills);
      // An all-inline crew is the expected safe Work fallback, not evidence that
      // capability resolution was skipped. Keep every other manifest advisory.
      const warnings = work
        ? manifestAdvisories.filter((warning) => !warning.startsWith("crew: every member is source:inline"))
        : manifestAdvisories;
      // Validate-only strictness (deliberately NOT shared with the other branches):
      // under --codex/--work an unresolved skill binding is promoted from warning
      // to error because those lanes dispatch only against their explicit inventory.
      const unresolved = (codex || work)
        ? warnings.filter(warning => warning.includes("not found in resolveCapabilities().skills"))
        : [];
      const remainingWarnings = warnings.filter(warning => !unresolved.includes(warning));
      const callableProviderIds = work
        ? new Set(Object.values(capabilities.roles).flatMap(({ chosen, chain }) =>
            [chosen, ...(chain || [])]
              .filter((provider) => provider?.kind !== "inline")
              .map((provider) => provider.id)))
        : null;
      const unavailableProviders = work
        ? (Array.isArray(obj.crew) ? obj.crew : []).flatMap((member, index) =>
            member?.source !== "inline" && !callableProviderIds.has(member?.provider)
              ? [`crew[${index}].provider "${member?.provider}": not callable in capabilities --work`]
              : [])
        : [];
      const strictErrors = [...unresolved, ...unavailableProviders];
      const result = strictErrors.length
        ? { ok: false, errors: [...r.errors, ...strictErrors], ...(remainingWarnings.length ? { warnings: remainingWarnings } : {}) }
        : (warnings.length ? { ...r, warnings } : r);
      out(result);
      if (!result.ok) process.exit(2);
    // ── memory + ops: local memory read/write ──
    } else if (cmd === "memory" && rest[0] === "write") {
      const dir = requireArg(rest, 1, "memory write <dir> <entry.json>: missing args", fail);
      const entryFile = requireArg(rest, 2, "memory write <dir> <entry.json>: missing args", fail);
      const entry = JSON.parse(await readFile(entryFile, "utf8"));
      await writeMemory(dir, entry); out({ ok: true });
    } else if (cmd === "memory" && rest[0] === "read") {
      if (!rest[1]) fail("memory read <dir> [query]: missing dir");
      out(await readMemory(rest[1], rest[2] || ""));
    // ── manifest + waves (cont.): wave ordering, next task, sprint waves, review/pick/fuse ──
    } else if (cmd === "wave") {
      const file = requireArg(rest, 0, "wave <manifest.json>: missing file path", fail);
      const m = JSON.parse(await readFile(file, "utf8"));
      if (!Array.isArray(m.plan)) fail("wave: manifest has no 'plan' array");
      out(computeWaves(m.plan));
    } else if (cmd === "next") {
      const file = requireArg(rest, 0, "next <manifest.json> [--done a,b]: missing file path", fail);
      const m = JSON.parse(await readFile(file, "utf8"));
      if (!Array.isArray(m.plan)) fail("next: manifest has no 'plan' array");
      const doneArg = flagValue(rest, "--done");
      out(nextTasks(m.plan, doneArg ? doneArg.split(",") : []));
    // ── performance pass: resolve the CLI invocation once, and gate-cadence's fast path ──
    } else if (cmd === "resolve-cli") {
      out(await resolveMusterCli({ cwd: process.cwd() }));
    } else if (cmd === "gate-cadence") {
      const file = requireArg(rest, 0, "gate-cadence <manifest.json> [--changed-lines N]: missing file path", fail);
      const m = JSON.parse(await readFile(file, "utf8"));
      if (!Array.isArray(m.plan)) fail("gate-cadence: manifest has no 'plan' array");
      const waves = computeWaves(m.plan).map((w) => w.map((t) => t.id));
      // weight-reduction item, criterion 2: diff-size reviewer-count scaling, folded into
      // the same gate-cadence result when the caller already knows the diff (review-gate/
      // SKILL.md step 1, dispatched after a wave's changes exist) — absent for a
      // before-any-diff-exists caller (go.md step 4's one-shot capture), unchanged.
      const changedLinesArg = flagValue(rest, "--changed-lines");
      const changedLines = changedLinesArg === undefined ? undefined : Number(changedLinesArg);
      if (changedLines !== undefined && (!Number.isFinite(changedLines) || changedLines < 0)) {
        fail("gate-cadence --changed-lines must be a non-negative finite number");
      }
      const reviewDiffThreshold = envInt("MUSTER_REVIEW_DIFF_THRESHOLD", { min: 0, def: DEFAULT_REVIEW_DIFF_THRESHOLD });
      out(planGateCadence(waves, changedLines === undefined ? {} : { changedLines, reviewDiffThreshold }));
    } else if (cmd === "wave-dispatch") {
      // workflow-tool-delegation item: capability check + fallback-selection for the
      // orchestrator's wave dispatch mechanism (native Workflow tool vs the prose wave
      // loop). `--agent-teams`/`--no-agent-teams` is the orchestrator's own self-observed
      // signal (did its tool list carry Workflow this session?); omitted, this falls back
      // to the declared MUSTER_AGENT_TEAMS env var. See src/wave-dispatch.js.
      const agentTeams = rest.includes("--agent-teams") ? true : rest.includes("--no-agent-teams") ? false : undefined;
      out(resolveWaveDispatch({ agentTeams }));
    } else if (cmd === "worktree-isolation") {
      // worktree-isolation-native item: per-harness native worktree isolation mechanism
      // selection (Agent-tool isolation on Claude Code, Desktop's automatic worktree,
      // Hermes's `hermes -w`, Codex's and Kimi's shared receipts-only floor). `--harness`
      // is a declared selection, not auto-probed -- see src/wave-dispatch.js.
      const harness = flagValue(rest, "--harness");
      out(resolveWorktreeIsolation({ harness }));
    } else if (cmd === "plan-surface") {
      // native-plan-mode-parity item: per-harness plan-surface capability selection for the
      // approve-first gate (native plan mode/skill vs the AskUserQuestion prose fallback).
      // The runtime is a declared selection, never auto-probed; unknown/missing runtimes
      // resolve to the universal AskUserQuestion fallback, never a thrown error -- see
      // src/plan-surface.js.
      out(resolvePlanSurface(rest[0]));
    } else if (cmd === "receipt-verify") {
      // base-sha-receipt-verification item: the executable consumer -- proof that a
      // base-SHA receipt's SHA is REAL, not just well-formed (buildBaseShaReceipt's
      // format check alone can't provide that). Runs the git-backed default verifier
      // (makeGitShaVerifier, src/wave-dispatch.js -- shape-checked before it ever shells
      // out, so a branch/tag/HEAD/relative-ref argument is correctly reported unverified
      // rather than a false positive) against an explicit repo `--cwd` (never
      // process.cwd() -- Codex's spawn_agent has no cwd field, so the caller must always
      // state the repo) and prints the same {verified, mechanism} shape
      // buildBaseShaReceipt records.
      const sha = requireArg(rest, 0, "receipt-verify <sha> --cwd <repo>: missing sha", fail);
      const cwd = flagValue(rest, "--cwd");
      if (!cwd) fail("receipt-verify <sha> --cwd <repo>: missing --cwd");
      const verify = makeGitShaVerifier({ cwd });
      const verified = verify(sha);
      out({ sha, cwd, verified, mechanism: verify.mechanism });
      if (!verified) process.exit(2);
    } else if (cmd === "fast-path") {
      // weight-reduction item, criterion 1 (flagship): pre-router single-agent fast path.
      // Score-only when --capabilities is absent (the caller hasn't resolved capabilities
      // yet, or just wants the routing decision); when present AND eligible, also emit the
      // minimal builder+one-reviewer manifest -- deterministic, no router LLM dispatch.
      const outcome = requireArg(rest, 0, "fast-path <outcome> [--capabilities <file>]: missing outcome", fail);
      const score = scoreOutcomeForFastPath(outcome);
      const capsFile = flagValue(rest, "--capabilities");
      if (score.eligible && capsFile) {
        const capabilities = JSON.parse(await readFile(capsFile, "utf8"));
        out({ ...score, manifest: buildFastPathManifest({ outcome, capabilities }) });
      } else {
        out(score);
      }
    } else if (cmd === "review-brief") {
      // fast-path-token-gap item, lever 1: a code-backed CLI wrapper over
      // src/review-brief.js's lightBriefEligible/detectReviewTriggers -- the SAME
      // "code over model" pattern gate-cadence/citation-check/fast-path already
      // established for a diff-content decision. review-gate/SKILL.md's step invokes
      // this instead of leaving eligibility to unenforced prose discipline.
      const reviewerCountArg = flagValue(rest, "--reviewer-count");
      if (reviewerCountArg === undefined) fail("review-brief --reviewer-count <n> [--diff-files <file>] [--diff-text-file <file>]: missing --reviewer-count");
      const reviewerCount = Number(reviewerCountArg);
      if (!Number.isFinite(reviewerCount) || reviewerCount < 0) {
        fail("review-brief --reviewer-count must be a non-negative finite number");
      }
      const diffFilesArg = flagValue(rest, "--diff-files");
      const diffFiles = diffFilesArg
        ? (await readFile(diffFilesArg, "utf8")).split("\n").map((l) => l.trim()).filter(Boolean)
        : [];
      const diffTextFileArg = flagValue(rest, "--diff-text-file");
      const diffText = diffTextFileArg ? await readFile(diffTextFileArg, "utf8") : "";
      out({
        eligible: lightBriefEligible({ reviewerCount, diffFiles, diffText }),
        triggers: detectReviewTriggers(diffFiles, { diffText }),
      });
    // ── harness-native dispatch packets + session receipts (kimi/codex lanes) ──
    // The model layer reaches these builders ONLY through these verbs (the
    // two-layer boundary): each verb prints the descriptor src/kimi-dispatch.js /
    // src/kimi-receipts.js / src/wave-dispatch.js constructs, and the prose
    // spawns/records from the printed JSON. Builder validation errors throw and
    // surface through main()'s catch as fail() -- only MISSING cli args fail here.
    } else if (cmd === "kimi-goal-invocation") {
      const objective = requireArg(rest, 0, "kimi-goal-invocation <objective> [--stream-json] [--secondary <model>]: missing objective (the bare objective; the /goal prefix is added for you)", fail);
      const secondary = flagValue(rest, "--secondary");
      out(kimiGoalInvocation({
        objective,
        streamJson: rest.includes("--stream-json"),
        ...(secondary ? { secondaryModel: secondary } : {})
      }));
    } else if (cmd === "kimi-process-dispatch") {
      const usage = "kimi-process-dispatch --brief <text> --agent-file <name|path> --cwd <dir> --lane <primary|secondary>";
      const brief = flagValue(rest, "--brief");
      if (!brief) fail(`${usage}: missing --brief`);
      const agentFile = flagValue(rest, "--agent-file");
      if (!agentFile) fail(`${usage}: missing --agent-file`);
      const cwd = flagValue(rest, "--cwd");
      if (!cwd) fail(`${usage}: missing --cwd`);
      const lane = flagValue(rest, "--lane");
      if (!lane) fail(`${usage}: missing --lane`);
      out(kimiProcessDispatch({ brief, agentFile, cwd, lane }));
    } else if (cmd === "kimi-process-run") {
      const usage = "kimi-process-run --brief <text> --agent-file <name|path> --cwd <dir> --lane <primary|secondary>";
      const allowed = new Set(["--brief", "--agent-file", "--cwd", "--lane"]);
      for (let index = 0; index < rest.length; index += 2) {
        if (!allowed.has(rest[index]) || index + 1 >= rest.length || rest[index + 1].startsWith("--")) {
          fail(`${usage}: unknown or valueless option ${JSON.stringify(rest[index] ?? "")}`);
        }
      }
      const brief = flagValue(rest, "--brief");
      if (!brief) fail(`${usage}: missing --brief`);
      const agentFile = flagValue(rest, "--agent-file");
      if (!agentFile) fail(`${usage}: missing --agent-file`);
      const cwd = flagValue(rest, "--cwd");
      if (!cwd) fail(`${usage}: missing --cwd`);
      const lane = flagValue(rest, "--lane");
      if (!lane) fail(`${usage}: missing --lane`);
      const terminal = await runKimiProcess({ brief, agentFile, cwd, lane });
      if (terminal.signal) process.kill(process.pid, terminal.signal);
      else process.exitCode = Number.isInteger(terminal.code) ? terminal.code : 1;
    } else if (cmd === "kimi-session-usage") {
      // Two arms, mirroring the prose's two accounting arms: --session-dir reads
      // a KNOWN session dir (the in-session arm's parent session); --cwd RESOLVES
      // the session for a -p leg first (captureSessionId on --stdout-file's
      // captured stream-json stdout when given, else the session-index fallback),
      // printing { resolution, usage } -- or { resolution } alone when resolution
      // comes back UNKNOWN (resolved:false), which is a recorded outcome, never a
      // failure (exit stays 0).
      const usage = "kimi-session-usage <--session-dir <dir> | --cwd <dir> [--stdout-file <file>] [--index <file>]>";
      const sessionDir = flagValue(rest, "--session-dir");
      const cwd = flagValue(rest, "--cwd");
      if (!sessionDir && !cwd) fail(`${usage}: missing --session-dir or --cwd`);
      if (sessionDir && cwd) fail(`${usage}: --session-dir and --cwd are mutually exclusive (--session-dir reads a known session; --cwd resolves one first)`);
      // Slice-B containment on every file-arg READ (the same
      // resolveContainedRealpath discipline the sprint-waves branch applies
      // below): these paths come from prose/model output, so a planted symlink
      // must fail with the named refusal, never be read.
      const contained = async (label, value, { root = process.cwd(), rootName = "the run root" } = {}) => {
        const canonical = await resolveContainedRealpath(root, value);
        if (canonical === null) {
          fail(`${usage}: ${label} ${value} does not resolve to a path contained under ${rootName} (missing, dangling, or a symlink escape) -- refusing to read`);
        }
        return canonical;
      };
      if (sessionDir) {
        out(await readSessionUsage(await contained("--session-dir", sessionDir)));
      } else {
        const stdoutFile = flagValue(rest, "--stdout-file");
        const capturedSessionId = stdoutFile ? captureSessionId(await readFile(await contained("--stdout-file", stdoutFile), "utf8")) : null;
        const index = flagValue(rest, "--index");
        const indexPath = index ? await contained("--index", index) : DEFAULT_SESSION_INDEX;
        const resolution = await resolveSessionForCwd({ indexPath, cwd, capturedSessionId });
        // The RESOLVED session dir needs the same gate as the flags above: it is
        // data (a session_index.jsonl `sessionDir` field, which readSessionIndex
        // accepts as any string), and its usage is echoed into this JSON. Root:
        // the index's OWN directory -- kimi writes session_index.jsonl at the
        // kimi-home root and every sessionDir under it
        // (<home>/sessions/wd_<slug>/session_<uuid>, probe evidence in
        // src/kimi-receipts.js), so an entry resolving anywhere else is planted,
        // never a session. src/kimi-receipts.js's readers re-check on their own.
        out(resolution.resolved
          ? {
            resolution,
            usage: await readSessionUsage(await contained("resolved session dir", resolution.sessionDir, {
              root: dirname(indexPath),
              rootName: "the session index root"
            }))
          }
          : { resolution });
      }
    } else if (cmd === "kimi-summarize-receipts") {
      const file = requireArg(rest, 0, "kimi-summarize-receipts <items.json>: missing items file ([{ itemId, resolution | resolutions }])", fail);
      // Same slice-B containment as the sprint-waves branch below: the items
      // file is a model-supplied path, so a planted symlink fails with the
      // named refusal, never a read.
      const canonical = await resolveContainedRealpath(process.cwd(), file);
      if (canonical === null) {
        fail(`kimi-summarize-receipts <items.json>: ${file} does not resolve to a file contained under the run root (missing, dangling, or a symlink escape) -- refusing to read`);
      }
      const items = JSON.parse(await readFile(canonical, "utf8"));
      process.stdout.write((await summarizeItemReceipts(items)).join("\n") + "\n");
    } else if (cmd === "codex-spawn-packet") {
      // The version-aware spawn_agent constructor (src/wave-dispatch.js): prints
      // the exact call JSON for the target model's API version, failing closed to
      // v1 when --version is absent (never guessing v2 at a v1 model).
      const usage = "codex-spawn-packet --task-id <id> --agent-type <id> [--message <text> | --message-file <file>] [--version v1|v2] [--fork-turns <none|N>]";
      const taskId = flagValue(rest, "--task-id");
      if (!taskId) fail(`${usage}: missing --task-id`);
      const agentType = flagValue(rest, "--agent-type");
      if (!agentType) fail(`${usage}: missing --agent-type`);
      const message = flagValue(rest, "--message");
      const messageFile = flagValue(rest, "--message-file");
      if (message !== undefined && messageFile !== undefined) fail(`${usage}: --message and --message-file are mutually exclusive`);
      // --message-file is the worst of the new-verb file args: its contents are
      // ECHOED into the printed packet JSON, so a planted symlink
      // (.muster/brief.md -> ~/.ssh/id_rsa) would leak the target into the
      // transcript. Same slice-B containment as the sprint-waves branch below --
      // the named refusal, never a read.
      let fileMessage;
      if (messageFile !== undefined) {
        const canonical = await resolveContainedRealpath(process.cwd(), messageFile);
        if (canonical === null) {
          fail(`${usage}: --message-file ${messageFile} does not resolve to a file contained under the run root (missing, dangling, or a symlink escape) -- refusing to read`);
        }
        fileMessage = await readFile(canonical, "utf8");
      }
      const version = flagValue(rest, "--version");
      const forkTurns = flagValue(rest, "--fork-turns");
      out(codexSpawnAgentCall({
        taskId,
        agentType,
        ...(fileMessage !== undefined ? { message: fileMessage } : message !== undefined ? { message } : {}),
        ...(version !== undefined ? { version } : {}),
        ...(forkTurns !== undefined ? { forkTurns } : {})
      }));
    } else if (cmd === "codex-wait-packet") {
      // The wave-barrier counterpart: v1 waits on named --targets, v2 takes no
      // targets at all -- the builder throws on a version/targets mismatch.
      const usage = "codex-wait-packet [--version v1|v2] [--targets a,b] [--timeout-ms N]";
      const version = flagValue(rest, "--version");
      const targetsArg = flagValue(rest, "--targets");
      const timeoutArg = flagValue(rest, "--timeout-ms");
      const timeoutMs = timeoutArg === undefined ? undefined : Number(timeoutArg);
      if (timeoutMs !== undefined && !Number.isInteger(timeoutMs)) fail(`${usage}: --timeout-ms must be an integer`);
      out(codexWaitAgentCall({
        ...(version !== undefined ? { version } : {}),
        ...(targetsArg !== undefined ? { targets: targetsArg.split(",").map(t => t.trim()).filter(Boolean) } : {}),
        ...(timeoutMs !== undefined ? { timeoutMs } : {})
      }));
    } else if (cmd === "sprint-waves") {
      const file = requireArg(rest, 0, "sprint-waves <backlog.md>: missing file path", fail);
      // Canonical containment before the read (audit S4 finding 5, extended to
      // this path by audit 2 slice B): finding 5 hardened only src/scope.js's
      // readBacklogCandidate, but THIS branch is the read the orchestrator
      // actually runs -- and it used to readFile(file) raw, so a planted
      // symlink backlog (.muster/backlog.md -> ~/.ssh/id_rsa) resolved inside
      // cwd lexically while its target's contents entered the run. The token
      // is realpath()ed and the canonical path must stay under the run root
      // (process.cwd()); a canonical escape, a missing file, or a dangling
      // link all fail with the named error below, never a read. Same
      // resolveContainedRealpath discipline the scope.js sibling applies --
      // silent degradation there (a probe answering "is this readable?"),
      // loud failure here (the run itself was told to read THIS file).
      const canonical = await resolveContainedRealpath(process.cwd(), file);
      if (canonical === null) {
        fail(`sprint-waves <backlog.md>: ${file} does not resolve to a file contained under the run root (missing, dangling, or a symlink escape) -- refusing to read`);
      }
      const content = await readFile(canonical, "utf8");
      const ceilingFlag = "--max-concurrent-threads-per-session";
      const explicitCeiling = flagValue(rest, ceilingFlag);
      if (rest.includes(ceilingFlag) && !/^[1-9]\d*$/.test(explicitCeiling || "")) {
        fail(`sprint-waves <backlog.md>: ${ceilingFlag} must be a positive integer`);
      }
      let threadConfigText = "";
      if (explicitCeiling === undefined) {
        const waveCodexHome = process.env.CODEX_HOME || join(homedir(), ".codex");
        try {
          threadConfigText = await readFile(codexThreadLimitConfigPath(waveCodexHome), "utf8");
        } catch (error) {
          if (error.code !== "ENOENT") throw error;
        }
      }
      const explicitCeilingValue = explicitCeiling === undefined
        ? undefined
        : BigInt(explicitCeiling) <= BigInt(Number.MAX_SAFE_INTEGER)
          ? Number(explicitCeiling)
          : explicitCeiling;
      const r = computeSprintWaves(content, {
        parallelLimit: process.env.MUSTER_SPRINT_PARALLEL,
        maxConcurrentThreadsPerSession: explicitCeilingValue === undefined
          ? resolveCodexThreadCeiling(threadConfigText)
          : explicitCeilingValue,
      });
      out(r);
      if (!r.ok) process.exit(2);
    } else if (cmd === "sprint-reconcile") {
      const file = requireArg(rest, 0, "sprint-reconcile <progress.json>: missing file path", fail);
      const input = JSON.parse(await readFile(file, "utf8"));
      const receiptSecret = process.env.MUSTER_LIFECYCLE_RECEIPT_SECRET;
      const approvalSecret = process.env.MUSTER_INTEGRATION_APPROVAL_SECRET;
      const trustedRunId = process.env.MUSTER_RUN_ID;
      const sign = (secret, digest, label) => {
        if (typeof secret !== "string" || secret.length < 16) throw new Error(`${label} secret is unavailable`);
        return createHmac("sha256", secret).update(digest).digest("hex");
      };
      const receipts = (input.receipts ?? []).map((receipt) => receipt.evidence ? receipt : buildSprintReceipt({
        ...receipt,
        findings: receipt.findings ?? [],
        signReceipt: (digest) => sign(receiptSecret, digest, "lifecycle receipt"),
      }));
      const issuedApprovals = (input.approvalRequests ?? []).map((request) => {
        if (typeof trustedRunId !== "string" || !trustedRunId) throw new Error("adapter-owned MUSTER_RUN_ID is required to issue approval");
        const approval = {
          ...request,
          approvedAt: new Date().toISOString(),
          runId: trustedRunId,
          nonce: randomUUID(),
        };
        const digest = integrationApprovalDigest(approval);
        return { ...approval, digest, evidence: sign(approvalSecret, digest, "integration approval") };
      });
      const approvals = [...(input.approvals ?? []), ...issuedApprovals];
      const r = reconcileSprintProgress(input.plan, {
        receipts,
        inFlight: input.inFlight,
        integrationTargets: input.integrationTargets,
        approvals,
        recovery: {
          ...(process.env.MUSTER_RECOVERY_NO_PROGRESS_LIMIT === undefined ? {} : {
            noProgressLimit: Number(process.env.MUSTER_RECOVERY_NO_PROGRESS_LIMIT),
          }),
          ...(process.env.MUSTER_RECOVERY_MAX_CONTINUATIONS === undefined ? {} : {
            maxContinuations: Number(process.env.MUSTER_RECOVERY_MAX_CONTINUATIONS),
          }),
        },
      }, {
        verifyApproval: (approval) => {
          const secret = process.env.MUSTER_INTEGRATION_APPROVAL_SECRET;
          if (typeof secret !== "string" || secret.length < 16 || !/^[0-9a-f]{64}$/.test(approval.evidence ?? "")) return false;
          const expected = createHmac("sha256", secret).update(approval.digest).digest();
          return timingSafeEqual(expected, Buffer.from(approval.evidence, "hex"));
        },
        verifyReceipt: (receipt, digest) => {
          if (typeof receiptSecret !== "string" || receiptSecret.length < 16 || !/^[0-9a-f]{64}$/.test(receipt.evidence ?? "")) return false;
          const expected = createHmac("sha256", receiptSecret).update(digest).digest();
          return timingSafeEqual(expected, Buffer.from(receipt.evidence, "hex"));
        },
        trustedRunId,
      });
      out({ ...r, approvals });
      if (!r.ok) process.exit(2);
    } else if (cmd === "backlog-publish") {
      const file = requireArg(rest, 0, "backlog-publish <backlog.md> --expect <sha256|absent>: missing file path", fail);
      if (isUnsafePathToken(file)) {
        fail("backlog-publish requires a relative backlog path contained under the run root");
      }
      const expected = flagValue(rest, "--expect");
      if (expected !== "absent" && !/^[a-f0-9]{64}$/.test(expected || "")) {
        fail("backlog-publish --expect must be a lowercase sha256 digest or absent");
      }
      if (!fsConstants.O_NOFOLLOW || process.env.MUSTER_TEST_FORCE_NO_NOFOLLOW === "1") {
        fail("backlog-publish cannot run safely: O_NOFOLLOW is unavailable");
      }
      const runRoot = process.cwd();
      const target = resolve(runRoot, file);
      const assertSafeMutationPath = () => assertContainedNoSymlinkPath(runRoot, target, {
        allowMissingFinal: true,
      });
      await assertSafeMutationPath();
      const nextBytes = Buffer.from(await readStdin(MAX_HYGIENE_BACKLOG_BYTES));
      const result = await withFileMutationLock(target, async () => {
        await assertSafeMutationPath();
        let prior = null;
        try {
          prior = await readNoFollowRegular(target, {
            maxBytes: MAX_HYGIENE_BACKLOG_BYTES,
            label: `backlog publish ${file}`,
          });
        } catch (error) {
          if (error.code !== "ENOENT") throw error;
        }
        const actual = prior === null
          ? "absent"
          : createHash("sha256").update(prior.bytes).digest("hex");
        if (actual !== expected) {
          throw new Error(`backlog changed before publication: ${file}; reread, reapply the mutation, and retry`);
        }
        await atomicWrite(target, nextBytes, {
          mode: prior === null ? 0o600 : prior.info.mode & 0o777,
          beforeRename: async () => {
            await assertSafeMutationPath();
            if (prior === null) {
              try {
                await lstat(target);
              } catch (error) {
                if (error.code === "ENOENT") return;
                throw error;
              }
              throw new Error(`backlog changed before publication: ${file}; reread, reapply the mutation, and retry`);
            }
            const current = await readNoFollowRegular(target, {
              maxBytes: MAX_HYGIENE_BACKLOG_BYTES,
              label: `backlog publish ${file}`,
              expectedInfo: prior.info,
            });
            if (!current.bytes.equals(prior.bytes)) {
              throw new Error(`backlog changed before publication: ${file}; reread, reapply the mutation, and retry`);
            }
          },
        });
        return { ok: true, sha256: createHash("sha256").update(nextBytes).digest("hex") };
      }, { beforeOpen: assertSafeMutationPath });
      out(result);
    } else if (cmd === "tally") {
      const file = requireArg(rest, 0, "tally <verdicts.json>: missing file path", fail);
      const verdicts = JSON.parse(await readFile(file, "utf8"));
      // verdicts.json is a structured-output-binding contract
      // (plugin/skills/review-gate/verdict.schema.json). Validation runs BEFORE
      // tallying and reports violations loudly -- but the schema is deliberately
      // STRICTER than tallyReview, whose tolerance of a malformed-but-consumable
      // emission is documented (its header, and the schema's own description).
      // So a schema violation splits two ways (boundary pinned by
      // verdictsTallyCorruptionErrors in src/review.js):
      //   - still tally-able (every entry is an object carrying a reviewer
      //     identity): a structured warning on stderr naming the violations,
      //     then the tally proceeds -- the defensive floor doing its job;
      //   - tally-corrupting (non-array top level, non-object entry, no
      //     reviewer identity): fail loud, same fail() convention as the
      //     advise branch's validateAdviceRequest gate. Unparseable JSON
      //     already fails loud above via main()'s catch.
      const v = await validateVerdicts(verdicts);
      if (!v.ok) {
        const corrupt = verdictsTallyCorruptionErrors(verdicts);
        if (corrupt.length > 0) {
          fail(`tally <verdicts.json>: fails verdict.schema.json and is not tally-able:\n${[...corrupt, ...v.errors].join("\n")}`);
        }
        process.stderr.write(JSON.stringify({
          warn: "tally <verdicts.json>: fails verdict.schema.json; tallying under tallyReview's documented tolerance",
          violations: v.errors,
        }) + "\n");
      }
      out(tallyReview(verdicts));
    } else if (cmd === "pick") {
      const file = requireArg(rest, 0, "pick <candidates.json>: missing file path", fail);
      out(pickWinner(JSON.parse(await readFile(file, "utf8"))));
    } else if (cmd === "fuse") {
      const candidatesFile = requireArg(rest, 0, "fuse <candidates.json> <fusion-map.json>: missing candidates file path", fail);
      const mapFile = requireArg(rest, 1, "fuse <candidates.json> <fusion-map.json>: missing fusion-map file path", fail);
      const candidates = JSON.parse(await readFile(candidatesFile, "utf8"));
      const map = JSON.parse(await readFile(mapFile, "utf8"));
      out(fuse(candidates, map));
    // ── prompt tools: advisor model selection ──
    } else if (cmd === "advise") {
      const file = requireArg(rest, 0, "advise <advice-request.json>: missing file path", fail);
      const req = JSON.parse(await readFile(file, "utf8"));
      const v = validateAdviceRequest(req);
      if (!v.ok) fail(v.errors.join("\n"));
      // advisorModel is the conceptual tier; advisorClaudeModel is the Claude
      // adapter's concrete dispatch value (apex degrades to prime -> opus first).
      out({ advisorModel: modelForRole("advisor"), advisorClaudeModel: claudeModelForTier(modelForRole("advisor")).model, request: req });
    // ── memory + ops (cont.): vendored catalog data, project scaffolding ──
    } else if (cmd === "vendor") {
      const manifestUrl = new URL("../vendor/manifest.yaml", import.meta.url);
      const manifest = parseYaml(await readFile(manifestUrl, "utf8"));
      const v = validateVendorManifest(manifest);
      if (!v.ok) { process.stderr.write(`muster: ${v.errors.join("\n")}\n`); process.exit(2); }
      const repoRoot = dirFromImportMeta(import.meta.url, "../");
      const res = await runVendor({ repoRoot, manifest });
      res.warnings.forEach(w => process.stderr.write(`warn: ${w}\n`));
      out({ vendored: res.count, warnings: res.warnings.length });
    } else if (cmd === "setup") {
      out(await scaffoldProject(rest[0] || process.cwd()));
    } else if (cmd === "init") {
      const action = ["transition", "acknowledge", "finalize"].includes(rest[0]) ? rest[0] : null;
      if (!action) {
        out(await initializeProject(rest[0] || process.cwd()));
      } else {
        const dir = rest[1] && !rest[1].startsWith("--") ? rest[1] : process.cwd();
        if (action === "transition") {
          const to = flagValue(rest, "--to");
          if (!to) fail("init transition [dir] --to <handoff|attempted|completed>: missing --to");
          const expect = flagValue(rest, "--expect");
          out(await transitionNativeInit(dir, {
            to,
            reason: flagValue(rest, "--reason") ?? null,
            expectedArtifacts: expect === undefined || expect === "" ? [] : expect.split(",").map((x) => x.trim()),
            evidenceKind: flagValue(rest, "--evidence") ?? null,
            evidenceFile: flagValue(rest, "--evidence-file") ?? null,
          }));
        } else if (action === "acknowledge") {
          out(await acknowledgeNativeInitHandoff(dir, { reason: flagValue(rest, "--reason") }));
        } else {
          out(await finalizeInitialization(dir));
        }
      }
    } else if (cmd === "design") {
      const sub = rest[0];
      const target = flagValue(rest, "--target");
      const optionValues = new Set([
        flagValue(rest, "--content-file"),
        target,
        flagValue(rest, "--outcome"),
        flagValue(rest, "--add"),
        flagValue(rest, "--wave"),
        flagValue(rest, "--args"),
      ].filter(Boolean));
      const positionals = rest.slice(1).filter((arg) => !arg.startsWith("--") && !optionValues.has(arg));
      const workflowIds = new Set(DESIGN_WORKFLOWS.map(({ id }) => id));
      if (sub === "workflows") {
        out({ source: DESIGN_SOURCE, workflows: DESIGN_WORKFLOWS });
      } else if (sub === "init") {
        out(await initializeDesign(positionals[0] || process.cwd(), {
          target,
          contentFile: flagValue(rest, "--content-file"),
        }));
      } else if (sub === "status") {
        out(await designStatus(positionals[0] || process.cwd(), { target }));
      } else if (sub === "resolve") {
        out(await resolveDesignContext(positionals[0] || process.cwd(), { target }));
      } else if (sub === "detect") {
        out(await scanDesign(positionals[0] || process.cwd(), {
          target,
          wave: flagValue(rest, "--wave") || "cli",
        }));
      } else if (sub === "ignores") {
        const dir = positionals[0] || process.cwd();
        const pattern = flagValue(rest, "--add");
        out(pattern ? await addDesignIgnore(dir, pattern) : {
          path: join((await resolveDesignContext(dir)).repoRoot, ".muster", "design-ignores"),
          ignores: await readDesignIgnores(dir),
        });
      } else if (sub === "provider") {
        const action = positionals[0];
        const dir = positionals[1] || process.cwd();
        if (action === "check") out(await designProviderCheck(dir));
        else if (action === "install") out(await installDesignProvider(dir));
        else fail("design provider <install|check> [dir]: unknown or missing action");
      } else if (sub === "gate") {
        const outcome = flagValue(rest, "--outcome");
        if (!outcome) fail("design gate [dir] --outcome <text>: missing --outcome");
        out(await designGate(positionals[0] || process.cwd(), {
          target,
          outcome,
          write: !rest.includes("--read-only"),
          audit: rest.includes("--audit"),
        }));
      } else if (sub === "run") {
        const workflow = positionals[0];
        if (!workflow) fail("design run <workflow> [dir]: missing workflow");
        out(await runDesignWorkflow(positionals[1] || process.cwd(), workflow, {
          target,
          args: flagValue(rest, "--args") || "",
        }));
      } else if (workflowIds.has(sub)) {
        out(await runDesignWorkflow(positionals[0] || process.cwd(), sub, {
          target,
          args: flagValue(rest, "--args") || "",
        }));
      } else {
        fail("design <init|status|resolve|detect|ignores|provider|gate|workflows|run>: unknown or missing action");
      }
    // ── manifest + waves (cont.): human-readable plan checklist ──
    } else if (cmd === "plan-checklist") {
      const file = requireArg(rest, 0, "plan-checklist <manifest.json> [--done a,b]: missing file path", fail);
      const m = JSON.parse(await readFile(file, "utf8"));
      const doneArg = flagValue(rest, "--done");
      const done = doneArg ? doneArg.split(",") : [];
      process.stdout.write(renderPlanChecklist(m.plan || [], done) + "\n");
    // ── prompt tools (cont.): artifact scoring, lint/variations/eval/optimize/scan, humanizer, citation guard ──
    } else if (cmd === "score") {
      const file = requireArg(rest, 0, "score <file.json>: missing file path ({scores, gate})", fail);
      const { scores, gate } = JSON.parse(await readFile(file, "utf8"));
      out(scoreArtifact(scores, gate));
    } else if (cmd === "prompt") {
      const sub = rest[0];
      if (sub === "lint" && rest.includes("--chat")) {
        // lintlang H7: lint a chat-format prompt (array of {role, content}) for role-ordering hygiene.
        const file = flagValue(rest, "--chat");
        const messages = JSON.parse(file ? await readFile(file, "utf8") : await readStdin());
        out(lintChat(messages));
      } else if (sub === "lint" && rest.includes("--workflow")) {
        // lintlang H4: lint a workflow (array of sibling prompts) for shared-state context-boundary erosion.
        const file = flagValue(rest, "--workflow");
        const prompts = JSON.parse(file ? await readFile(file, "utf8") : await readStdin());
        out(lintWorkflow(prompts));
      } else if (sub === "lint" || sub === "variations") {
        const text = await readText(rest[1]);
        const ctx = { isAgent: rest.includes("--agent"), hasTools: rest.includes("--tools") };
        // --system lints in the instruction/system genre (matches `prompt scan` for prompt
        // docs); --task forces the single-task rubric. Default is task.
        if (rest.includes("--system")) ctx.genre = "system";
        else if (rest.includes("--task")) ctx.genre = "task";
        // --tool-schema <file>: pass the real tool schemas so the schema↔intent rule (LINT-SCHEMA-003)
        // can check the prompt references each tool + its required fields (bare --tools stays a boolean).
        const schemaFile = flagValue(rest, "--tool-schema");
        if (schemaFile) {
          const parsed = JSON.parse(await readFile(schemaFile, "utf8"));
          ctx.tools = Array.isArray(parsed) ? parsed : parsed.tools;
          ctx.isAgent = true;
        }
        out(sub === "lint" ? lintPrompt(text, ctx) : proposeVariations(text, ctx));
      } else if (sub === "eval") {
        const file = requireArg(rest, 1, "prompt eval <suite.json>: missing suite ({dataset:[{output,format?,graderResponse?}], passThreshold?})", fail);
        const suite = JSON.parse(await readFile(file, "utf8"));
        out(gradeCollected(suite));
      } else if (sub === "optimize") {
        const file = requireArg(rest, 1, "prompt optimize <file.json>: missing file ({candidates:[{id,prompt?,total,passing}]})", fail);
        const { candidates } = JSON.parse(await readFile(file, "utf8"));
        out(selectWinner(candidates));
      } else if (sub === "scan") {
        out(await scanRepoPrompts(rest[1] || process.cwd()));
      } else {
        fail("prompt <lint|variations|eval|optimize|scan> [file|dir|-] [--agent] [--tools] [--tool-schema <f>] [--chat <f>] [--workflow <f>]");
      }
    } else if (cmd === "humanize-score") {
      // Deterministic 0-100 AI-tell score for human-facing text — the CI-gateable measure behind
      // the LLM humanizer. Reads a file path or capped stdin (shared readText helper).
      const text = await readText(rest[0]);
      const thresholdArg = flagValue(rest, "--threshold");
      const threshold = thresholdArg === undefined ? undefined : Number(thresholdArg);
      if (threshold !== undefined && (!Number.isFinite(threshold) || threshold < 0 || threshold > 100)) {
        fail("humanize-score --threshold must be a finite number between 0 and 100");
      }
      out(scoreHumanness(text, threshold === undefined ? {} : { threshold }));
    } else if (cmd === "citation-check") {
      // Deterministic citation guard for research/content artifacts: every `[src: anchor]` must
      // resolve against the trailing "Sources" list; dangling anchors fail loud (exit 2). Paragraphs
      // with zero citations are reported for a reviewer's judgment call, not auto-failed (see
      // plugin/skills/review-gate/SKILL.md). Reads stdin when the file arg is `-` or absent.
      const text = await readText(rest[0]);
      const r = checkCitations(text);
      out(r);
      if (!r.ok) process.exit(2);
    // ── pipelines + content: prioritization models, content pipeline lookup ──
    } else if (cmd === "prioritize") {
      const file = requireArg(rest, 0, "prioritize <file> [--model rice|ice|wsjf|weighted]: missing file", fail);
      const parsed = JSON.parse(await readFile(file, "utf8"));
      const items = Array.isArray(parsed) ? parsed : parsed.items;
      const model = flagValue(rest, "--model") || (Array.isArray(parsed) ? "rice" : (parsed.model || "rice"));
      out(prioritize(items, model));
    } else if (cmd === "pipeline") {
      if (!rest[0]) fail("pipeline <domain|id>: missing arg");
      const ps = await loadPipelines(new URL("../pipelines/", import.meta.url));
      out(pipelineForDomain(ps, rest[0]) || ps.find(p => p.id === rest[0]) || null);
    // ── routing (cont.): domain classification, pipeline routing, diagnose/audit modes, issue/assess/steer/scope ──
    } else if (cmd === "domain") {
      const { override, outcome } = parseDomainArgs(rest);
      if (!outcome) fail("domain <outcome> [--domain x]: missing outcome");
      out(classifyDomain(outcome, await detectProject(process.cwd()), override));
    } else if (cmd === "route") {
      if (!rest[0]) fail("route <outcome>: missing outcome");
      const outcome = rest.join(" ");
      const ps = await loadPipelines(new URL("../pipelines/", import.meta.url));
      const { domain } = classifyDomain(outcome, await detectProject(process.cwd()));
      const p = routePipeline(ps, outcome, domain);
      out({ domain, pipeline: p ? p.id : null });
    } else if (cmd === "diagnose") {
      const args = rest.filter(arg => arg !== "--codex" && arg !== "--work" && arg !== "--agent-plugins");
      const ci = args.includes("--ci");
      let input;
      if (ci) {
        const ciFile = flagValue(args, "--ci");
        if (!ciFile) fail("diagnose --ci <file>: missing file");
        input = await readFile(ciFile, "utf8");
      } else input = args.join(" ");
      if (!input || !input.trim()) fail("diagnose <symptom> | --ci <file>: missing input");
      const failure = classifyFailure(input, { ci });
      const caps = await resolveModeCapabilities(rest);
      out({ mode: failure.mode, manifest: buildDiagnoseManifest(failure, caps) });
    } else if (cmd === "audit") {
      // --backlog: read-only sweep -> ranked capture, no fix/verify (the $muster-audit
      // skill's backlog mode). Remaining positionals are optional path scopes.
      const backlog = rest.includes("--backlog");
      const args = rest.filter(arg => arg !== "--codex" && arg !== "--work" && arg !== "--agent-plugins" && arg !== "--backlog");
      // Remaining positionals are path scopes; a "-"-leading token is an unrecognized flag,
      // not a path (path scopes never start with "-"). Fail cleanly rather than silently
      // scoping to a bogus path -- mirrors the muster_audit MCP boundary's own guard.
      const unknownFlag = args.find(a => a.startsWith("-"));
      if (unknownFlag) fail(`audit: unknown option "${unknownFlag}" (path scopes must not start with "-")`);
      const caps = await resolveModeCapabilities(rest);
      // Use the lightweight package.json-only check, not detectProject — audit must not
      // incur git spawns (it stays offline for CI / the MCP wrapper). args[0], the first
      // scope path, also seeds the prompting-signal probe (unchanged for whole-repo runs).
      const prompting = await hasPromptingSignal(args[0] || process.cwd());
      const designEvidence = await detectAuditDesignEvidence(process.cwd(), args);
      out(buildAuditManifest(caps, { prompting, designEvidence, backlog, paths: args }));
    } else if (cmd === "issue") {
      if (!rest[0]) fail("issue <ref>: missing #N | number | issue-url");
      if (parseIssueRef(rest[0]).kind !== "issue") fail("not a GitHub issue reference: " + rest[0]);
      out(await resolveIssue(rest[0]));
    } else if (cmd === "assess") {
      const codex = rest.includes("--codex");
      const args = rest.filter(arg => arg !== "--codex");
      if (!args[0]) fail("assess <outcome>: missing outcome");
      out(assessOutcome(args[0], { codex }));
    } else if (cmd === "steer") {
      if (!rest[0]) fail("steer <message>: missing message");
      // Harness-conditional Kimi arm (kimi-native-steer-binding): ONLY
      // `--harness kimi` activates it -- every other invocation (no flag, or
      // any other --harness value) falls through to today's exact behavior,
      // classifying the raw args, so the Claude Code / Codex / Hermes steer
      // paths stay byte-identical. The Kimi arm composes the SAME classifier
      // with the native steer delivery construction (src/kimi-steer.js):
      // queued injection between steps without ending the turn, driven over
      // `kimi web`'s HTTP routes by whoever holds the live session.
      if (flagValue(rest, "--harness") === "kimi") {
        const flags = new Set(["--harness", "--session", "--prompt-id"]);
        const message = rest.filter((arg, i) => !flags.has(arg) && !flags.has(rest[i - 1])).join(" ");
        if (!message) fail("steer --harness kimi <message>: missing message");
        out({
          ...classifySteer(message),
          harness: "kimi",
          delivery: kimiSteerDelivery({
            message,
            sessionId: flagValue(rest, "--session"),
            promptId: flagValue(rest, "--prompt-id")
          })
        });
      } else {
        out(classifySteer(rest.join(" ")));
      }
    } else if (cmd === "scope") {
      // Deterministic backlog-vs-item scope detection for the plan/go verb family. An
      // empty rest (bare `muster scope`) is a valid input (rule 3's bare-invocation
      // case), so unlike most verbs above there is no missing-arg fail() here.
      out(await detectScope({ cwd: process.cwd(), text: rest.join(" ") }));
    // ── memory + ops (cont.): doctor, scratchpad, profile, install/uninstall, signals ──
    } else if (cmd === "doctor") {
      const r = rest.includes("--codex")
        ? await runCodexDoctor({ root: new URL("../", import.meta.url) })
        : await runDoctor({ root: new URL("../", import.meta.url) });
      out(r);
      if (!r.ok) process.exit(2);
    } else if (cmd === "codex-conformance") {
      // Post-run forensics, not a health check (that's doctor): audits Codex
      // rollouts for subagent model-conformance -- did each spawned
      // thread run its profile-pinned model, or inherit the orchestrator's?
      const { auditCodexModelConformance, MAX_CONFORMANCE_DAYS } = await import("./codex-conformance.js");
      const codexHome = process.env.CODEX_HOME || join(homedir(), ".codex");
      const daysIndex = rest.indexOf("--days");
      const cwdIndex = rest.indexOf("--cwd");
      const day = rest.find((arg, index) =>
        (daysIndex < 0 || index !== daysIndex + 1)
        && (cwdIndex < 0 || index !== cwdIndex + 1)
        && /^\d{4}\/\d{2}\/\d{2}$/.test(arg)
      );
      const daysArg = flagValue(rest, "--days");
      if (rest.some(arg => arg.startsWith("--days="))) fail("codex-conformance --days requires a separate positive base-10 integer argument");
      if (day && daysIndex >= 0) fail("codex-conformance: explicit day conflicts with --days");
      if (daysIndex >= 0 && (!daysArg || !/^[1-9]\d*$/.test(daysArg) || !Number.isSafeInteger(Number(daysArg)))) {
        fail("codex-conformance --days must be a positive base-10 integer");
      }
      if (daysIndex >= 0 && Number(daysArg) > MAX_CONFORMANCE_DAYS) {
        fail(`codex-conformance --days must not exceed ${MAX_CONFORMANCE_DAYS}`);
      }
      const today = new Date().toISOString().slice(0, 10).replaceAll("-", "/");
      const r = await auditCodexModelConformance({
        sessionsDir: join(codexHome, "sessions"),
        agentsDir: join(codexHome, "agents"),
        ...(daysIndex >= 0 ? { days: Number(daysArg) } : { day: day || today }),
        cwdFilter: flagValue(rest, "--cwd") || null
      });
      out(r);
      // --current-pins-only never hides a pre-retier row (it stays listed and
      // annotated), it only excludes it from the exit-code decision -- a
      // genuinely current mismatch (pinsNewerThanRollout false) still exits 2
      // either way.
      const actionableMismatches = rest.includes("--current-pins-only")
        ? r.tally.mismatch - r.tally.prePinMismatch
        : r.tally.mismatch;
      if (actionableMismatches > 0) process.exit(2);
    } else if (cmd === "scratchpad") {
      if (!rest[0]) fail("scratchpad <runId> [dir]: missing runId");
      out(await initScratchpad(rest[1] || ".muster", rest[0]));
    } else if (cmd === "profile") {
      out(await readProfile());
    } else if (cmd === "install") {
      if (rest[0] === "codex") {
        out(await runCodexInstall({ scope: flagValue(rest, "--scope") || "project", dryRun: rest.includes("--dry-run") }));
      } else if (rest[0] === "chatgpt-work") {
        const installOptions = {
          connectionId: flagValue(rest, "--connection-id"),
          profile: flagValue(rest, "--profile"),
          scope: flagValue(rest, "--scope") || "project",
          allowFullActions: rest.includes("--allow-full-actions"),
          dryRun: rest.includes("--dry-run"),
        };
        out(await runChatgptWorkInstall(installOptions));
      } else if (rest[0] === "kimi") {
        out(await runKimiInstall({ dryRun: rest.includes("--dry-run"), probe: rest.includes("--probe") }));
      } else out(await runInstall({ home: rest[0] || homedir() }));
    } else if (cmd === "uninstall") {
      if (rest[0] === "codex") {
        out(await runCodexUninstall({ scope: flagValue(rest, "--scope") || "project", dryRun: rest.includes("--dry-run") }));
      } else if (rest[0] === "kimi") {
        out(await runKimiUninstall({ dryRun: rest.includes("--dry-run") }));
      } else out(await runUninstall({ home: rest[0] || homedir() }));
    } else if (cmd === "signals") {
      const dir = resolve(rest[0] || process.cwd());
      await ensureContainedDirectory(dir);
      for (const name of ["package.json", ".git", "tsconfig.json", "pnpm-lock.yaml", "yarn.lock", "package-lock.json", "pnpm-workspace.yaml"]) {
        await inspectContainedPath(dir, join(dir, name));
      }
      const profile = await detectProject(dir);
      const caps = resolveCapabilities(await loadCatalog(CATALOG_DIR), await readInstalled(homedir()));
      const sig = buildSignals(profile, caps);
      const signalsDir = join(dir, ".muster");
      await ensureContainedDirectory(dir, signalsDir);
      await writeContainedFile(dir, join(signalsDir, "signals.json"), JSON.stringify(sig, null, 2));
      out(sig);
    // ── memory + ops (cont.): burn-hygiene guards -- zombie provider processes, stale
    // worktrees, stale coordination claims. Report-only by default; --reap opts into
    // killing orphaned processes and auto-releasing stale claims (never worktree removal --
    // that stays a human decision, see src/hygiene.js's file-level note).
    } else if (cmd === "hygiene") {
      const reap = rest.includes("--reap");
      const json = rest.includes("--json");
      const backlogPath = flagValue(rest, "--backlog") || join(".muster", "backlog.md");
      // Validate every mutation-controlling number before runHygiene can reap a
      // process or release a claim. Zero is a real override; only absence gets
      // the default/null behavior.
      const hygieneNumber = (flag, fallback, multiplier = 1) => {
        const raw = flagValue(rest, flag);
        if (raw === undefined) {
          if (rest.includes(flag)) fail(`hygiene ${flag} must be a non-negative finite number`);
          return fallback;
        }
        // JSON-number syntax keeps coercion-only spellings (blank strings,
        // whitespace, hex, numeric separators, leading "+") out while retaining
        // zero, fractions, and exponents.
        if (!/^(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(raw)) {
          fail(`hygiene ${flag} must be a non-negative finite number`);
        }
        const value = Number(raw);
        if (!Number.isFinite(value) || value < 0 || !Number.isFinite(value * multiplier)) {
          fail(`hygiene ${flag} must be a non-negative finite number`);
        }
        return value;
      };
      const worktreeThreshold = hygieneNumber("--worktree-threshold", DEFAULT_WORKTREE_THRESHOLD);
      const zombieStaleMin = hygieneNumber("--zombie-stale-min", null, 60_000);
      const claimStaleMin = hygieneNumber("--claim-stale-min", null, 60_000);

      // Pin the read to a no-follow regular-file descriptor. Keep its identity
      // for the --reap publication gate: a later path replacement must abort,
      // never redirect the released-claim write into an external symlink target.
      const absoluteBacklogPath = resolve(backlogPath);
      const assertNoSymlinkAncestors = async () => {
        let component = dirname(absoluteBacklogPath);
        while (true) {
          try {
            if ((await lstat(component)).isSymbolicLink()) {
              throw new Error(`hygiene backlog path must not contain symlinks: ${backlogPath}`);
            }
          } catch (error) {
            if (error.code !== "ENOENT") throw error;
          }
          const parent = dirname(component);
          if (parent === component) break;
          component = parent;
        }
      };
      let backlogIdentity = null;
      let backlogBytes = null;
      const readPinnedBacklog = async (expectedInfo = null) => {
        await assertNoSymlinkAncestors();
        const pathInfo = await lstat(absoluteBacklogPath);
        if (!pathInfo.isFile()) {
          throw new Error(`unsafe regular file: hygiene backlog ${backlogPath}`);
        }
        if (expectedInfo &&
            (pathInfo.ino !== expectedInfo.ino || pathInfo.dev !== expectedInfo.dev)) {
          throw new Error(`file changed while reading: hygiene backlog ${backlogPath}`);
        }
        // fs-safe's generic reader degrades to a zero flag on runtimes without
        // O_NOFOLLOW. Hygiene is mutation-capable, so a present regular backlog
        // instead fails closed. Checking after lstat lets an absent backlog
        // retain its established no-op behavior. The env arm is a test fixture
        // for otherwise-unavailable platforms; it can only make the command
        // more restrictive.
        if (!fsConstants.O_NOFOLLOW || process.env.MUSTER_TEST_FORCE_NO_NOFOLLOW === "1") {
          throw new Error("hygiene backlog cannot be read safely: O_NOFOLLOW is unavailable");
        }
        // expectedInfo pins the explicit final-component lstat to the descriptor
        // opened O_NOFOLLOW inside readNoFollowRegular.
        return readNoFollowRegular(absoluteBacklogPath, {
          maxBytes: MAX_HYGIENE_BACKLOG_BYTES,
          label: `hygiene backlog ${backlogPath}`,
          expectedInfo: pathInfo,
        });
      };
      const readBacklog = async () => {
        try {
          const { bytes, info } = await readPinnedBacklog();
          backlogIdentity = info;
          backlogBytes = bytes;
          return bytes.toString("utf8");
        } catch (error) {
          if (error.code === "ENOENT") return null;
          throw error;
        }
      };
      const executeHygiene = async () => {
        const result = await runHygiene({
          backlogContent: readBacklog,
          reap,
          zombieOptions: zombieStaleMin != null ? { staleMs: zombieStaleMin * 60_000 } : {},
          worktreeOptions: { threshold: worktreeThreshold },
          claimOptions: claimStaleMin != null ? { staleMs: claimStaleMin * 60_000 } : {},
          dispatchReceiptStore: ({ processes, reap: shouldClean }) =>
            readDispatchReceipts({ processes, reap: shouldClean }),
        });
        if (reap && result.claims.content != null && result.claims.releases.length > 0) {
          await atomicWrite(absoluteBacklogPath, result.claims.content, {
            mode: backlogIdentity.mode & 0o777,
            beforeRename: async () => {
              const current = await readPinnedBacklog(backlogIdentity);
              if (!current.bytes.equals(backlogBytes)) {
                throw new Error(`hygiene backlog content changed before publication: ${backlogPath}`);
              }
            },
          });
        }
        return result;
      };
      // Mutation-capable hygiene holds the SAME cooperative lock required of
      // claim/heartbeat/completion writers for its entire read-transform-
      // validate-publish transaction. Report-only hygiene remains lock-free.
      // If the parent itself is absent, no lock can be created and there is no
      // backlog to mutate; preserve hygiene's established missing-backlog
      // no-op instead of manufacturing .muster solely for a lock file.
      let backlogParentExists = true;
      try {
        await lstat(dirname(absoluteBacklogPath));
      } catch (error) {
        if (error.code === "ENOENT") backlogParentExists = false;
        else throw error;
      }
      const result = reap && backlogParentExists
        ? await withFileMutationLock(absoluteBacklogPath, executeHygiene)
        : await executeHygiene();
      if (json) out(result);
      else process.stdout.write(renderHygieneReport(result) + "\n");
    } else {
      fail(`unknown command: ${[cmd, ...rest].join(" ")}\n${USAGE}`);
    }
  } catch (e) {
    fail(formatError(e));
  }
}

// cli.js is the bin entry — run it. Pure helpers live in cli-args.js so tests
// never need to import this file (which would trigger dispatch).
await main();
