<!-- prompt-lint-disable ANTH-ROLE-001, ANTH-FMT-001: progressive-disclosure reference
loaded INTO the orchestrator skill's already-role-anchored context -- it is a section
extraction, not a standalone prompt, so it carries no second persona or output format. -->
<!-- Progressive-disclosure reference (skill-split item, 2026-07-29): the orchestrator's
Codex-native dispatch mechanics, read on demand by Codex-hosted sessions only -- a
non-Codex session never loads this file. The `###` heading below is kept verbatim from
its pre-split home in SKILL.md so section-anchored guards and citations stay stable.
NOTE for the Codex build: scripts/build-codex.mjs wholesale-replaces SKILL.md's whole
wave-dispatch span with fixed Codex-native text, so the SHIPPED Codex orchestrator does
not read this file -- it exists for a Claude-hosted session orchestrating work that
targets Codex, and as the canonical source prose for the mechanics below. Since the
2026-07-29 audit (slice D) that wholesale replacement no longer maintains its own copies
of the `fork_turns` contract paragraph or the v1/v2 shapes table below: the build extracts
BOTH blocks verbatim at build time (throw-on-miss) and embeds them into the shipped text,
so this file is their single source. -->

### Codex-native dispatch: spawn_agent

Codex has no `Workflow`-tool counterpart, so wave dispatch rides Codex's OWN native primitive,
subagent collaboration itself, never a prose-loop substitute for the Claude-only `Workflow` tool.
**The dispatch and barrier shapes are VERSION-DEPENDENT** (corrected 2026-07-25 against Codex
0.145.0). Codex resolves its subagent API per MODEL from the catalog's `multi_agent_version`, and
the live catalog puts `gpt-5.6-sol`/`terra` on v2 but `gpt-5.6-luna` -- muster's core tier -- on
v1. Never hardcode one shape; build both packets through `$MUSTER_CLI codex-spawn-packet` /
`codex-wait-packet` (src/wave-dispatch.js's `codexSpawnAgentCall`/`codexWaitAgentCall`),
which resolve the version and fail closed to v1 rather than guessing v2
(docs/research/codex-cli.md sec 10.1): `codex-spawn-packet --task-id <task id> --agent-type
<chosen.id> [--message-file <brief file>] [--version v1|v2] [--fork-turns <none|N>]` prints the
exact spawn_agent call JSON for the resolved version, and `codex-wait-packet [--version v1|v2]
[--targets <csv>] [--timeout-ms N]` the barrier call.

| | v2 (`sol`, `terra`) | v1 (`luna`) |
|---|---|---|
| dispatch | `collaboration.spawn_agent` (`task_name`, `message`, `fork_turns`, `agent_type`) | `multi_agent_v1.spawn_agent` (`message`, `fork_context: false`, `agent_type`) |
| barrier | `collaboration.wait_agent(timeout_ms)` -- **no targets** | `multi_agent_v1.wait_agent(targets[], timeout_ms)` |
| wake | a mailbox update from ANY live agent (also wakes early on steered input) | the FIRST of the named targets to finish |

`wait_agent` BLOCKS until something happens, so there is no interval to tune and nothing to
tight-poll. Before every wait, drain all available mailbox receipts, reconcile, dispatch all newly
eligible work, and reconcile again; only an eligible idle state may wait. After each wake, repeat
that **reconcile → dispatch → wait** loop until every dispatched member has settled (neither version
is an all-barrier), without waiting for a user prompt to notice a completion. Timeouts are bounded
10s..3600s, default 30s. **Take receipts from the mailbox, not from `list_agents`**: Codex 0.145.0
removed task messages from `list_agents` output (`#33030`), so it now reconciles liveness only. For
backlog schedules, the machine transition is `$MUSTER_CLI sprint-reconcile <progress.json>`;
`next:dispatch` forbids another wait and only `wait.eligible:true` permits one.

`fork_turns` (v2 only) is a **STRING**: Codex rejects the integer `3` and accepts `"3"`. Default
`"none"`; `"all"` is refused before dispatch because Codex will not combine a full-history fork with
a named `agent_type` (full-history agents inherit the parent's type/model/effort). A positive
integer string is the useful middle -- it keeps that many turns of context AND still accepts
`agent_type` plus model/effort overrides -- but reach for it only when the user explicitly requests
a context fork and never use `"all"`: a forked history is copied into every spawned agent, so the
standing quota policy (the 2026-07-15 quota-amplification fix) keeps `"none"` the spawn default.

`resolveCodexWaveDispatch({ multiAgent, env })` (`src/wave-dispatch.js`) selects between this and a
sequential-inline floor purely on the session's own `features.multi_agent` signal -- same
DECLARED-not-auto-probed shape as the wave-dispatch capability check in SKILL.md, inverted: Codex
ships `multi_agent` default-on, so only an explicit `multiAgent: false` (or
`MUSTER_CODEX_MULTI_AGENT=0`) drops to `mode: "sequential-inline"`
(one crew member at a time, never a partial/mixed fan-out).

**Fail-closed on a rejected profile -- the whole point of this design.** `agent_type` names a
custom-agent TOML profile (`.codex/agents/<id>.toml`) that pins that role's model, reasoning
effort, and sandbox; losing that pin by silently falling back to a generic agent is the exact
anti-pattern the codex burn taught muster to guard against. Only an ACTUALLY-rejected
`spawn_agent` call proves a profile unavailable -- never infer unavailability from a simplified
displayed tool signature. `assertCodexSpawnAgentAccepted` in `src/wave-dispatch.js` throws a
registration diagnostic naming the `agent_type` and task on a rejection, and the run STOPS on that
task rather than silently re-dispatching on a generic/default agent. Fix the registration
(reinstall the profile, verify `.codex/agents/`), then re-dispatch that one task.
