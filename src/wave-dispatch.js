// wave-dispatch.js — capability check + fallback-selection for the orchestrator's wave
// dispatch mechanism (workflow-tool-delegation item).
//
// Claude Code CLI exposes a native, deterministic Workflow tool (fan-out + barrier as
// code) alongside ListAgents/SendMessage/Monitor. CORRECTED 2026-07-29 (cc-workflow-lane):
// through 2.1.211 the research recorded this surface as "reached ONLY through
// agent-teams / background-agent mode, never the single-session loop" -- a live 2.1.220
// session disproves that for current builds: Workflow (plus the task-board and
// scheduling tools) sits in a PLAIN single-session tool list. The DECLARED-not-probed
// shape below is unchanged and still necessary: older builds, `--tools`-restricted
// sessions, and other harnesses lack the tool, and only the session itself can see its
// own tool list (docs/research/claude-code-cli.md sec 1's dated correction;
// docs/native-workflow-dispatch.md).
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
// session whose tool list lacks Workflow (Codex, Cowork, `--tools`-restricted or
// pre-Workflow Claude Code builds) -- prose is the default whenever nothing is declared.

import { execFileSync } from "node:child_process";

export const AGENT_TEAMS_ENV = "MUSTER_AGENT_TEAMS";

export const WAVE_DISPATCH_MODES = Object.freeze({ NATIVE: "native", PROSE: "prose" });

// Capability declarations are intentionally strict: normalized "1"/"true" enable,
// normalized "0"/"false" disable, and every other value fails closed. NOT
// env-util.js's isTruthyFlag, which is the permissive opt-in parse (any set
// value but "0"/"false" is on) -- a capability claim must fail closed, so these
// two are not interchangeable and stay separate.
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
  const declared = explicitOrDeclared(agentTeams, () => declaredAgentTeams(env));
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
//   - Kimi is exactly the Codex floor: its subagent dispatch carries no cwd/worktree
//     parameter either (docs/research/kimi-code-cli.md sec 7's kc-isolate citation), so
//     muster supplies worktrees itself (`git worktree add` before dispatch) and the same
//     receipts-only discipline stands in for isolation.
//
// What's common across all five: none of them self-report a fork point back to the
// orchestrator, so the orchestrator captures one base SHA per dispatched crew member,
// at dispatch time, and carries it as the provenance receipt regardless of which
// mechanism (or lack of one, on Codex/Kimi) actually isolated the work. Selection (which
// mechanism) and the receipt (proof of the fork point) are two different questions --
// the receipt is recorded on every harness, even where the mechanism is genuinely native.
// ───────────────────────────────────────────────────────────────────────────

export const WORKTREE_ISOLATION_MECHANISMS = Object.freeze({
  AGENT_TOOL: "agent-tool-isolation", // Claude Code CLI: isolation:"worktree" on the Agent tool
  DESKTOP_AUTO: "desktop-auto-worktree", // Claude Code Desktop: automatic <root>/.claude/worktrees/
  HERMES_W: "hermes-w", // Hermes: `hermes -w` / kanban worktree workspaces
  RECEIPTS_ONLY: "receipts-only", // Codex/Kimi: no cwd-on-dispatch -- receipt discipline stands in for isolation
});

const HARNESS_WORKTREE_MECHANISM = Object.freeze({
  "claude-code": WORKTREE_ISOLATION_MECHANISMS.AGENT_TOOL,
  "claude-desktop": WORKTREE_ISOLATION_MECHANISMS.DESKTOP_AUTO,
  hermes: WORKTREE_ISOLATION_MECHANISMS.HERMES_W,
  codex: WORKTREE_ISOLATION_MECHANISMS.RECEIPTS_ONLY,
  kimi: WORKTREE_ISOLATION_MECHANISMS.RECEIPTS_ONLY, // exactly Codex's floor: muster supplies worktrees itself
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
