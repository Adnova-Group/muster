// wave-dispatch.js — capability check + fallback-selection for the orchestrator's wave
// dispatch mechanism (workflow-tool-delegation item).
//
// Claude Code CLI's agent-teams surface exposes a native, deterministic Workflow tool
// (fan-out + barrier as code) alongside ListAgents/SendMessage/Monitor -- reached ONLY
// through agent-teams / background-agent mode, never the single-session loop a plain
// `claude` invocation runs (docs/research/claude-code-cli.md sec 5 + sec 10;
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
