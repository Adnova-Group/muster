import { KIMI_LANES, kimiLaneEnv, kimiPreferenceForAgentId } from "./kimi.js";

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
// own tool schema (`~/.kimi-code/bin/kimi`, v0.29.0, unstripped), not inferred
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
  // resume it -- the orchestrator's re-dispatch-once failure rule rides this:
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
// `resume` is the failure-retry path (orchestrator step 4a's re-dispatch-once
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

// --- /goal: the run loop ----------------------------------------------------

// Verbatim from the binary: `GOAL_EXIT_CODES = { complete: 0, blocked: 3,
// paused: 6 }` and `MAX_GOAL_OBJECTIVE_LENGTH = 4000`.
export const KIMI_GOAL_EXIT_CODES = Object.freeze({ complete: 0, blocked: 3, paused: 6 });
export const KIMI_GOAL_MAX_OBJECTIVE = 4000;

// Map a `kimi -p "/goal ..."` process exit code onto muster's run disposition.
// This is the whole reason /goal is worth adopting: muster's escalation signal
// arrives as an exit code instead of being parsed out of a STATE file.
//   complete -> the objective's own evidence was satisfied; finish/disposition
//   blocked  -> needs input, cannot proceed as stated, or hit a budget limit
//               == muster's ESCALATION, and the goal writes its own reason
//   paused   -> interrupted / resumed / model-or-runtime error; resumable
// Any other code is a harness fault, not a goal outcome -- never silently
// treated as an escalation (that would report a crash as a clean stop).
export function interpretKimiGoalExit(code) {
  const status = Object.keys(KIMI_GOAL_EXIT_CODES).find(name => KIMI_GOAL_EXIT_CODES[name] === code);
  if (!status) return { status: "failed", terminal: true, escalate: true, reason: `kimi exited ${code} -- not a /goal terminal state` };
  return {
    status,
    terminal: status === "complete",
    escalate: status === "blocked",
    resumable: status === "paused",
    reason: { complete: "goal satisfied", blocked: "goal blocked -- needs input or hit a limit", paused: "goal paused -- resumable" }[status]
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
      ...kimiLaneEnv(),
      KIMI_SECONDARY_MODEL: secondaryModel
    },
    exitCodes: KIMI_GOAL_EXIT_CODES
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
