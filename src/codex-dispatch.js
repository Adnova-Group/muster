// codex-dispatch.js — Codex-specific wave selection and dispatch packet builders.
//
// This module mirrors kimi-dispatch.js: harness-specific mechanics live here while
// wave-dispatch.js retains harness-neutral selection, isolation, and receipt logic.

function truthyEnv(v) {
  if (typeof v !== "string") return false;
  const normalized = v.trim().toLowerCase();
  return normalized === "1" || normalized === "true";
}

// The selection shape both resolvers below share: the caller's own live
// observation, an explicit boolean (true OR false), always wins; when omitted
// (undefined) fall back to that harness's DECLARED env-var signal. Only the
// FALLBACK is shared -- each declared* reader keeps its own default policy
// (agent-teams: nothing declared means off; Codex multi_agent: nothing declared
// means Codex's own shipped default, on), and each resolver keeps its own
// mode/reason strings.
function explicitOrDeclared(explicit, declared) {
  return typeof explicit === "boolean" ? explicit : declared();
}

// ───────────────────────────────────────────────────────────────────────────
// Codex-native dispatch: spawn_agent (codex-spawn-agent-dispatch item)
//
// Codex has no `Workflow`-tool counterpart -- there is no deterministic
// native fan-out primitive to ride instead of prose on this harness. Codex's
// OWN native primitive for wave dispatch is subagent collaboration itself:
// `collaboration.spawn_agent` (fields: `task_name`, `message`, `fork_turns`,
// and the runtime extension `agent_type: "<profile name>"`),
// `collaboration.wait_agent` (timeout-bounded), `collaboration.list_agents`
// -- gated by the session's own `features.multi_agent` (default true)
// (docs/research/codex-cli.md sec 6's [DOCUMENTED]/[CODE-VERIFIED] dispatch-
// mechanics evidence). Codex REJECTS a named `agent_type` combined with a
// full-history context fork (`fork_turns: "all"` -- full-history agents
// inherit the parent's type/model/effort), so muster always spawns
// `fork_turns: "none"`. Same DECLARED-not-auto-probed shape as
// resolveWaveDispatch above: nothing outside a running session can observe
// whether `multi_agent` is on, so the caller passes its own observed/
// declared signal in.
// ───────────────────────────────────────────────────────────────────────────

export const CODEX_MULTI_AGENT_ENV = "MUSTER_CODEX_MULTI_AGENT";

export const CODEX_DISPATCH_MODES = Object.freeze({
  SPAWN_AGENT: "spawn_agent",
  SEQUENTIAL_INLINE: "sequential-inline",
});

// Codex ships `multi_agent` default ON (docs/research/codex-cli.md sec 3/6) --
// the INVERSE default from agent-teams above, where nothing declared meant
// "assume off." Here, nothing declared means "assume Codex's own shipped
// default," i.e. on. Only an explicit off declaration (env or an explicit
// `multiAgent: false`) drops to the sequential-inline floor.
export function declaredCodexMultiAgent(env = process.env) {
  if (env[CODEX_MULTI_AGENT_ENV] === undefined) return true;
  return truthyEnv(env[CODEX_MULTI_AGENT_ENV]);
}

// Pure selection, same shape as resolveWaveDispatch: `multiAgent` (boolean)
// is the session's own observed/declared signal for whether Codex's
// `features.multi_agent` is on this session; omitted, falls back to the
// declared env var. An explicit boolean always wins over the env var.
export function resolveCodexWaveDispatch({ multiAgent, env = process.env } = {}) {
  const enabled = explicitOrDeclared(multiAgent, () => declaredCodexMultiAgent(env));
  if (enabled) {
    return {
      mode: CODEX_DISPATCH_MODES.SPAWN_AGENT,
      multiAgent: true,
      reason: "Codex multi_agent is on -- dispatch this wave's crew via collaboration.spawn_agent (fork_turns: \"none\", agent_type per crew member), collaboration.wait_agent/list_agents as the barrier",
    };
  }
  return {
    mode: CODEX_DISPATCH_MODES.SEQUENTIAL_INLINE,
    multiAgent: false,
    reason: "Codex multi_agent is off -- no subagent collaboration tools this session; dispatch the wave's tasks sequentially inline, one crew member at a time",
  };
}

// --- The v1/v2 subagent API split (Codex 0.145.0) ---------------------------
//
// Codex ships TWO INCOMPATIBLE subagent APIs and picks between them PER MODEL,
// from the model catalog's `multi_agent_version` field -- not per install:
//
//   multi_agent_version_override().or(model_multi_agent_version)
//                                 .unwrap_or_else(|| from_features())
//
// The live 0.145.0 catalog puts gpt-5.6-sol and gpt-5.6-terra on v2 but
// gpt-5.6-luna on v1 -- and luna is muster's SONNET tier. So a single hardcoded
// packet shape is wrong for at least one tier at all times, and a catalog
// refresh can move a tier across the line with no muster-visible change.
//
//                v1                          v2
//   namespace    multi_agent_v1              collaboration
//   fork param   fork_context (bool)         fork_turns (STRING)
//   required     none                        task_name, message
//   concurrency  6                           4 (minus the primary thread)
//   max_depth    honored                     ignored
//
// See docs/research/codex-cli.md sec 10.1 for the verbatim evidence.
export const CODEX_MULTI_AGENT_VERSIONS = Object.freeze({ V1: "v1", V2: "v2" });

// Resolve which API a model speaks. `catalogVersion` is the model catalog's own
// `multi_agent_version` for that model (read by the caller from
// $CODEX_HOME/models_cache.json); `override` is an explicit config override.
// Falls back to v1, which is what `features.multi_agent = true` (the shipped
// default) selects when a model carries no catalog value -- NEVER to v2, since
// guessing v2 at a v1 model is the exact defect this resolver exists to prevent.
export function resolveCodexMultiAgentVersion({ override, catalogVersion } = {}) {
  for (const candidate of [override, catalogVersion]) {
    if (candidate === CODEX_MULTI_AGENT_VERSIONS.V1 || candidate === CODEX_MULTI_AGENT_VERSIONS.V2) return candidate;
    if (candidate !== undefined && candidate !== null) {
      throw new Error(`resolveCodexMultiAgentVersion: unknown multi_agent_version ${JSON.stringify(candidate)} (expected "v1" or "v2")`);
    }
  }
  return CODEX_MULTI_AGENT_VERSIONS.V1;
}

// `fork_turns` is a STRING on the wire: Codex rejects the integer 3, accepts "3".
// "none" keeps no context; "all" forks full history but then REFUSES a named
// agent_type and any model/effort override; a positive integer string keeps that
// many turns AND still accepts both. Union semantics: "none" is the standing
// default -- a forked history is copied into every spawned agent, so the quota
// policy (36bed34) keeps "none" the spawn default -- and a positive integer
// string (the version-aware spawn mechanism, 7d88686) is sent only on explicit
// request.
const FORK_TURNS = /^(?:none|all|[1-9]\d*)$/;

// Builds the spawn_agent call packet for one wave task, in the shape the target
// model's API version actually accepts. Always carries the crew member's exact
// resolved agent_type (`chosen.id`) -- never omitted, even though `agent_type`
// may be missing from a simplified displayed tool signature
// (docs/research/codex-cli.md sec 6: "may be absent from the simplified
// displayed tool signature but must be sent anyway").
export function codexSpawnAgentCall({ taskId, message, agentType, version, forkTurns } = {}) {
  if (!taskId) throw new Error("codexSpawnAgentCall: taskId is required");
  if (typeof agentType !== "string" || !agentType) {
    throw new Error(`codexSpawnAgentCall: agentType is required for task "${taskId}" (the crew member's resolved chosen.id)`);
  }
  const api = resolveCodexMultiAgentVersion({ override: version });

  if (api === CODEX_MULTI_AGENT_VERSIONS.V1) {
    // v1 has no fork_turns at all -- Codex says so explicitly:
    // "fork_context is not supported in MultiAgentV2; use fork_turns instead"
    // (and the converse). v1's fork_context defaults to false, which is the
    // no-context spawn muster wants, and false never trips the full-history
    // guard that would reject a named agent_type. An explicit forkTurns at a
    // v1 model is version drift: fail loud rather than silently drop it (the
    // caller believes the spawn forks N turns; the dropped flag forks none).
    if (forkTurns !== undefined) {
      throw new Error(`codexSpawnAgentCall: fork_turns is v2-only -- v1 (task "${taskId}") takes fork_context (false, the no-context spawn); drop forkTurns or target a v2 model`);
    }
    return {
      tool: "multi_agent_v1.spawn_agent",
      message: message ?? "",
      fork_context: false,
      agent_type: agentType,
    };
  }

  const forkTurnsValue = forkTurns ?? "none";
  if (typeof forkTurnsValue !== "string" || !FORK_TURNS.test(forkTurnsValue)) {
    // "all" is DELIBERATELY absent from the enumerated valids: it parses as a
    // well-formed fork_turns value but muster never emits it (the dedicated
    // rejection just below explains why), so naming it here as valid would
    // contradict the very next check.
    throw new Error(`codexSpawnAgentCall: fork_turns must be the STRING "none" or a positive integer string; got ${JSON.stringify(forkTurnsValue)}`);
  }
  if (forkTurnsValue === "all") {
    throw new Error(`codexSpawnAgentCall: fork_turns "all" is a full-history fork, which Codex refuses to combine with a named agent_type ("Full-history forked agents inherit the parent agent type") -- use "none" or a positive integer string for task "${taskId}"`);
  }
  return {
    tool: "collaboration.spawn_agent",
    task_name: taskId,
    message: message ?? "",
    fork_turns: forkTurnsValue,
    agent_type: agentType,
  };
}

// Wait-timeout bounds Codex enforces on the v2 barrier
// (DEFAULT_MULTI_AGENT_V2_{MIN,MAX,DEFAULT}_WAIT_TIMEOUT_MS).
export const CODEX_WAIT_TIMEOUT_MS = Object.freeze({ min: 10_000, max: 3_600_000, default: 30_000 });

// Builds the wave BARRIER call. The two API versions differ in kind, not just
// in spelling, and muster's prior instruction ("<=60s per outstanding agent id")
// described only the v1 shape:
//
//   v1  wait_agent(targets: [...ids], timeout_ms) -> {status: {id: AgentStatus}, timed_out}
//       Waits on named agents and returns on the FIRST to finish.
//   v2  wait_agent(timeout_ms)                    -> {message, timed_out}
//       No targets at all: wakes on a mailbox update from ANY live agent, and
//       also wakes early when new user input is steered into the turn.
//
// Neither is an all-barrier -- the caller loops until every dispatched member
// has settled. That is the whole reason this is a barrier and not a poll: each
// call BLOCKS until something actually happens, so there is no interval to tune
// and no tight-poll to guard against.
export function codexWaitAgentCall({ version, targets, timeoutMs = CODEX_WAIT_TIMEOUT_MS.default } = {}) {
  const api = resolveCodexMultiAgentVersion({ override: version });
  if (!Number.isInteger(timeoutMs) || timeoutMs < CODEX_WAIT_TIMEOUT_MS.min || timeoutMs > CODEX_WAIT_TIMEOUT_MS.max) {
    throw new Error(`codexWaitAgentCall: timeoutMs must be an integer within ${CODEX_WAIT_TIMEOUT_MS.min}..${CODEX_WAIT_TIMEOUT_MS.max} ms; got ${JSON.stringify(timeoutMs)}`);
  }
  if (api === CODEX_MULTI_AGENT_VERSIONS.V1) {
    if (!Array.isArray(targets) || !targets.length || targets.some(id => typeof id !== "string" || !id)) {
      throw new Error("codexWaitAgentCall: v1 wait_agent requires a non-empty targets array of agent ids");
    }
    return { tool: "multi_agent_v1.wait_agent", targets: [...targets], timeout_ms: timeoutMs };
  }
  // v2 takes no targets; passing them is a caller misunderstanding worth failing
  // on rather than silently dropping.
  if (targets !== undefined) {
    throw new Error("codexWaitAgentCall: v2 wait_agent takes no targets -- it wakes on a mailbox update from ANY live agent; omit targets");
  }
  return { tool: "collaboration.wait_agent", timeout_ms: timeoutMs };
}

// Fail-closed guard on the ACTUAL outcome of a spawn_agent call. Only an
// actually-rejected call proves a profile unavailable -- never infer
// unavailability from a displayed tool schema or an omitted field -- and the
// correct response to a real rejection is failing closed with a registration
// diagnostic, NEVER silently degrading to a generic/default agent, which
// would silently drop the pinned model/reasoning/sandbox policy the named
// profile TOML enforces (docs/research/codex-cli.md sec 6; this is the exact
// anti-pattern the codex burn taught muster to guard against).
export function assertCodexSpawnAgentAccepted({ taskId, agentType, rejected, rejectionReason } = {}) {
  if (typeof taskId !== "string" || !taskId.trim()) {
    throw new Error("assertCodexSpawnAgentAccepted: taskId must be a non-empty string");
  }
  if (typeof agentType !== "string" || !agentType.trim()) {
    throw new Error(`assertCodexSpawnAgentAccepted: agentType must be a non-empty string for task "${taskId}"`);
  }
  if (rejected === false) return { taskId, agentType, accepted: true };
  if (rejected !== true) {
    throw new Error(
      `assertCodexSpawnAgentAccepted: malformed spawn_agent outcome for task "${taskId}" -- ` +
      `rejected must be the explicit boolean false to prove acceptance`
    );
  }
  throw new Error(
    `Codex spawn_agent rejected agent_type "${agentType}" for task "${taskId}"` +
    (rejectionReason ? `: ${rejectionReason}` : "") +
    `. Registration diagnostic -- this profile is not registered (verify \`.codex/agents/${agentType}.toml\` ` +
    `or the user-scope equivalent exists, generated by \`muster install codex\`). Failing closed: do NOT ` +
    `retry this task on a generic/default agent -- that would silently drop the pinned model, reasoning ` +
    `effort, and sandbox policy the profile enforces. Fix the registration, then re-dispatch this task.`
  );
}

// ───────────────────────────────────────────────────────────────────────────
// codex exec: the process-level dispatch lane
//
// `spawn_agent` CANNOT isolate. Codex says so in its own shipped prompt: "All
// agents have access to the same container and filesystem as you. All agents
// use the same current working directory. As a result, edits made by one agent
// are immediately visible to all other agents." Its only mitigation is asking
// the model nicely to keep write sets disjoint.
//
// `codex exec` is the escape hatch, and the ONLY path on this harness with real
// filesystem isolation: each wave member is a separate OS process with its own
// `-C <dir>`, so muster can hand conflicting members separate worktrees. It also
// gives a true ALL-barrier (wait on N pids) rather than wait_agent's
// first-completion/any-update semantics, a schema-validated final message, and a
// nonzero exit on fatal error.
//
// Cost: a cold process per member and no shared prompt cache (the cache key is
// the session id), so this is for waves that NEED isolation, not the default.
// ───────────────────────────────────────────────────────────────────────────

export const CODEX_EXEC_MODES = Object.freeze({
  SPAWN_AGENT: "spawn_agent",
  EXEC_PROCESS: "exec-process"
});

// Choose the dispatch lane for a wave. Conflicting write sets are the deciding
// factor because they are the one thing spawn_agent cannot make safe.
export function resolveCodexDispatchLane({ members = [], forceProcess = false } = {}) {
  const writers = members.filter(m => m?.writes);
  const paths = writers.flatMap(m => Array.isArray(m.writes) ? m.writes : []);
  const conflicting = paths.length !== new Set(paths).size;
  if (forceProcess || conflicting) {
    return {
      mode: CODEX_EXEC_MODES.EXEC_PROCESS,
      reason: forceProcess
        ? "caller forced process isolation"
        : "wave members declare overlapping write sets -- spawn_agent shares one cwd across all agents, so only separate `codex exec -C <dir>` processes can isolate them",
      isolation: "process-cwd"
    };
  }
  return {
    mode: CODEX_EXEC_MODES.SPAWN_AGENT,
    reason: "disjoint write sets -- in-session spawn_agent keeps the prompt cache and avoids a cold process per member",
    isolation: "context-only"
  };
}

// Build the argv for one wave member dispatched as its own `codex exec` process.
// `--json` is always on: muster parses the JSONL event stream (thread.started /
// turn.completed with usage / item.completed) rather than scraping prose.
export function codexExecCall({ prompt, cwd, model, schemaPath, ephemeral = false, skipGitCheck = false, lastMessagePath } = {}) {
  if (typeof prompt !== "string" || !prompt.trim()) throw new Error("codexExecCall: prompt is required");
  const argv = ["exec", "--json"];
  if (cwd) argv.push("-C", cwd);
  if (model) argv.push("-m", model);
  if (schemaPath) argv.push("--output-schema", schemaPath);
  if (lastMessagePath) argv.push("-o", lastMessagePath);
  if (ephemeral) argv.push("--ephemeral");
  if (skipGitCheck) argv.push("--skip-git-repo-check");
  argv.push(prompt);
  return { command: "codex", argv, isolation: cwd ? "process-cwd" : "process" };
}

// `codex exec` exits 1 when a fatal error was reported, 0 otherwise. There are
// no other distinct codes, so anything else is a harness fault rather than a
// task verdict -- never silently read as success.
export function interpretCodexExecExit(code) {
  if (code === 0) return { ok: true, fatal: false };
  if (code === 1) return { ok: false, fatal: true, reason: "codex exec reported a fatal error" };
  return { ok: false, fatal: true, reason: `codex exec exited ${code} -- not a documented exec status` };
}

// ───────────────────────────────────────────────────────────────────────────
// codex review: the native diff-review gate
//
// Codex ships a first-class non-interactive reviewer with its own
// `review_model` (config `review_model`), but PR #151's paid shadow replay
// found: native review shadow benchmark rejected adoption (0/10 schema-valid
// outputs). Production routing must continue through muster's independently
// dispatched review gate -- see wave-dispatch.js's resolveCodexReviewRouting
// for the structural nativeReviewEnabled:false decision. This builder is a
// pure packet constructor kept for the benchmark harness only; it is never
// imported by cli.js or any production dispatch path.
// ───────────────────────────────────────────────────────────────────────────

export function codexReviewCall({ base, uncommitted = false, commit, title, prompt } = {}) {
  const selectors = [base && "base", uncommitted && "uncommitted", commit && "commit"].filter(Boolean);
  if (selectors.length !== 1) {
    throw new Error(`codexReviewCall: pass exactly one of base | uncommitted | commit (got ${selectors.length ? selectors.join(", ") : "none"})`);
  }
  const argv = ["review"];
  if (base) argv.push("--base", base);
  if (uncommitted) argv.push("--uncommitted");
  if (commit) argv.push("--commit", commit);
  if (title) argv.push("--title", title);
  if (prompt) argv.push(prompt);
  return { command: "codex", argv };
}
