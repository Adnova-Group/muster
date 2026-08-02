import { existsSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve, sep } from "node:path";
import { KIMI_LANES, kimiLaneEnv, kimiPreferenceForAgentId } from "./kimi.js";
import { dispatchRetryState } from "./loop.js";

const SHA256_RE = /^[0-9a-f]{64}$/;

// Parent-owned lifecycle evidence for Kimi resumes. Agent output cannot select
// its own fingerprint: the parent supplies the candidate and normalized error
// digests, and the shared non-waivable continuation backstop decides whether a
// further native resume is legal.
export function kimiResumeState({ attempts = [], succeeded = false, noProgressLimit, maxContinuations, ...unknown } = {}) {
  if (Object.keys(unknown).length) throw new TypeError(`unsupported Kimi resume policy fields: ${Object.keys(unknown).join(", ")}`);
  if (!Array.isArray(attempts) || attempts.some((attempt) => !attempt
    || !SHA256_RE.test(attempt.candidateFingerprint ?? "")
    || !SHA256_RE.test(attempt.errorFingerprint ?? ""))) {
    throw new TypeError("Kimi resume attempts must carry parent-computed candidate and error sha256 fingerprints");
  }
  return dispatchRetryState({
    ...(noProgressLimit === undefined ? {} : { noProgressLimit }),
    ...(maxContinuations === undefined ? {} : { maxContinuations }),
    succeeded,
    outcomes: attempts.map((attempt) => `${attempt.candidateFingerprint}\0${attempt.errorFingerprint}`),
  });
}

// ───────────────────────────────────────────────────────────────────────────
// Kimi-native dispatch: AgentSwarm (waves) + /goal (the run loop)
//
// The harness-native counterpart to wave-dispatch.js's Codex spawn_agent lane.
// Where Codex offers only per-agent spawn (muster supplies the fan-out, the
// barrier, and the aggregation), Kimi ships BOTH halves natively:
//
//   AgentSwarm  -> fan-out + barrier + aggregated report, in ONE tool call
//   /goal       -> the continue-until-done loop, with machine-readable
//                  terminal states delivered as process exit codes
//
// so muster keeps the judgment (what the waves ARE, what the objective SAYS)
// and hands the mechanics to the harness -- the harness-native-first posture.
//
// EVIDENCE NOTE. The constants below are read from the shipped kimi binary's
// own tool schema (`~/.kimi-code/bin/kimi`, v0.29.0, unstripped; re-verified
// on v0.30.0, 2026-07-29), not inferred
// from prose. That matters because the published docs state the placeholder
// exists without ever naming it, and omit the distinct-prompts rule entirely.
// Where the binary and the docs disagree, the binary is what actually runs.
// ───────────────────────────────────────────────────────────────────────────

// --- AgentSwarm -------------------------------------------------------------

// Verbatim from the binary: `PROMPT_TEMPLATE_PLACEHOLDER = "{{item}}"`, and the
// tool description's own words -- "The placeholder is exactly `{{item}}`."
export const KIMI_SWARM_PLACEHOLDER = "{{item}}";
export const KIMI_SWARM_MAX_SUBAGENTS = 128;
export const KIMI_SWARM_MIN_ITEMS = 2;

// The swarm's model lane. Kimi accepts only the symbolic pair -- never a model
// id (src/kimi.js's KIMI_LANES explains the tier->lane fold).
const LANES = Object.keys(KIMI_LANES);

// Kimi rejects a malformed swarm BEFORE any subagent starts ("a violation is
// rejected before any subagent starts"), so a bad packet costs a whole wave's
// round trip. muster validates the same four rules up front and fails loud with
// the offending detail, rather than discovering them from a rejection:
//   1. items >= 2 unless resume_agent_ids is present
//   2. prompt_template is required whenever items are present
//   3. prompt_template must contain {{item}}
//   4. the FILLED prompts must be distinct -- "two items that expand to the
//      same prompt are rejected". This rule appears nowhere in the published
//      docs; it is enforced in the binary. Duplicate wave items are exactly
//      how muster would trip it (e.g. two crew members handed the same file).
export function kimiSwarmCall({ promptTemplate, items = [], subagentType, model, resumeAgentIds } = {}) {
  // resume_agent_ids maps a PRIOR subagent's agent id to the prompt used to
  // resume it -- the orchestrator's progress-aware failure rule rides this:
  // a failed swarm member is resumed with only the error context appended,
  // keeping its prior context instead of paying a fresh full prompt again.
  if (resumeAgentIds !== undefined) {
    if (typeof resumeAgentIds !== "object" || resumeAgentIds === null || Array.isArray(resumeAgentIds)) {
      throw new Error("kimiSwarmCall: resumeAgentIds must be a map of prior agent id -> resume prompt");
    }
    for (const [id, prompt] of Object.entries(resumeAgentIds)) {
      if (!id) throw new Error("kimiSwarmCall: resumeAgentIds keys must be prior agent ids (non-empty strings)");
      if (typeof prompt !== "string" || !prompt) {
        throw new Error(`kimiSwarmCall: resumeAgentIds[${JSON.stringify(id)}] must be the resume prompt (the appended error context), a non-empty string`);
      }
    }
  }
  const resume = resumeAgentIds && Object.keys(resumeAgentIds).length ? resumeAgentIds : null;
  if (!Array.isArray(items)) throw new Error("kimiSwarmCall: items must be an array");
  if (!items.length && !resume) throw new Error("kimiSwarmCall: pass items or resumeAgentIds");
  if (items.length && !resume && items.length < KIMI_SWARM_MIN_ITEMS) {
    throw new Error(`kimiSwarmCall: AgentSwarm requires at least ${KIMI_SWARM_MIN_ITEMS} items (got ${items.length}); use a single Agent call instead`);
  }
  if (items.length > KIMI_SWARM_MAX_SUBAGENTS) {
    throw new Error(`kimiSwarmCall: AgentSwarm supports at most ${KIMI_SWARM_MAX_SUBAGENTS} subagents (got ${items.length})`);
  }
  if (items.length && typeof promptTemplate !== "string") {
    throw new Error("kimiSwarmCall: prompt_template is required when items are provided");
  }
  if (typeof promptTemplate === "string" && !promptTemplate.includes(KIMI_SWARM_PLACEHOLDER)) {
    throw new Error(`kimiSwarmCall: prompt_template must contain the ${KIMI_SWARM_PLACEHOLDER} placeholder`);
  }
  if (model !== undefined && !LANES.includes(model)) {
    throw new Error(`kimiSwarmCall: model must be one of ${LANES.join("|")} (Kimi takes a lane, never a model id); got ${JSON.stringify(model)}`);
  }
  if (items.length) {
    const filled = items.map(item => promptTemplate.split(KIMI_SWARM_PLACEHOLDER).join(item));
    const seen = new Set();
    for (const [index, prompt] of filled.entries()) {
      if (seen.has(prompt)) {
        throw new Error(`kimiSwarmCall: items must expand to DISTINCT prompts -- item ${index} (${JSON.stringify(items[index])}) repeats an earlier prompt; Kimi rejects the whole swarm`);
      }
      seen.add(prompt);
    }
  }
  return {
    tool: "AgentSwarm",
    ...(promptTemplate !== undefined ? { prompt_template: promptTemplate } : {}),
    ...(items.length ? { items: [...items] } : {}),
    ...(resume ? { resume_agent_ids: { ...resume } } : {}),
    ...(subagentType ? { subagent_type: subagentType } : {}),
    ...(model ? { model } : {}),
    // Not a field -- a caller contract. The binary enforces it: "If AgentSwarm
    // is called, that call must be the only tool call in the response."
    soleToolCall: true
  };
}

// One wave task as a single Agent call -- the right shape when a wave's crew
// members are differently-shaped ("For a few differently-shaped tasks, make
// separate `Agent` calls in one message instead"), which is muster's usual
// case: a wave is typically N DISTINCT roles, not one task over N inputs.
// `agentId` is the crew member's resolved chosen.id; its lane is derived from
// the shared manifest so a dispatch can never contradict the installed
// agent file's stamped model_preference.
//
// `resume` is the failure-retry path (orchestrator step 4a's progress-aware
// rule on Kimi): Kimi's `resume` takes the FAILED subagent's agent id and is
// mutually exclusive with `subagent_type`, and a resumed subagent keeps its
// prior context AND its model (an explicit `model` is "ignored when
// resuming") -- so the retry packet carries neither, only the error context
// as the new prompt. That is the whole point: the retry never pays the full
// prompt/context cost a fresh spawn would.
export function kimiAgentCall({ agentId, prompt, description, background = false, model, resume } = {}) {
  if (resume !== undefined && (typeof resume !== "string" || !resume)) {
    throw new Error("kimiAgentCall: resume must be the failed subagent's agent id (a non-empty string)");
  }
  if (resume && agentId) {
    throw new Error("kimiAgentCall: resume is mutually exclusive with agentId -- Kimi pairs resume with no subagent_type; the resumed subagent keeps its own type");
  }
  if (!resume && (typeof agentId !== "string" || !agentId)) throw new Error("kimiAgentCall: agentId is required (the crew member's resolved chosen.id)");
  if (typeof prompt !== "string" || !prompt) throw new Error(`kimiAgentCall: prompt is required for agent "${agentId || resume}"`);
  if (model !== undefined && !LANES.includes(model)) {
    throw new Error(`kimiAgentCall: model must be one of ${LANES.join("|")}; got ${JSON.stringify(model)}`);
  }
  if (resume) {
    return {
      tool: "Agent",
      resume,
      prompt,
      description: description || `retry ${resume}`,
      ...(background ? { run_in_background: true } : {})
    };
  }
  // An explicit tool-call model wins over the profile's model_preference; when
  // the caller does not force one, derive the agent's own lane so the dispatch
  // agrees with what `muster install kimi` stamped into its frontmatter.
  const lane = model ?? kimiPreferenceForAgentId(agentId) ?? undefined;
  return {
    tool: "Agent",
    subagent_type: agentId,
    prompt,
    description: description || agentId,
    ...(background ? { run_in_background: true } : {}),
    ...(lane ? { model: lane } : {})
  };
}

// --- Background legs (run_in_background) -------------------------------------

// `background: true` maps to Kimi's `run_in_background`: the dispatch returns a
// TASK ID immediately (the parent does NOT wait) and the result arrives in a
// LATER turn as a synthetic user message, with the on-disk receipt at the
// session's tasks/<task_id>.json + tasks/<task_id>/output.log
// (docs/research/kimi-code-cli.md secs 6+8). muster never polls a backgrounded
// leg -- the completion arrives on its own -- so the fold-back is a pure
// function of the completion receipt:
//   completed -> the synthetic message's body IS the subagent's final message
//     (the whole handoff, same return contract as a foreground leg); fold it
//     back verbatim.
//   failed (any terminal state that is not completed) -> the leg re-enters
//     orchestrator step 4a's progress-aware rule (a resume retry on Kimi) --
//     a backgrounded leg is never a silent drop.
//   anything else -> still in flight: pending. The wave's barrier does NOT
//     cover a pending leg -- which is exactly why barrier-gated work never
//     dispatches background (orchestrator/references/kimi-dispatch.md).
export function interpretKimiBackgroundCompletion({ status, result, terminalReason } = {}) {
  if (status === "completed") {
    return {
      status: "complete",
      terminal: true,
      result,
      reason: "completion receipt arrived as a synthetic user message -- the body is the subagent's final message, the whole handoff"
    };
  }
  if (status === "failed" || status === "stopped" || status === "timed_out") {
    return {
      status: "failed",
      terminal: true,
      reason: `background leg ended ${status}${terminalReason ? ` (${terminalReason})` : ""} -- re-enters the progress-aware fingerprint rule (a resume retry), never a silent drop`
    };
  }
  return { status: "pending", terminal: false, reason: "no completion receipt yet -- the leg is still in flight and the wave's barrier does not cover it" };
}

// --- /goal: the run loop ----------------------------------------------------

// Verbatim from the binary: `GOAL_EXIT_CODES = { complete: 0, blocked: 3,
// paused: 6 }` and `MAX_GOAL_OBJECTIVE_LENGTH = 4000`.
export const KIMI_GOAL_EXIT_CODES = Object.freeze({ complete: 0, blocked: 3, paused: 6 });
export const KIMI_GOAL_MAX_OBJECTIVE = 4000;

// Briefs ride argv as the `-p` prompt -- the same budget class as a /goal
// objective (which is itself a `-p "/goal <objective>"` argument). No separate
// binary limit is documented for a bare -p prompt, so the objective cap is
// adopted as the conservative bound.
export const KIMI_PROCESS_MAX_BRIEF = KIMI_GOAL_MAX_OBJECTIVE;

// --- Quota/balance fail-fast (kimi 0.30.0) ------------------------------------

// EVIDENCE NOTE. The 0.30.0 changelog: "Fail fast when account quota or balance
// is exhausted instead of silently retrying for ~3 minutes." The account quota
// cannot be exhausted on demand to probe the live stream shape, so the
// signature below is read VERBATIM from the installed 0.30.0 binary's own quota
// classifier (packages/kosong/src/providers/kimi-errors.ts, via strings on
// ~/.kimi-code/bin/kimi; full evidence in docs/research/kimi-code-cli.md
// §11.12): the binary maps a 429 carrying these codes/wordings onto
// APIProviderQuotaExhaustedError, serializes it with retryable: false, and its
// own retry policy refuses to retry it. muster matches exactly what the binary
// itself classifies on -- nothing more, nothing invented.
export const KIMI_QUOTA_ERROR_NAME = "APIProviderQuotaExhaustedError";
export const KIMI_QUOTA_ERROR_CODES = Object.freeze(["exceeded_current_quota_error", "insufficient_quota"]);
export const KIMI_QUOTA_MESSAGE_PATTERNS = Object.freeze([
  /exceeded your current (?:token )?quota/i,
  /check your account balance/i,
  /insufficient balance/i,
  /recharge your account|please recharge/i,
  /account (?:is )?in arrears/i
]);

// Detect the quota/balance fail-fast signature in a kimi process's captured
// output (stream-json stdout or stderr text). Returns the matched signal --
// the error class name, a structured provider code, or the wording pattern's
// source -- or null. The error-name hit covers the stream-json `error` event,
// whose wire payload carries `name: "APIProviderQuotaExhaustedError"` (the
// binary's toKimiErrorPayload keeps the name field).
export function detectKimiQuotaFault(text) {
  if (typeof text !== "string" || !text) return null;
  if (text.includes(KIMI_QUOTA_ERROR_NAME)) return KIMI_QUOTA_ERROR_NAME;
  const code = KIMI_QUOTA_ERROR_CODES.find(candidate => text.includes(candidate));
  if (code) return code;
  const pattern = KIMI_QUOTA_MESSAGE_PATTERNS.find(candidate => candidate.test(text));
  return pattern ? pattern.source : null;
}

// Scope a captured output stream to its ERROR-SURFACE lines before the quota
// match: stream-json {"type":"error"} events plus raw `error:`-prefixed lines.
// Matching the whole stream lets injected or merely topical billing text in
// assistant/tool output (a payments codebase discussing balances) flip a
// resumable paused run into a non-resumable billing escalation. detectKimiQuotaFault's
// own signature is unchanged -- callers that already hold scoped text keep
// passing it straight through.
export function quotaFaultLines(stdout) {
  if (typeof stdout !== "string") return "";
  return stdout.split("\n").filter((line) => {
    if (line.startsWith("error:")) return true;
    try { return JSON.parse(line).type === "error"; } catch { return false; }
  }).join("\n");
}

// Map a `kimi -p "/goal ..."` process exit code onto muster's run disposition.
// This is the whole reason /goal is worth adopting: muster's escalation signal
// arrives as an exit code instead of being parsed out of a STATE file.
//   complete -> the objective's own evidence was satisfied; finish/disposition
//   blocked  -> needs input, cannot proceed as stated, or hit a budget limit
//               == muster's ESCALATION, and the goal writes its own reason
//   paused   -> interrupted / resumed / model-or-runtime error; resumable
// Any other code is a harness fault, not a goal outcome -- never silently
// treated as an escalation (that would report a crash as a clean stop).
//
// `output` (optional) is the process's captured stdout/stderr text. When its
// ERROR-SURFACE lines (quotaFaultLines: stream-json {"type":"error"} events
// plus raw `error:` lines) carry the 0.30.0 quota/balance fail-fast signature
// (detectKimiQuotaFault), a non-complete exit is reclassified as a BILLING
// escalation -- kind: "billing", escalate: true, resumable: false: the binary itself marks the
// fault retryable: false, so an unattended resume/retry loop only re-pays a
// guaranteed-fail round trip until a human recharges the account. Only after
// the recharge does the paused goal's resume path apply. A complete exit is
// never reclassified (the goal's own evidence was satisfied; a quota string in
// its output is incidental).
export function interpretKimiGoalExit(code, output) {
  const status = Object.keys(KIMI_GOAL_EXIT_CODES).find(name => KIMI_GOAL_EXIT_CODES[name] === code);
  const quotaSignal = status !== "complete" ? detectKimiQuotaFault(quotaFaultLines(output)) : null;
  if (!status) {
    return {
      status: "failed",
      terminal: true,
      escalate: true,
      ...(quotaSignal ? { kind: "billing" } : {}),
      reason: quotaSignal
        ? `kimi exited ${code} on a quota/balance fault (matched ${JSON.stringify(quotaSignal)}) -- BILLING escalation: recharge the account, then re-run; never an unattended retry (kimi 0.30.0 marks it retryable: false)`
        : `kimi exited ${code} -- not a /goal terminal state`
    };
  }
  return {
    status,
    terminal: status === "complete",
    escalate: status === "blocked" || quotaSignal !== null,
    resumable: status === "paused" && !quotaSignal,
    ...(quotaSignal ? { kind: "billing" } : {}),
    reason: quotaSignal
      ? `goal ${status} on a quota/balance fault (matched ${JSON.stringify(quotaSignal)}) -- BILLING escalation: recharge the account, THEN resume the goal; never an unattended retry (kimi 0.30.0 marks it retryable: false)`
      : { complete: "goal satisfied", blocked: "goal blocked -- needs input or hit a limit", paused: "goal paused -- resumable" }[status]
  };
}

// Build the argv + env for an unattended `kimi -p "/goal <objective>"` run.
//
// Why the objective carries the acceptance criteria rather than a checklist
// file: "/goal does not have a separate stop-limit flag. Write stop conditions
// into the objective", and goals "work best when the objective names the finish
// line and the evidence that proves it". So muster's assessed acceptance
// criteria compile straight INTO the objective string -- the same enrichment,
// spent on the harness's own loop instead of on a file muster re-reads.
//
// The env pair is what binds the model lanes (src/kimi-install.js): per-process,
// so nothing in the user's shared config.toml is touched. It comes from
// kimiLaneEnv() -- the single derivation in src/kimi.js -- so this run loop,
// the install report, and `muster doctor` can never disagree on the bind.
// Note the flag is also what selects the v2 engine under `kimi -p`, which is
// what makes model_preference bite at all.
export function kimiGoalInvocation({ objective, primaryModel = KIMI_LANES.primary, secondaryModel = KIMI_LANES.secondary, streamJson = false } = {}) {
  if (typeof objective !== "string" || !objective.trim()) throw new Error("kimiGoalInvocation: objective is required");
  if (objective.length > KIMI_GOAL_MAX_OBJECTIVE) {
    throw new Error(`kimiGoalInvocation: objective is ${objective.length} chars; Kimi caps it at ${KIMI_GOAL_MAX_OBJECTIVE}`);
  }
  if (/^\/goal(\s|$)/.test(objective)) throw new Error("kimiGoalInvocation: pass the bare objective; the /goal prefix is added here");
  return {
    argv: ["-p", `/goal ${objective}`, ...(streamJson ? ["--output-format", "stream-json"] : []), "-m", primaryModel],
    env: {
      // Selects the v2 engine AND enables the secondary-model experiment; the
      // lane model follows the (rarely overridden) secondaryModel argument.
      // An OVERRIDE pair: merge over the ambient env at spawn
      // (`{ ...process.env, ...env }`), never pass as the whole env.
      ...kimiLaneEnv(),
      KIMI_SECONDARY_MODEL: secondaryModel
    },
    exitCodes: KIMI_GOAL_EXIT_CODES
  };
}

// --- Headless process dispatch (`kimi -p --agent-file`) ----------------------

// Where `muster install kimi` places the stamped agent files
// (src/kimi-install.js): $KIMI_CODE_HOME/agents, else ~/.kimi-code/agents.
// Resolved per call so a relocated Kimi home (and tests) are honored.
const kimiAgentsDir = () => join(process.env.KIMI_CODE_HOME || join(homedir(), ".kimi-code"), "agents");

// Build the argv + env for a headless `kimi -p <brief> --agent-file <path>`
// process -- a wave leg dispatched as its OWN Kimi process rather than as an
// in-session Agent/AgentSwarm call. `--agent-file` binds a custom MAIN agent
// (docs/research/kimi-code-cli.md section 9, "How muster would actually drive
// Kimi non-interactively"), which requires the v2 engine. The kimiLaneEnv()
// pair rides for BOTH of its keys, not the flag alone: KIMI_CODE_EXPERIMENTAL_FLAG=1
// selects the engine --agent-file needs, and KIMI_SECONDARY_MODEL binds the
// lanes for any subagents the dispatched -p process itself spawns -- which is
// exactly where the stamped model_preference bites. It never binds the -p
// process's own MAIN agent (sections 6 + 11.8) -- so the process's model comes
// ONLY from `-m`.
//
// LANE IS THEREFORE REQUIRED AND ALWAYS EMITTED as `-m KIMI_LANES[lane]`.
// Omitting -m is not neutral: the process would silently fall to config.toml's
// default_model (k3), demoting an execution-lane leg onto the judgment model
// (and its quota) with no signal. There is no construction path without -m.
export function kimiProcessDispatch({ brief, agentFile, cwd, lane } = {}) {
  if (typeof brief !== "string" || !brief.trim()) {
    throw new Error("kimiProcessDispatch: brief is required (the -p prompt the dispatched process runs)");
  }
  if (brief.length > KIMI_PROCESS_MAX_BRIEF) {
    throw new Error(`kimiProcessDispatch: brief is ${brief.length} chars; cap is ${KIMI_PROCESS_MAX_BRIEF} -- briefs ride argv as the -p prompt, the same budget class as a /goal objective`);
  }
  if (!LANES.includes(lane)) {
    throw new Error(`kimiProcessDispatch: lane is required and must be one of ${LANES.join("|")} -- model_preference never binds the -p process's own main agent, so its model comes ONLY from -m; omitting it silently falls to config default_model; got ${JSON.stringify(lane)}`);
  }
  if (typeof cwd !== "string" || !cwd) {
    throw new Error("kimiProcessDispatch: cwd is required (the directory the process runs in)");
  }
  let resolvedCwd = resolve(cwd);
  if (!existsSync(resolvedCwd) || !statSync(resolvedCwd).isDirectory()) {
    throw new Error(`kimiProcessDispatch: cwd must be an existing directory; got ${JSON.stringify(cwd)}`);
  }
  resolvedCwd = realpathSync(resolvedCwd);
  if (typeof agentFile !== "string" || !agentFile) {
    throw new Error("kimiProcessDispatch: agentFile is required (a name under the installed agents dir, or an explicit path)");
  }
  // A bare name resolves under the installed agents dir; anything carrying a
  // path separator is an explicit path (absolute as-is, or relative to the
  // run's cwd). Either way the file must exist -- discovered here, not from a
  // failed spawn.
  let resolvedAgentFile;
  if (isAbsolute(agentFile)) {
    resolvedAgentFile = agentFile;
  } else if (agentFile.includes("/") || agentFile.includes(sep)) {
    resolvedAgentFile = resolve(resolvedCwd, agentFile);
  } else {
    resolvedAgentFile = join(kimiAgentsDir(), agentFile);
  }
  if (!existsSync(resolvedAgentFile) || !statSync(resolvedAgentFile).isFile()) {
    throw new Error(`kimiProcessDispatch: agentFile ${JSON.stringify(agentFile)} resolved to ${resolvedAgentFile}, which does not exist (bare names resolve under the installed agents dir ${kimiAgentsDir()}; explicit paths resolve against cwd)`);
  }
  resolvedAgentFile = realpathSync(resolvedAgentFile);
  const cwdInfo = statSync(resolvedCwd);
  const agentFileInfo = statSync(resolvedAgentFile);
  return {
    argv: ["-p", brief, "--agent-file", resolvedAgentFile, "--output-format", "stream-json", "-m", KIMI_LANES[lane]],
    // An OVERRIDE pair: merge over the ambient env at spawn
    // (`{ ...process.env, ...d.env }`), never pass as the whole env -- a
    // wholesale replacement loses HOME/PATH and the child breaks.
    env: kimiLaneEnv(),
    cwd: resolvedCwd,
    pathBindings: {
      cwd: { dev: cwdInfo.dev, ino: cwdInfo.ino },
      agentFile: { path: resolvedAgentFile, dev: agentFileInfo.dev, ino: agentFileInfo.ino },
    },
    lane
  };
}

// --- Wave dispatch mode selection -------------------------------------------

export const KIMI_DISPATCH_MODES = Object.freeze({
  SWARM: "agent-swarm",
  AGENT_CALLS: "agent-calls"
});

// Pick the native shape for a wave, mirroring resolveCodexWaveDispatch's
// declared-not-probed posture. The choice is structural, straight from the
// binary's own guidance: AgentSwarm is for "the same kind of task over
// different inputs"; "For a few differently-shaped tasks, make separate `Agent`
// calls in one message instead."
//
// muster waves are usually the SECOND shape -- a wave is N distinct roles
// (builder + test-author + reviewer), not one template over N inputs -- so
// agent-calls is the default and swarm is selected only for a genuinely
// uniform fan-out (audit N files, review N modules), which is also the only
// shape that can satisfy the distinct-prompts rule cleanly.
export function resolveKimiWaveDispatch({ items = [], uniformTask = false } = {}) {
  if (uniformTask && items.length >= KIMI_SWARM_MIN_ITEMS) {
    return {
      mode: KIMI_DISPATCH_MODES.SWARM,
      reason: `uniform task over ${items.length} inputs -- one AgentSwarm call fans out, barriers, and returns an aggregated report (must be the sole tool call in its response)`,
      concurrencyEnv: "KIMI_CODE_AGENT_SWARM_MAX_CONCURRENCY"
    };
  }
  return {
    mode: KIMI_DISPATCH_MODES.AGENT_CALLS,
    reason: items.length < KIMI_SWARM_MIN_ITEMS
      ? `only ${items.length} item(s) -- below AgentSwarm's ${KIMI_SWARM_MIN_ITEMS}-item floor; dispatch as Agent calls`
      : "differently-shaped crew roles -- separate Agent calls in one message, per Kimi's own guidance; AgentSwarm is for one task over many inputs"
  };
}
