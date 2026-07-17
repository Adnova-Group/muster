// wave-dispatch.js — capability check + fallback-selection for the orchestrator's wave
// dispatch mechanism (workflow-tool-delegation item).
//
// Claude Code CLI's agent-teams surface exposes a native, deterministic Workflow tool
// (fan-out + barrier as code) alongside ListAgents/SendMessage/Monitor -- reached ONLY
// through agent-teams / background-agent mode, never the single-session loop a plain
// `claude` invocation runs (docs/research/claude-code-cli.md sec 1's binary-tools
// evidence + sec 11's `claude agents` subcommand;
// docs/strategy/native-delegation.md Part B item 1: "Workflow reached only via
// agent-teams mode, not the single-session loop -- capability-gated").
//
// There is no on-disk or protocol signal an outside process (this CLI) can probe to
// detect agent-teams mode from inside a running session -- the SAME "cannot be
// auto-probed, must be DECLARED" shape as Cowork's nativePluginRide (src/harness.js /
// src/capabilities.js): the session itself (the model driving the orchestrator skill) is
// the only party that can observe whether its own tool list carries `Workflow`, so the
// orchestrator passes that self-observed boolean in as `agentTeams`; a host can also
// pre-declare it via MUSTER_AGENT_TEAMS / --agent-teams for a scripted/background-agent
// invocation ahead of any model self-inspection. AUGMENT, NOT SUPERSEDE: the prose wave
// loop (orchestrator/SKILL.md step 4) is the unconditional floor for every harness/
// session that doesn't declare native agent-teams support (Codex, Cowork, plain Claude
// Code CLI/Desktop single-session) -- prose is the default whenever nothing is declared.

export const AGENT_TEAMS_ENV = "MUSTER_AGENT_TEAMS";

export const WAVE_DISPATCH_MODES = Object.freeze({ NATIVE: "native", PROSE: "prose" });

// MCPB-boolean-safe parse: only "1"/"true"-ish values enable; mirrors src/model.js's
// fableEnabled() and src/cli.js's --native-plugin/MUSTER_COWORK_NATIVE_PLUGIN parse.
function truthyEnv(v) {
  return !!v && v !== "0" && v.toLowerCase() !== "false";
}

export function declaredAgentTeams(env = process.env) {
  return truthyEnv(env[AGENT_TEAMS_ENV]);
}

// Pure selection: `agentTeams` (boolean) is the session's own self-observed capability
// signal -- the orchestrator checking whether its tool list carries Workflow/ListAgents/
// SendMessage before dispatching a wave. Caller-optional; when omitted (undefined) this
// falls back to the declared env-var signal (declaredAgentTeams), for an invocation ahead
// of any self-inspection. An explicit boolean (true OR false) always wins over the env
// var -- the session's live observation is authoritative when it exists.
export function resolveWaveDispatch({ agentTeams, env = process.env } = {}) {
  const declared = typeof agentTeams === "boolean" ? agentTeams : declaredAgentTeams(env);
  if (declared) {
    return {
      mode: WAVE_DISPATCH_MODES.NATIVE,
      agentTeams: true,
      reason: "agent-teams surface available -- dispatch this wave via the native Workflow tool (deterministic fan-out + barrier)",
    };
  }
  return {
    mode: WAVE_DISPATCH_MODES.PROSE,
    agentTeams: false,
    reason: "no agent-teams surface declared -- single-session harness floor: prose wave loop (Agent tool dispatch + barrier + review gate)",
  };
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
  const enabled = typeof multiAgent === "boolean" ? multiAgent : declaredCodexMultiAgent(env);
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

// Builds the collaboration.spawn_agent call packet for one wave task. Always
// carries fork_turns: "none" (never "all") and the crew member's exact
// resolved agent_type (`chosen.id`) -- never omitted, even though
// `agent_type` may be missing from a simplified displayed tool signature
// (docs/research/codex-cli.md sec 6: "may be absent from the simplified
// displayed tool signature but must be sent anyway").
export function codexSpawnAgentCall({ taskId, message, agentType } = {}) {
  if (!taskId) throw new Error("codexSpawnAgentCall: taskId is required");
  if (typeof agentType !== "string" || !agentType) {
    throw new Error(`codexSpawnAgentCall: agentType is required for task "${taskId}" (the crew member's resolved chosen.id)`);
  }
  return {
    tool: "collaboration.spawn_agent",
    task_name: taskId,
    message: message ?? "",
    fork_turns: "none",
    agent_type: agentType,
  };
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
  if (!rejected) return { taskId, agentType, accepted: true };
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
// Native worktree isolation per harness + base-SHA receipts
// (worktree-isolation-native item, docs/strategy/native-delegation.md #10)
//
// Claude Code CLI already rides the Agent tool's own `isolation: "worktree"` parameter
// (orchestrator/SKILL.md's "Parallel isolation" bullet -- landed under
// harness-native-delegation #47, docs/research/claude-code-cli.md sec 5's
// observed-agent-tool citation). The other three harnesses muster targets each have a
// DIFFERENT native mechanism, or none at all:
//   - Claude Code Desktop auto-creates a per-session worktree under
//     `<root>/.claude/worktrees/` before the session's first tool call -- muster scripts
//     nothing (docs/research/claude-code-desktop.md sec 2.2).
//   - Hermes exposes `hermes -w` (a disposable per-session worktree under `.worktrees/`)
//     and kanban `worktree` workspaces for a queued task (docs/research/hermes.md sec 6's
//     hermes-worktrees citation).
//   - Codex has NO cwd field on `collaboration.spawn_agent` -- there is no native
//     mechanism to select at all (docs/research/codex-cli.md sec 6's skill-adapter
//     citation); isolation there is muster's own dispatch discipline, verified by a
//     receipt, not a harness guarantee (docs/strategy/native-delegation.md Part B item 4).
//
// What's common across all four: none of them self-report a fork point back to the
// orchestrator, so the orchestrator captures one base SHA per dispatched crew member,
// at dispatch time, and carries it as the provenance receipt regardless of which
// mechanism (or lack of one, on Codex) actually isolated the work. Selection (which
// mechanism) and the receipt (proof of the fork point) are two different questions --
// the receipt is recorded on every harness, even where the mechanism is genuinely native.
// ───────────────────────────────────────────────────────────────────────────

export const WORKTREE_ISOLATION_MECHANISMS = Object.freeze({
  AGENT_TOOL: "agent-tool-isolation", // Claude Code CLI: isolation:"worktree" on the Agent tool
  DESKTOP_AUTO: "desktop-auto-worktree", // Claude Code Desktop: automatic <root>/.claude/worktrees/
  HERMES_W: "hermes-w", // Hermes: `hermes -w` / kanban worktree workspaces
  RECEIPTS_ONLY: "receipts-only", // Codex: no cwd-on-dispatch -- receipt discipline stands in for isolation
});

const HARNESS_WORKTREE_MECHANISM = Object.freeze({
  "claude-code": WORKTREE_ISOLATION_MECHANISMS.AGENT_TOOL,
  "claude-desktop": WORKTREE_ISOLATION_MECHANISMS.DESKTOP_AUTO,
  hermes: WORKTREE_ISOLATION_MECHANISMS.HERMES_W,
  codex: WORKTREE_ISOLATION_MECHANISMS.RECEIPTS_ONLY,
});

// Pure per-harness selection: the orchestrator names its own running harness (declared
// at invocation, same as every other selection function in this file -- nothing here is
// auto-probed), and this maps that name onto the one native worktree mechanism (or the
// receipts-only floor) that harness actually has. An unrecognized/missing harness fails
// loud rather than silently defaulting to a mechanism nothing verified for it.
export function resolveWorktreeIsolation({ harness } = {}) {
  const known = Object.keys(HARNESS_WORKTREE_MECHANISM);
  if (typeof harness !== "string" || !harness) {
    throw new Error(`resolveWorktreeIsolation: harness is required (one of: ${known.join(", ")})`);
  }
  const mechanism = HARNESS_WORKTREE_MECHANISM[harness];
  if (!mechanism) {
    throw new Error(`resolveWorktreeIsolation: unrecognized harness "${harness}" (one of: ${known.join(", ")})`);
  }
  // receiptRequired is always true -- even (especially) for Codex's receipts-only floor,
  // where the receipt is the entire isolation proof, not a supplement to a native one.
  return { harness, mechanism, receiptRequired: true };
}

const BASE_SHA_RE = /^[0-9a-f]{7,40}$/i;

// Builds the base-SHA provenance receipt the orchestrator records per dispatched crew
// member, regardless of which native mechanism (or none, on Codex) isolated the work --
// the one piece of proof every harness carries alike. Fails loud on a malformed or
// missing SHA: a receipt that isn't provably a real fork point is worse than no receipt,
// since it would let a run claim isolation-equivalent provenance it never actually
// captured.
export function buildBaseShaReceipt({ taskId, mechanism, baseSha, worktreePath } = {}) {
  if (!taskId) throw new Error("buildBaseShaReceipt: taskId is required");
  if (!mechanism) throw new Error(`buildBaseShaReceipt: mechanism is required for task "${taskId}"`);
  if (typeof baseSha !== "string" || !BASE_SHA_RE.test(baseSha.trim())) {
    throw new Error(
      `buildBaseShaReceipt: baseSha must be a hex git SHA (got ${JSON.stringify(baseSha)}) for task "${taskId}" -- ` +
      `never record a receipt without a real fork-point SHA`
    );
  }
  return { taskId, mechanism, baseSha, worktreePath: worktreePath ?? null };
}
