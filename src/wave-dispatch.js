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
// execFileSync backs makeGitShaVerifier's git-backed default verifier below (the ONLY
// place in this file that shells out, and only when that verifier is actually invoked --
// never unconditionally on buildBaseShaReceipt's hot path).
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

import { execFileSync } from "node:child_process";
import { crossItemConflicts } from "./batch-plan.js";

export const AGENT_TEAMS_ENV = "MUSTER_AGENT_TEAMS";

export const WAVE_DISPATCH_MODES = Object.freeze({ NATIVE: "native", PROSE: "prose" });

// Capability declarations are intentionally strict: normalized "1"/"true" enable,
// normalized "0"/"false" disable, and every other value fails closed.
function truthyEnv(v) {
  if (typeof v !== "string") return false;
  const normalized = v.trim().toLowerCase();
  return normalized === "1" || normalized === "true";
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
// many turns AND still accepts both -- so it is the useful middle muster wants,
// not the "none" it used to always send.
const FORK_TURNS = /^(?:none|all|[1-9]\d*)$/;

// Builds the spawn_agent call packet for one wave task, in the shape the target
// model's API version actually accepts. Always carries the crew member's exact
// resolved agent_type (`chosen.id`) -- never omitted, even though `agent_type`
// may be missing from a simplified displayed tool signature
// (docs/research/codex-cli.md sec 6: "may be absent from the simplified
// displayed tool signature but must be sent anyway").
export function codexSpawnAgentCall({ taskId, message, agentType, version, forkTurns = "none" } = {}) {
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
    // guard that would reject a named agent_type.
    return {
      tool: "multi_agent_v1.spawn_agent",
      message: message ?? "",
      fork_context: false,
      agent_type: agentType,
    };
  }

  if (typeof forkTurns !== "string" || !FORK_TURNS.test(forkTurns)) {
    throw new Error(`codexSpawnAgentCall: fork_turns must be the STRING "none", "all", or a positive integer string; got ${JSON.stringify(forkTurns)}`);
  }
  if (forkTurns === "all") {
    throw new Error(`codexSpawnAgentCall: fork_turns "all" is a full-history fork, which Codex refuses to combine with a named agent_type ("Full-history forked agents inherit the parent agent type") -- use "none" or a positive integer string for task "${taskId}"`);
  }
  return {
    tool: "collaboration.spawn_agent",
    task_name: taskId,
    message: message ?? "",
    fork_turns: forkTurns,
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
  if (!Object.prototype.hasOwnProperty.call(HARNESS_WORKTREE_MECHANISM, harness)) {
    throw new Error(`resolveWorktreeIsolation: unrecognized harness "${harness}" (one of: ${known.join(", ")})`);
  }
  const mechanism = HARNESS_WORKTREE_MECHANISM[harness];
  // receiptRequired is always true -- even (especially) for Codex's receipts-only floor,
  // where the receipt is the entire isolation proof, not a supplement to a native one.
  return { harness, mechanism, receiptRequired: true };
}

const BASE_SHA_RE = /^[0-9a-f]{7,40}$/i;
const SUPPORTED_WORKTREE_ISOLATION_MECHANISMS = new Set(Object.values(WORKTREE_ISOLATION_MECHANISMS));

// Builds the base-SHA provenance receipt the orchestrator records per dispatched crew
// member, regardless of which native mechanism (or none, on Codex) isolated the work --
// the one piece of proof every harness carries alike. Fails loud on a malformed or
// missing SHA: a receipt that isn't provably a real fork point is worse than no receipt,
// since it would let a run claim isolation-equivalent provenance it never actually
// captured.
//
// base-SHA receipt VERIFICATION (backlog item `base-sha-receipt-verification`): format
// validation above (BASE_SHA_RE) proves the SHA is SHAPED like a git SHA -- it does NOT
// prove the SHA is REAL. A fabricated-but-well-formed SHA passes that regex exactly as a
// real commit does (the finding that sent the first attempt at this item back to the
// spec gate). The optional `verify` function closes that gap: when the CALLER supplies
// one (hermetic in a test, git-backed via makeGitShaVerifier below in production), the
// receipt records what it actually proved -- `verified` (the verifier's own boolean
// answer) and `verificationMechanism` (the verifier's own `.mechanism` label when it
// carries one, e.g. makeGitShaVerifier's "git-object", else "custom" for a bare inline
// function). Absent a `verify` function entirely, the receipt is honest about that too:
// `verified: false, verificationMechanism: "none"` -- format validation alone NEVER
// claims a receipt is verified.
export function buildBaseShaReceipt({ taskId, mechanism, baseSha, worktreePath, verify } = {}) {
  if (!taskId) throw new Error("buildBaseShaReceipt: taskId is required");
  if (!mechanism) throw new Error(`buildBaseShaReceipt: mechanism is required for task "${taskId}"`);
  if (!SUPPORTED_WORKTREE_ISOLATION_MECHANISMS.has(mechanism)) {
    throw new Error(
      `buildBaseShaReceipt: mechanism must be a supported isolation mechanism (got ${JSON.stringify(mechanism)}) ` +
      `for task "${taskId}"`
    );
  }
  if (typeof baseSha !== "string" || !BASE_SHA_RE.test(baseSha)) {
    throw new Error(
      `buildBaseShaReceipt: baseSha must be a hex git SHA (got ${JSON.stringify(baseSha)}) for task "${taskId}" -- ` +
      `never record a receipt without a real fork-point SHA`
    );
  }
  if (verify === undefined) {
    return { taskId, mechanism, baseSha, worktreePath: worktreePath ?? null, verified: false, verificationMechanism: "none" };
  }
  if (typeof verify !== "function") {
    throw new Error(`buildBaseShaReceipt: verify must be a function when provided (got ${typeof verify}) for task "${taskId}"`);
  }
  const verified = verify(baseSha) === true;
  const verificationMechanism = typeof verify.mechanism === "string" && verify.mechanism ? verify.mechanism : "custom";
  return { taskId, mechanism, baseSha, worktreePath: worktreePath ?? null, verified, verificationMechanism };
}

// The git-backed default verifier factory: "reachable" is DEFINED as the SHA resolving
// to a real commit object in the repository at an EXPLICIT cwd -- `git rev-parse
// --verify --quiet <sha>^{commit}` succeeding (exit 0) means the object exists and is (or
// dereferences to) a commit; any non-zero exit -- unknown object, wrong type, not a git
// repo at all -- means false. cwd is REQUIRED and never defaults to `process.cwd()`:
// Codex's `collaboration.spawn_agent` has no cwd field at all, so the caller (the
// orchestrator prose, or a human running the `receipt-verify` CLI) must always state
// which repository the SHA is being checked against -- silently trusting the running
// process's own cwd would make the receipt meaningless on exactly the harness that needs
// it most. `exec` is injectable (defaults to execFileSync) so callers can test this
// factory's OWN contract hermetically without a real git shell-out; production callers
// get the real one. The returned function carries a `.mechanism` label ("git-object")
// that buildBaseShaReceipt reads back into the receipt's `verificationMechanism`.
//
// The input is ALSO shape-checked against BASE_SHA_RE before ever shelling out (review
// finding, fixed): `git rev-parse --verify` resolves any revision expression -- a branch
// name, a tag, `HEAD`, a relative ref like `HEAD~2` -- not just SHAs, so without this
// guard a caller that passes something other than a SHA (the standalone `receipt-verify`
// CLI, invoked directly, never routes through buildBaseShaReceipt's own format check
// first) would get a false `verified: true` for input that was never a base-SHA at all.
// A shape-invalid input is unconditionally false, same as any other non-reachable SHA --
// this is the verifier's own definition of "reachable," not a separate error path.
export function makeGitShaVerifier({ cwd, exec = execFileSync } = {}) {
  if (typeof cwd !== "string" || !cwd.trim()) {
    throw new Error("makeGitShaVerifier: cwd is required (an explicit repository path -- never process.cwd())");
  }
  function verifyGitSha(sha) {
    if (typeof sha !== "string" || !BASE_SHA_RE.test(sha)) return false;
    try {
      exec("git", ["rev-parse", "--verify", "--quiet", `${sha}^{commit}`], { cwd, stdio: ["ignore", "ignore", "ignore"] });
      return true;
    } catch {
      return false;
    }
  }
  verifyGitSha.mechanism = "git-object";
  return verifyGitSha;
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
  const conflicting = crossItemConflicts(
    writers.map((member, index) => ({ id: member.id || `member-${index}`, owns: member.writes })),
  ).conflicts.length > 0;
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
export function codexExecCall({
  prompt,
  cwd,
  model,
  schemaPath,
  sandbox = "workspace-write",
  approvalPolicy = "never",
  skipGitCheck = false,
  lastMessagePath
} = {}) {
  if (typeof prompt !== "string" || !prompt.trim()) throw new Error("codexExecCall: prompt is required");
  if (!["read-only", "workspace-write", "danger-full-access"].includes(sandbox)) {
    throw new Error(`codexExecCall: unsupported sandbox ${JSON.stringify(sandbox)}`);
  }
  if (!["untrusted", "on-request", "never"].includes(approvalPolicy)) {
    throw new Error(`codexExecCall: unsupported approval policy ${JSON.stringify(approvalPolicy)}`);
  }
  const argv = [
    "--ask-for-approval",
    approvalPolicy,
    "exec",
    "--json",
    "--ignore-user-config",
    "--strict-config",
    "--ephemeral",
    "--sandbox",
    sandbox,
  ];
  if (cwd) argv.push("-C", cwd);
  if (model) argv.push("-m", model);
  if (schemaPath) argv.push("--output-schema", schemaPath);
  if (lastMessagePath) argv.push("-o", lastMessagePath);
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
// A first-class non-interactive reviewer with its OWN `review_model` (config
// `review_model`), so the review leg neither pollutes the run's session nor
// spends the orchestrator's model. Replaces muster's hand-dispatched reviewer
// for the diff leg specifically -- the judgment legs (architecture, spec) still
// route through muster's own reviewers.
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
