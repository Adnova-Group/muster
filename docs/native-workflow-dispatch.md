# Native Workflow dispatch (backlog item `workflow-tool-delegation`)

Seed context: `docs/strategy/native-delegation.md` Part B item 1 named the orchestrator's
prose wave loop (`plugin/skills/orchestrator/SKILL.md` step 4) as the strongest available
native-replacement target on Claude Code CLI -- the harness's agent-teams surface exposes a
**deterministic** `Workflow` tool (fan-out + barrier as code) alongside `ListAgents`/
`SendMessage`/`Monitor` (`docs/research/claude-code-cli.md` §1's binary-tools evidence +
§11's `claude agents` subcommand), reached only through
agent-teams / background-agent mode, never the single-session loop a plain `claude`
invocation runs. *(CORRECTED 2026-07-29, cc-workflow-lane item: that gating claim described
the 2.1.211-era research pin. A live 2.1.220 session carries `Workflow` in a PLAIN
single-session tool list — see the research doc's dated correction. The capability check
below is unchanged and still required: older builds and `--tools`-restricted sessions lack
the tool, and only the session itself can observe its own tool list.)* This item wires the
orchestrator to RIDE that tool when it's available, with the existing prose loop kept as
the unconditional floor everywhere it isn't -- AUGMENT, NOT SUPERSEDE.

## The capability check

There is no on-disk or protocol signal an outside process (this repo's CLI) can probe to
detect agent-teams mode from inside a running session -- the SAME "cannot be auto-probed,
must be DECLARED" shape as Cowork's `nativePluginRide` (`src/harness.js`/
`src/capabilities.js`, landed by the `cowork-plugin-loader-probe` item). The one party that
CAN observe it is the session itself: the model driving the orchestrator skill directly
sees its own tool list, the same way it already knows whether it has an `Agent` tool at all.

`src/wave-dispatch.js`'s `resolveWaveDispatch({ agentTeams, env })` is the pure selection
behind this:

- `agentTeams: true` (the orchestrator's own self-observation that `Workflow` is in its
  tool list this session) -> `mode: "native"`.
- `agentTeams` omitted -> falls back to the declared `MUSTER_AGENT_TEAMS` env var
  (MCPB-boolean-safe parse, mirroring `MUSTER_ENABLE_APEX`/`MUSTER_COWORK_NATIVE_PLUGIN`;
  the legacy `MUSTER_ENABLE_FABLE` alias remains honored for the apex flag) --
  for a scripted/background-agent invocation ahead of any model self-inspection.
- Neither declared -> `mode: "prose"`, the unconditional floor.

Wired through the CLI as `muster wave-dispatch [--agent-teams|--no-agent-teams]`
(`src/cli.js`), invoked once by the orchestrator before wave 1
(`plugin/skills/orchestrator/SKILL.md`'s "Wave dispatch: native Workflow vs prose
fallback" section) and recorded to STATE.

## Worked example: a 2-task wave

Manifest fragment (one wave, two independent, disjoint-`owns` tasks):

```json
{
  "plan": [
    { "id": "endpoint", "task": "Add the GET /health endpoint", "mode": "single",
      "deps": [], "owns": ["src/routes/health.js"] },
    { "id": "docs", "task": "Document the new endpoint in the API reference",
      "mode": "single", "deps": [], "owns": ["docs/api-reference.md"] }
  ]
}
```

`$MUSTER_CLI wave manifest.json` computes one wave of both tasks (disjoint `owns`, no
`deps` between them). `$MUSTER_CLI wave-dispatch` is the fork point:

### Path A -- native Workflow (agent-teams declared)

`$MUSTER_CLI wave-dispatch --agent-teams` -> `{"mode":"native","agentTeams":true,"reason":
"agent-teams surface available -- dispatch this wave via the native Workflow tool
(deterministic fan-out + barrier)"}`.

The orchestrator submits the wave as one `Workflow` call carrying two steps -- one per
task, each naming its resolved `subagent_type` (`roles.implement.chosen.id`), `model`
override, and brief (task + OWNS/FROZEN fences + Crew Manifest), exactly the same
resolution `capabilities.json` already produced for the prose path. The harness's own
scheduler runs both steps concurrently and joins them -- muster's wave-active marker still
brackets the call (write before dispatch, remove after the join) and STATE still records
`dispatching endpoint -> muster-builder (implement)` / `dispatching docs -> muster-builder
(implement)` before the `Workflow` call, same glass-box discipline as the prose path. Step
4b's barrier and step 4c's review gate run unchanged once the `Workflow` call returns both
results.

**Isolation on THIS specific example (RESOLVED 2026-07-29, cc-workflow-lane item).** Both
tasks here write disjoint files (`src/routes/health.js` and `docs/api-reference.md`) --
exactly the shape step 4a's "Parallel isolation" rule requires a per-task git worktree for.
The per-step isolation control this doc originally flagged as unconfirmed IS confirmed:
`Workflow`'s `agent()` takes `isolation: "worktree"` per spawned agent (observed live in a
2.1.220 session's tool schema -- "runs the agent in a fresh git worktree"; corroborated by
the 2.1.161 changelog fix note for Workflow agents "spawned with `isolation: 'worktree'`").
So this 2-task wave now rides Path A whenever `mode: "native"` is declared: each `agent()`
call carries `isolation: "worktree"`, plus `model` (the member's `claudeModel`), `effort`
(the member's `workflowEffort` when its profile declares a semantic effort -- src/claude.js's
Workflow-lane ladder), and `schema` (the member's return contract, so the join returns
validated results and the run's `journal.jsonl` doubles as the receipts trail). One caveat
carried forward: Workflow's auto-clean removes only UNCHANGED worktrees, and a committing
wave member always changes its worktree -- cleanup stays muster's job, same as the prose
path.

### Path B -- prose fallback (no agent-teams declaration)

`$MUSTER_CLI wave-dispatch` (no flag, no `MUSTER_AGENT_TEAMS`) ->
`{"mode":"prose","agentTeams":false,"reason":"no agent-teams surface declared --
single-session harness floor: prose wave loop (Agent tool dispatch + barrier + review
gate)"}`.

The orchestrator falls through to today's unchanged step 4a: two separate `Agent` tool
calls, dispatched concurrently by the model itself (`subagent_type: muster-builder` for
each, same model override, same OWNS/FROZEN briefs), then a prose barrier -- wait for both
`TaskOutput` reads before proceeding. Every other rule (provider-kind lookup, subagent-
failure retry, scope fences, review gate cadence) is byte-identical to before this item;
nothing about the prose path changed.

**Both paths converge on the same barrier + review-gate step (4b/4c) and the same STATE
shape** -- the fork is scoped exactly to the fan-out mechanism, not to any of the
orchestrator's other rules.

## Honest scoping

The native `Workflow` tool cannot actually be invoked from this repo's test or eval
environment (no agent-teams / background-agent session is reachable here, the same
environment limitation the `cowork-plugin-loader-probe` item hit for a live Cowork
session) -- so Path A above is a worked walkthrough of the documented mechanism
(docs/research/claude-code-cli.md §1/§11), not a live-invocation demonstration. What IS
verified, fixture-driven, and green: the **selection logic** deciding which path a run
takes (`test/wave-dispatch.test.js`'s unit coverage of `resolveWaveDispatch`/
`declaredAgentTeams`, `test/cli-wire-perf.test.js`'s end-to-end CLI wire coverage of
`wave-dispatch --agent-teams`/`--no-agent-teams`/`MUSTER_AGENT_TEAMS`) and the fact that the
prose loop itself is completely unmodified (every existing orchestrator/review-gate/
gate-cadence test still passes byte-for-byte against the unchanged step 4a-4e mechanics).

## Fallback preserved (proof)

- `resolveWaveDispatch()` called with nothing declared at all (no `agentTeams` arg, no
  `MUSTER_AGENT_TEAMS` env var) always resolves `mode: "prose"` --
  `test/wave-dispatch.test.js`'s "no signal at all ... selects the prose fallback" case.
- The prose loop's own mechanics in `plugin/skills/orchestrator/SKILL.md` step 4 are
  untouched by this item except one added clause pointing at this section -- no rule
  (provider resolution, model override, retry, scope fences, review-gate cadence) was
  reworded or removed.
- `test/corpus-contradiction.test.js`'s shared-term pins (surface taxonomy, gate names, the
  fix-iteration cap) still match byte-for-byte, confirming the prose path's load-bearing
  vocabulary is untouched.

## Scope of this cycle

This item lands: the capability check + pure selection function (`src/wave-dispatch.js`,
fixture-driven TDD in `test/wave-dispatch.test.js`), its CLI wiring (`muster wave-dispatch`,
covered end-to-end in `test/cli-wire-perf.test.js`), the orchestrator's new "Wave dispatch:
native Workflow vs prose fallback" section plus a one-clause pointer from step 4a, and this
worked-example doc. Not landed here (follow-ups for a future item, once a live agent-teams
session is reachable from this environment): an actual live invocation of the `Workflow`
tool proving Path A end-to-end, and wiring the same self-observation signal into `go.md`'s
one-shot capture convention (today the orchestrator calls `wave-dispatch` itself, once,
rather than reusing `go.md`'s `capabilities.json`/`gate-cadence.json` pre-capture pattern --
deliberately, to keep this item's edit to `plugin/skills/orchestrator/SKILL.md` surgical
given the stacked sibling items also touching that file); and confirming whether the
`Workflow` tool exposes a per-step isolation control equivalent to the Agent tool's
`isolation: "worktree"` parameter. **That second follow-up LANDED 2026-07-29 (the
cc-workflow-lane item): the control is confirmed and the multi-file-writing-wave
restriction is lifted** -- see the resolved isolation note in the worked example above and
the rewritten native-mode bullet in `plugin/skills/orchestrator/SKILL.md`. The same item
added the Workflow-lane effort ladder to `src/claude.js` (`workflowEffort`:
workhorse->medium, judgment->high, peak->xhigh -- the first per-subagent effort surface on
this harness, Workflow-lane only) and the `resumeFromRunId` retry rule for failed members.
