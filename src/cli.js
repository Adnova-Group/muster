#!/usr/bin/env node
import { detectProject, hasPromptingSignal } from "./detect.js";
import { loadCatalog } from "./catalog.js";
import { readInstalled, readInstalledCowork } from "./harness.js";
import { resolveCapabilities } from "./capabilities.js";
import { validateManifest, manifestWarnings } from "./manifest.js";
import { writeMemory, readMemory } from "./memory.js";
import { computeWaves, nextTasks } from "./wave.js";
import { computeSprintWaves } from "./sprint-waves.js";
import { tallyReview } from "./review.js";
import { pickWinner } from "./tournament.js";
import { homedir } from "node:os";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { runDoctor } from "./doctor.js";
import { initScratchpad } from "./scratchpad.js";
import { readProfile } from "./profile.js";
import { buildSignals } from "./signals.js";
import { validateVendorManifest, runVendor } from "./vendor.js";
import { parse as parseYaml } from "yaml";
import { scaffoldProject } from "./setup.js";
import { renderPlanChecklist } from "./checklist.js";
import { classifyDomain } from "./domain.js";
import { loadPipelines, pipelineForDomain, routePipeline } from "./pipeline.js";
import { scoreArtifact } from "./score.js";
import { classifyFailure, buildDiagnoseManifest } from "./diagnose.js";
import { buildAuditManifest } from "./audit.js";
import { runInstall, runUninstall } from "./install.js";
import { runCodexInstall, runCodexUninstall } from "./codex-install.js";
import { runCodexDoctor } from "./codex-doctor.js";
import { readCodexInventory } from "./codex-inventory.js";
import { adaptCatalogForCodex } from "./codex-catalog.js";
import { assessOutcome } from "./interview.js";
import { parseDomainArgs, formatError, requireArg, flagValue } from "./cli-args.js";
import { dirFromImportMeta } from "./fs-util.js";
import { matchProviders, matchSkills, suggestSkillsForStack, signalsFromTask } from "./match.js";
import { prioritize } from "./prioritize.js";
import { parseIssueRef, resolveIssue } from "./issue.js";
import { classifySteer } from "./steer.js";
import { lintPrompt, lintChat, lintWorkflow } from "./prompt-lint.js";
import { scoreHumanness } from "./humanizer-score.js";
import { checkCitations } from "./citation-guard.js";
import { gradeCollected } from "./prompt-eval.js";
import { proposeVariations, selectWinner } from "./prompt-optimize.js";
import { scanRepoPrompts } from "./prompt-scan.js";
import { fuse } from "./fusion.js";
import { validateAdviceRequest } from "./advisor.js";
import { modelForRole } from "./model.js";
import { detectScope } from "./scope.js";
import { runHygiene, renderHygieneReport, DEFAULT_WORKTREE_THRESHOLD } from "./hygiene.js";
import { resolveMusterCli } from "./cli-resolve.js";
import { planGateCadence, DEFAULT_REVIEW_DIFF_THRESHOLD } from "./gate-cadence.js";
import { resolveWaveDispatch, resolveWorktreeIsolation, makeGitShaVerifier } from "./wave-dispatch.js";
import { envInt } from "./env-util.js";
import { scoreOutcomeForFastPath, buildFastPathManifest } from "./fast-path.js";
import { detectReviewTriggers, lightBriefEligible } from "./review-brief.js";

const CATALOG_DIR = new URL("../catalog/", import.meta.url);
const USAGE = "Usage: muster <detect|capabilities [--cowork] [--codex] [--role <role>] [--roles-only]|match [--skills] <task> [--stack <csv>]|manifest validate <file>|wave <file>|next <manifest.json> [--done a,b]|resolve-cli|gate-cadence <manifest.json> [--changed-lines N]|wave-dispatch [--agent-teams|--no-agent-teams]|worktree-isolation --harness <claude-code|claude-desktop|hermes|codex>|receipt-verify <sha> --cwd <repo>|fast-path <outcome> [--capabilities <file>]|review-brief --reviewer-count <n> [--diff-files <file>] [--diff-text-file <file>]|sprint-waves <backlog.md>|tally <file>|pick <file>|fuse <candidates.json> <fusion-map.json>|advise <advice-request.json>|memory read|write ...|vendor|setup [dir]|plan-checklist <file>|domain <outcome>|pipeline <domain|id>|route <outcome>|score <file>|prompt <lint|variations|eval|optimize|scan> [file|dir]|humanize-score <file> [--threshold N]|citation-check <file>|prioritize <file> [--model rice|ice|wsjf|weighted]|diagnose <symptom>|--ci <file>|audit [--backlog] [path...]|issue <ref>|assess <outcome>|steer <message>|scope [text]|doctor [--codex]|codex-conformance [YYYY/MM/DD | --days N] [--cwd <substr>] [--current-pins-only]|scratchpad <runId>|profile|install codex [--scope project-or-user] [--dry-run]|uninstall codex [--scope project-or-user] [--dry-run]|signals [dir]|hygiene [--reap] [--json] [--backlog <file>] [--worktree-threshold N] [--zombie-stale-min N] [--claim-stale-min N]|help [command]>";

function out(obj) { process.stdout.write(JSON.stringify(obj, null, 2) + "\n"); }
function fail(msg) { process.stderr.write(`muster: ${msg}\n`); process.exit(1); }

// Shared stdin/text reader for every command that accepts a file-or-stdin arg. Caps stdin so an
// untrusted caller can't pump unbounded input into a linter/scorer (used by `prompt` and `humanize-score`).
const MAX_STDIN_BYTES = 1_048_576; // 1 MB — far above any realistic prompt
function readStdin() {
  return new Promise((resolve, reject) => {
    let d = "", bytes = 0; process.stdin.setEncoding("utf8");
    process.stdin.on("data", c => {
      bytes += Buffer.byteLength(c, "utf8");
      if (bytes > MAX_STDIN_BYTES) { process.stdin.destroy(); reject(new Error(`stdin exceeds ${MAX_STDIN_BYTES} byte limit`)); return; }
      d += c;
    });
    process.stdin.on("end", () => resolve(d));
    process.stdin.on("error", reject);
  });
}
// A "-", a missing arg, or a flag (e.g. `lint --agent`) all mean: read stdin.
const readText = async (arg) =>
  (!arg || arg === "-" || arg.startsWith("--")) ? await readStdin() : await readFile(arg, "utf8");

async function resolveModeCapabilities(args) {
  const catalog = await loadCatalog(CATALOG_DIR);
  const codex = args.includes("--codex");
  const installed = codex
    ? await readCodexInventory({ cwd: process.cwd() })
    : await readInstalled(homedir());
  return resolveCapabilities(codex ? adaptCatalogForCodex(catalog, installed) : catalog, installed);
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
      const role = flagValue(rest, "--role");
      const connectors = flagValue(rest, "--connectors");
      const consumedValues = new Set([role, connectors].filter(Boolean));
      const home = rest.find(a => !a.startsWith("-") && !consumedValues.has(a)) || homedir();
      // --cowork resolves providers from Cowork's MCP registry instead of ~/.claude;
      // declared remote connectors (not disk-discoverable) come from --connectors or env.
      let installed;
      if (rest.includes("--codex")) {
        installed = await readCodexInventory({ cwd: process.cwd() });
      } else if (rest.includes("--cowork")) {
        const declared = (flagValue(rest, "--connectors") || process.env.MUSTER_COWORK_CONNECTORS || "")
          .split(",").map(s => s.trim()).filter(Boolean);
        // Native plugin ride: whether Cowork's own plugin loader (see
        // docs/research/claude-cowork.md section 3d) actually accepted muster's
        // plugin/ tree is unverified and has no on-disk/protocol detection signal,
        // so it is DECLARED the same way remote connectors are -- --native-plugin
        // or MUSTER_COWORK_NATIVE_PLUGIN (MCPB-boolean-safe: only "1"/"true"-ish
        // values enable, mirroring MUSTER_ENABLE_FABLE's parse in src/model.js).
        const nativeFlag = process.env.MUSTER_COWORK_NATIVE_PLUGIN;
        const nativePluginRide = rest.includes("--native-plugin")
          || (!!nativeFlag && nativeFlag !== "0" && nativeFlag.toLowerCase() !== "false");
        installed = await readInstalledCowork(home, { declaredConnectors: declared, nativePluginRide });
      } else {
        installed = await readInstalled(home);
      }
      const capabilities = resolveCapabilities(rest.includes("--codex") ? adaptCatalogForCodex(catalog, installed) : catalog, installed);
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
      const catalog = await loadCatalog(CATALOG_DIR);
      const codex = rest.includes("--codex");
      const installed = codex
        ? await readCodexInventory({ cwd: process.cwd() })
        : await readInstalled(homedir());
      const effectiveCatalog = codex ? adaptCatalogForCodex(catalog, installed) : catalog;
      const { skills } = resolveCapabilities(effectiveCatalog, installed);
      const ranked = matchSkills(task, skills);
      const stackArg = flagValue(rest, "--stack");
      const signals = stackArg
        ? { frameworks: stackArg.split(",").map(s => s.trim().toLowerCase()).filter(Boolean),
            languages: [], keywords: stackArg.split(",").map(s => s.trim().toLowerCase()).filter(Boolean) }
        : signalsFromTask(task);
      const suggested = suggestSkillsForStack(signals, skills);
      out({ ranked, suggested });
    } else if (cmd === "match") {
      const args = rest.filter(arg => arg !== "--codex");
      if (!args[0]) fail("match <task>: missing task");
      const catalog = await loadCatalog(CATALOG_DIR);
      const codex = rest.includes("--codex");
      const installed = codex
        ? await readCodexInventory({ cwd: process.cwd() })
        : await readInstalled(homedir());
      out(matchProviders(args[0], codex ? adaptCatalogForCodex(catalog, installed) : catalog, installed));
    // ── manifest + waves: validate, order, and drive a plan ──
    } else if (cmd === "manifest" && rest[0] === "validate") {
      const args = rest.filter(arg => arg !== "--codex");
      const file = requireArg(args, 1, "manifest validate <file>: missing file path", fail);
      const obj = JSON.parse(await readFile(file, "utf8"));
      const r = validateManifest(obj);
      // Cross-check plan[].skills bindings against the same live skills inventory
      // `capabilities`/`match --skills` resolve (resolveCapabilities().skills), so a
      // hallucinated or uninstalled bound id is actually caught here, not just at the
      // manifestWarnings unit level.
      const catalog = await loadCatalog(CATALOG_DIR);
      const codex = rest.includes("--codex");
      const installed = codex
        ? await readCodexInventory({ cwd: process.cwd() })
        : await readInstalled(homedir());
      const effectiveCatalog = codex ? adaptCatalogForCodex(catalog, installed) : catalog;
      const { skills } = resolveCapabilities(effectiveCatalog, installed);
      const warnings = manifestWarnings(obj, skills);
      const unresolved = codex
        ? warnings.filter(warning => warning.includes("not found in resolveCapabilities().skills"))
        : [];
      const remainingWarnings = warnings.filter(warning => !unresolved.includes(warning));
      const result = unresolved.length
        ? { ok: false, errors: [...r.errors, ...unresolved], ...(remainingWarnings.length ? { warnings: remainingWarnings } : {}) }
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
      // Hermes's `hermes -w`, Codex's receipts-only floor). `--harness` is a declared
      // selection, not auto-probed -- see src/wave-dispatch.js.
      const harness = flagValue(rest, "--harness");
      out(resolveWorktreeIsolation({ harness }));
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
    } else if (cmd === "sprint-waves") {
      const file = requireArg(rest, 0, "sprint-waves <backlog.md>: missing file path", fail);
      const content = await readFile(file, "utf8");
      const r = computeSprintWaves(content);
      out(r);
      if (!r.ok) process.exit(2);
    } else if (cmd === "tally") {
      const file = requireArg(rest, 0, "tally <verdicts.json>: missing file path", fail);
      out(tallyReview(JSON.parse(await readFile(file, "utf8"))));
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
      out({ advisorModel: modelForRole("advisor"), request: req });
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
      const args = rest.filter(arg => arg !== "--codex");
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
      const args = rest.filter(arg => arg !== "--codex" && arg !== "--backlog");
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
      out(buildAuditManifest(caps, { prompting, backlog, paths: args }));
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
      out(classifySteer(rest.join(" ")));
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
      } else out(await runInstall({ home: rest[0] || homedir() }));
    } else if (cmd === "uninstall") {
      if (rest[0] === "codex") {
        out(await runCodexUninstall({ scope: flagValue(rest, "--scope") || "project", dryRun: rest.includes("--dry-run") }));
      } else out(await runUninstall({ home: rest[0] || homedir() }));
    } else if (cmd === "signals") {
      const dir = resolve(rest[0] || process.cwd());
      const profile = await detectProject(dir);
      const caps = resolveCapabilities(await loadCatalog(CATALOG_DIR), await readInstalled(homedir()));
      const sig = buildSignals(profile, caps);
      const signalsDir = join(dir, ".muster");
      await mkdir(signalsDir, { recursive: true });
      await writeFile(join(signalsDir, "signals.json"), JSON.stringify(sig, null, 2));
      out(sig);
    // ── memory + ops (cont.): burn-hygiene guards -- zombie provider processes, stale
    // worktrees, stale coordination claims. Report-only by default; --reap opts into
    // killing orphaned processes and auto-releasing stale claims (never worktree removal --
    // that stays a human decision, see src/hygiene.js's file-level note).
    } else if (cmd === "hygiene") {
      const reap = rest.includes("--reap");
      const json = rest.includes("--json");
      const backlogPath = flagValue(rest, "--backlog") || join(".muster", "backlog.md");
      // `Number.isFinite` (not `|| DEFAULT`) so an explicitly-passed `0` is honored as a
      // real override instead of silently falling back to the default -- `0 || DEFAULT`
      // would otherwise treat "explicitly zero" the same as "flag not passed at all".
      const worktreeThresholdArg = Number(flagValue(rest, "--worktree-threshold"));
      const worktreeThreshold = Number.isFinite(worktreeThresholdArg) ? worktreeThresholdArg : DEFAULT_WORKTREE_THRESHOLD;
      const zombieStaleMinArg = Number(flagValue(rest, "--zombie-stale-min"));
      const zombieStaleMin = Number.isFinite(zombieStaleMinArg) ? zombieStaleMinArg : null;
      const claimStaleMinArg = Number(flagValue(rest, "--claim-stale-min"));
      const claimStaleMin = Number.isFinite(claimStaleMinArg) ? claimStaleMinArg : null;
      const result = await runHygiene({
        backlogContent: () => readFile(backlogPath, "utf8").catch(() => null),
        reap,
        zombieOptions: zombieStaleMin != null ? { staleMs: zombieStaleMin * 60_000 } : {},
        worktreeOptions: { threshold: worktreeThreshold },
        claimOptions: claimStaleMin != null ? { staleMs: claimStaleMin * 60_000 } : {},
      });
      if (reap && result.claims.content != null && result.claims.releases.length > 0) {
        await writeFile(backlogPath, result.claims.content, "utf8");
      }
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
