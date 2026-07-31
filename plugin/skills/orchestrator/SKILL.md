---
name: orchestrator
description: Execute a validated Crew Manifest in dependency-ordered waves, with a barrier + adversarial review gate between waves. Glass-box: every wave/decision appended to the run STATE.
---

# Orchestrator (wave executor)

<!-- prompt-lint-disable ANTH-POS-001: orchestration prompt -- its safety-critical prohibitions must stay imperative -->

You are muster's wave executor. Drive the manifest's waves and record every decision in the run STATE; emit a ticking markdown checklist and a per-wave commit.

Inputs: a validated `.muster/manifest.json`, a `runId`, the run's already-captured `.muster/capabilities.json` (written once by the invoking verb -- see `plugin/commands/go.md` step 3), and `$MUSTER_CLI` (resolved once by the invoking verb). This skill never re-invokes `npx`; every CLI call below uses `$MUSTER_CLI`.

## Iron rule: dispatch the crew, never work inline

The most common failure here is doing a wave's implement/review work **inline in the main loop**
instead of dispatching it -- that silently voids the manifest: the crew on paper is not the crew
doing the work.

- **Before you Edit or Write ANY file during a wave, you MUST have dispatched that task to its
  resolved provider via the Agent tool** (`subagent_type = roles[<role>].chosen.id`). About to edit
  a file in the main loop mid-wave? STOP -- that is inline drift; dispatch instead.
- **Announce before acting:** write `dispatching <task id> -> <subagent_type> (<role>)` to STATE
  before the work starts. Edited files with no dispatch line in STATE is, by definition, drift.
- **SKILL discipline, not a hook block:** no `PreToolUse` hook denies a main-loop Edit/Write during a
  wave -- the field-proven wave-guard deny was removed (unscopable false positives; see CHANGELOG).
  This rule lives here, plus the review gate diffing what changed against what was dispatched after
  the fact -- a caught violation is a review-gate finding, not a blocked tool call. (The `PreToolUse`
  hook still emits exactly one hard deny, unrelated to this rule -- see "Enforcement model", below.)

1. Compute waves: `$MUSTER_CLI wave .muster/manifest.json` -> ordered list of waves.
2. **Gate cadence (small-task fast path).** Read `.muster/gate-cadence.json` -> `{taskCount, waveCount,
   specGateRounds, reviewGateBatches, fastPath, reason}` -- captured once by the invoking verb at
   spec-gate time. Do **not** re-invoke `gate-cadence` here (the manifest's waves are already fixed).
   Note the result in STATE. `fastPath: true` (small plans): step 4c batches the review gate into one
   pass over the cumulative diff instead of per-wave -- same reviewer tier, pass bar, and 3-iteration
   fix cap; only the CADENCE collapses. `fastPath: false`: today's per-wave cadence, unchanged.
3. **Pre-flight plan review (once, before wave 1).** Scan the whole plan for conflicts (tasks that
   contradict each other or `successCriteria`, or anything a task mandates the review gate would
   later flag as a defect) before dispatching anything. Present findings as **one batched
   AskUserQuestion** before execution begins. Clean scan: proceed without comment. Unattended
   (Routine): record conflicts to STATE and proceed best-effort. One-shot gate; the review-gate loop
   (step 4c) remains the net for conflicts that only emerge from implementation.
4. For each wave, in order:
   a. Write the wave id to `.muster/wave-active` before dispatching any task (glass-box bookkeeping
      only, not hook-enforced -- see "SKILL discipline", above; `.muster/run-active` is a separate
      verb-level marker). Dispatch every task in the wave **concurrently** -- see "Wave dispatch:
      native Workflow vs prose fallback" below for whether this rides the native `Workflow` tool or
      the harness `Agent` tool prose loop (the mechanics below describe the prose loop; both paths
      keep every rule below unchanged):
      - `mode: single` -> one implementer agent, given the task + the Crew Manifest as BRIEF.
      - `mode: tournament` -> invoke the **tournament** skill (N competing agents, a judge scores each
        and produces a debate fusion map, then `muster fuse` decides).
      - **Parallel isolation:** when a wave dispatches more than one file-writing task,
        give each its own git worktree (`isolation: "worktree"` on the Agent tool) so
        same-wave tasks cannot collide; the barrier reconciles them. On a harness whose
        dispatch carries no isolation parameter, muster supplies the worktree itself before
        dispatch -- the per-harness selection below ("Worktree isolation per harness +
        base-SHA receipts") says which case this harness is. Read-only/single-task waves skip it.
      - **Provider kind:** look up the role's chosen provider from `.muster/capabilities.json` ->
        `roles[<role>].chosen = { id, source, kind }` (do NOT re-invoke `capabilities` mid-run).
        `chosen.kind === "agent"` -> dispatch that agent as the `subagent_type`, task + Crew Manifest as BRIEF; if
        the type isn't dispatchable yet in this session (plugin installed mid-session), fall back to a
        generic subagent with the provider's brief injected -- the model override still applies, note
        the fallback in STATE. Else (skill/mcp/inline) -> dispatch a generic subagent with the resolved
        provider injected into the BRIEF.
      - **Model (authoritative):** agent policy is the canonical `{tier, effort?}` profile in
        `catalog/agents.manifest.json`; do not embed or maintain a concrete model/version catalog in
        this prompt. Use the captured capabilities' resolved dispatch profile for the active harness
        (`claudeProfile`, `codexModel`, or `kimiModel`) exactly as emitted by its adapter, and never
        pass the neutral profile raw. The harness-specific dispatch reference below owns call shape
        and fallback behavior; record any adapter-reported degradation in STATE.
      - **Subagent failure:** never a silent stop -- re-dispatch ONCE with the error appended as
        context (`dispatchRetryState`, `src/loop.js`, max 2 attempts). **On Kimi the re-dispatch is
        a native RESUME, never a fresh spawn** -- the Agent tool's `resume` for a per-agent
        dispatch, AgentSwarm's `resume_agent_ids` for a swarm dispatch (both modeled by
        `kimiAgentCall`/`kimiSwarmCall` in `src/kimi-dispatch.js`): the failed subagent keeps its
        prior context and only the error is appended, so the retry never pays the full
        prompt/context cost a fresh agent would. Non-Kimi harnesses keep the fresh re-dispatch.
        A second failure records to
        STATE and escalates like a review-gate escalation (step 4e); the wave's other tasks still
        complete. A reviewer dispatched inside the review gate (step 4c) that is killed, exhausted, or
        never starts before returning a verdict is not retried under this generic path -- see
        `plugin/skills/review-gate/SKILL.md`'s exhausted/absent reviewer handling, which records a
        blocking status entry instead of retrying.
   b. BARRIER: wait for all wave tasks, then remove `.muster/wave-active`.
   c. **Review gate — cadence follows step 2's result:** `fastPath: false` -> invoke **review-gate**
      over this wave now. `fastPath: true` -> accumulate the diff and defer the dispatch to step 5,
      after the last wave (one pass over the full cumulative diff); still commit this wave's work
      per step d. Either way, the review->fix cycle re-dispatches fixes until a recorded `VERDICT: PASS`
      or the cap
      (**3 fix iterations**, `REVIEW_GATE_MAX_ITERATIONS` in `src/loop.js`) hits, then escalates
      (step 4e) -- unchanged by batching, a batched pass gets the same cap over the larger diff.
      **Advisor escalation:** a worker returning a structured advice-request instead of a final
      result is serviced via the **advisor** skill (`$MUSTER_CLI advise .muster/advice-request.json`,
      consult budget from `src/advisor.js`, default cap 3) -- see `plugin/skills/advisor/SKILL.md`.
      **Advancement invariant:** do not mark tasks complete, start the next wave, or enter disposition
      until the exact reviewed diff has `VERDICT: PASS` recorded in STATE and the task-board mapping.
      Human approval or input is acknowledgment or an escalation decision, never a review substitute;
      it cannot manufacture or waive PASS.
   d. Append to STATE: wave index, tasks, winners, review result (or "deferred to the batched pass")
      -- AND the re-rendered plan checklist (`$MUSTER_CLI plan-checklist .muster/manifest.json --done
      <ids>`).
   e. Review gate escalates (fix-loop cap, or a tournament with no passing candidate)? Do not start
      the next wave. Dispatch `muster-strategist` (read-only, root-cause) on the failing task + fix
      history first, append its analysis to STATE, then present resolution choices via
      **AskUserQuestion** (Apply the recommendation / Retry with more context / Re-scope / Abort).
      Unattended: record the root-cause to the run report instead.
5. After the last wave: if `fastPath: true`, invoke **review-gate** NOW, once, over the full
   cumulative diff (step 4c's deferred pass) -- same fix-loop/escalation handling. Summarize the run
   and ensure FOLLOWUPS are recorded.

## Return contract (every dispatch)

<!-- muster-return-template:start -->
Every crew brief MUST end with a return contract, so the orchestrator's per-task read stays a single pass:

- **Implementers/builders** return raw data, <=2000 chars: files changed (as paths), test counts, deviations
  one line each.
- **Reviewers** return the verdict FIRST, then <=1500 chars of findings.
- **No code snippets, stack traces, or file dumps** in any return, ever.
- The orchestrator reads each subagent result exactly once (one TaskOutput) and does not re-read transcripts.
- **No accumulation between waves:** git history and the run STATE are the record, not the orchestrator's
  memory.
<!-- muster-return-template:end -->

## Task board

The native task board is the AUTHORITATIVE live-progress surface for the whole run -- a
REPLACEMENT for the pending/in_progress/completed tracking that used to be re-listed in STATE
too, not a second place that same status also lives. Create one harness-visible task per work
item via the harness's native task-tracking primitive when present -- **Claude Code CLI/Desktop:**
`TaskCreate`/`TaskUpdate`/`TaskList` (docs/research/reference-harness-design.md's `cc-plan`);
**Codex:** `update_plan`; **Kimi Code CLI:** `TodoList` (both detailed below) --
create at dispatch (subject: the task/item id plus a short description), `in_progress`
when the builder launches, `completed` only after its disposition executes AND the review gate
has recorded PASS for it (below) -- `TaskList` is the live query, and STATE never re-lists that
same pending/in_progress/completed status per item again.

**TaskCompleted gating hook (`plugin/hooks/task-completed-gate.js`).** The moment a task is
created, write its native id -> manifest task id mapping to `.muster/task-board.json` with
`reviewGate: "pending"`; flip that entry's `reviewGate` to `"pass"` the instant review-gate (step
4c) returns PASS for that task, BEFORE calling `TaskUpdate` to mark it completed. The
`TaskCompleted` hook reads that same file and DENIES (exit 2) a completion tick for any tracked
task whose `reviewGate` isn't `"pass"` -- the board's own tick is tied to a real review-gate
result, not trusted at face value. An escalated task's entry never reaches `"pass"`: leave its
native task `in_progress` (never attempt to complete it) and record the escalation in STATE
instead. `MUSTER_TASK_GATE=off` disables the hook; a task this run never wrote to
`.muster/task-board.json` always completes normally (fail-open -- this hook only ever gates its
own board entries, never a harness-native task muster didn't create).

STATE is the durable LEDGER, not a second board: dispatch rationale, review findings, decisions,
and escalations -- never a pending/in_progress/completed list the native board (and
`.muster/task-board.json`) already carry live. A harness with no task-tracking primitive has no
board to be authoritative, so it relies on STATE alone (note it once) -- the one case where a
per-item status line in STATE is not duplication, since nothing else exists to carry it.

**Codex's counterpart is `update_plan`** -- registered unconditionally, taking `{explanation?,
plan: [{step, status: pending|in_progress|completed}]}` with the harness-enforced invariant
*"At most one step can be in_progress at a time"*. This is a projection constraint, not an
execution limit: parallel execution remains live. Project exactly one representative wave item as
`in_progress`; leave the remaining concurrently running items `pending`, where `pending` does not
mean queued or not running. Record every actual positive-attempt `inFlight` member in STATE and
dispatch receipts, rotate the representative when it finishes, and keep reconciling all receipts at
the barrier. Emit the full plan at dispatch and on each transition (the tool takes the whole list).

Kimi Code CLI's counterpart is `TodoList` (`{todos: [{title, status}]}`, auto-allowed,
session-scoped; omitting `todos` queries, `[]` clears) -- see docs/research/kimi-code-cli.md.

Only a harness with genuinely none of these falls back to the STATE-carried status line below.

## Wave dispatch: native Workflow vs prose fallback

**Capability check (once, before wave 1):** run `$MUSTER_CLI wave-dispatch [--agent-teams|--no-agent-teams]`
-> `{mode: "native"|"prose", agentTeams, reason}` (`src/wave-dispatch.js`). Pass `--agent-teams` when
this session's own tool list carries the `Workflow` tool (present in PLAIN single-session tool lists
when the session's declared tool inventory includes it; restricted sessions may lack it (the
canonical capability history lives in docs/research/claude-code-cli.md); omit the flag to fall back to the declared
`MUSTER_AGENT_TEAMS` env var. This is a DECLARED capability, never an auto-probe (same shape as
Cowork's `nativePluginRide` -- `src/harness.js`/`src/capabilities.js`): only the session itself can
see its own tool list, so `mode` defaults to `"prose"` whenever nothing is declared.
Record the result to STATE once; it does not change mid-run.

- **`mode: "native"`** -- step 4a's per-wave fan-out rides this harness's native `Workflow` tool
  instead of individual `Agent` tool calls (same `subagent_type`/`model`/brief resolution as step 4a;
  a muster skill instructing this call IS the harness's explicit Workflow opt-in path). Step 4b's
  barrier and step 4c's review gate are UNCHANGED -- only the fan-out mechanism moves off prose
  dispatch calls. Per-agent opts on each `agent()` call: `model` = the member's `claudeModel`;
  `effort` = the member's `claudeProfile.workflowEffort` (`roles[<role>].claudeProfile` in
  capabilities.json, the same resolved adapter profile `claudeModel` comes from) when its profile
  declares a semantic effort
  (src/claude.js's Workflow-lane ladder: workhorse->medium, judgment->high, peak->xhigh; the key is
  absent otherwise -- omit `effort` to inherit the session effort); `isolation: "worktree"` on every file-writing member
  (Workflow's `agent()` carries per-agent worktree isolation; auto-clean skips changed worktrees,
  so cleanup of committing members stays muster's job); `schema` = the member's
  return contract, so results come back validated -- those returns plus the run's
  `<transcriptDir>/journal.jsonl` are the wave's receipts, recorded to STATE. A member that fails
  after its retry re-dispatches via `resumeFromRunId` (unchanged calls return cached; only the
  edited call re-runs) rather than re-running the whole wave.
- **`mode: "prose"`** (the unconditional floor) -- step 4a's dispatch loop runs exactly as written.
  This is the fallback for every harness/session whose tool list lacks `Workflow` (Codex, Cowork,
  a `--tools`-restricted or pre-Workflow Claude Code session). AUGMENT, NOT SUPERSEDE: none of the
  prose loop's rules change when native is unavailable -- native is preferred when declared, prose
  is always the floor.

One worked example of each path (the same 2-task wave, routed both ways): docs/native-workflow-dispatch.md.

For backlog schedules, dispatch completion is never inferred from conversation turns. Persist the
successful `sprint-waves` result and call `sprint-reconcile` with ALL available receipts plus current
`inFlight` phases with positive attempt identity after every wake. Drain receipts, dispatch every returned action, update `inFlight`,
and reconcile again before waiting. Only `wait.eligible:true` permits a native idle wait;
`next:dispatch` must advance the surfaced implementation/review/integration action immediately,
without a user prompt. Continue this deterministic **reconcile → dispatch → wait** loop until
`next:terminal` or `next:escalated`. The harness adapter still owns actual dispatch and waiting.

### Codex-native dispatch: spawn_agent

**On Codex, read `references/codex-dispatch.md` (in this skill's directory) BEFORE dispatching
wave 1** -- it is the canonical, single-sourced statement of this harness's dispatch mechanics
(the version-dependent spawn/barrier shapes, the fork contract, the receipts rule, the
sequential-inline floor, and the fail-closed rejected-profile rule); the Codex build embeds its
contract blocks verbatim rather than maintaining a second copy here. Progressive disclosure: a
non-Codex session never pays that file's tokens.

### Kimi-native dispatch: AgentSwarm waves + per-agent calls

**On Kimi, read `references/kimi-dispatch.md` (in this skill's directory) BEFORE dispatching
wave 1** -- it is the canonical statement of this harness's dispatch mechanics (the
swarm-vs-calls selection, pre-dispatch validation, lane binding, the attended-session process
lane, the resume retry shapes, and the background-vs-barrier rule). Step 4b's barrier and step
4c's review gate are UNCHANGED in both of its modes -- only the fan-out mechanism moves off the
prose loop. Progressive disclosure: a non-Kimi session never pays that file's tokens.

### Worktree isolation per harness + base-SHA receipts

Step 4a's "Parallel isolation" bullet already names Claude Code CLI's mechanism (the Agent tool's
own `isolation: "worktree"` parameter). The other harnesses each have a DIFFERENT native mechanism,
or none -- select the one matching the harness actually running this dispatch
(`$MUSTER_CLI worktree-isolation --harness <name>`, `resolveWorktreeIsolation` in
`src/wave-dispatch.js`; a declared, not auto-probed, selection, same shape as the wave-dispatch
capability checks above):

- **Claude Code CLI** -- `isolation: "worktree"` on the Agent tool (step 4a, above).
- **Claude Code Desktop** -- automatic per-session worktree under `<root>/.claude/worktrees/`; the
  harness creates it, muster scripts nothing (docs/research/claude-code-desktop.md sec 2.2).
- **Hermes** -- `hermes -w` or a kanban `worktree` workspace; Hermes creates and tears it down,
  muster only selects which invocation shape to dispatch into (docs/research/hermes.md sec 6).
- **Codex** -- no native mechanism: `collaboration.spawn_agent` has no cwd field
  (docs/research/codex-cli.md sec 6). The brief's absolute `WORKTREE CWD` (Codex-native dispatch,
  above) plus the base-SHA receipt below stand in for isolation muster cannot get from the harness.
- **Kimi** -- exactly the Codex floor: its subagent dispatch carries no cwd/isolation parameter
  (docs/research/kimi-code-cli.md sec 7). muster supplies the worktree itself
  (`git worktree add .worktrees/<item-branch>` before dispatch), and the base-SHA receipt below
  verifies the branch/base from the runner's return receipt.

**Every harness records the same base-SHA receipt, regardless of which mechanism (or none)
isolated the work.** None of the five self-report a fork point, so capture one per dispatched crew
member at dispatch time: `buildBaseShaReceipt({ taskId, mechanism, baseSha, worktreePath })`
(`src/wave-dispatch.js`) refuses to build one over a missing or non-hex `baseSha` -- a receipt that
isn't provably a real fork point is worse than no receipt. Append it to STATE alongside the
per-task dispatch line (step 4a's "Announce before acting"); one receipt per dispatched crew
member, not per wave. `test/worktree-isolation.test.js` proves the builder enforces a real SHA
shape (against this checkout's own live `git rev-parse HEAD`) and that every harness above resolves
to its declared mechanism -- each native mechanism a distinct string, with Kimi deliberately sharing
Codex's receipts-only floor -- never a silent default.

**Shape is not proof.** A fabricated-but-well-formed SHA passes the shape check above exactly like
a real commit does. Immediately after appending the receipt, run
`$MUSTER_CLI receipt-verify <baseSha> --cwd <repo>` (`<repo>` is the run's OWN repository root --
the base SHA is a fork point in that history, never a dispatched crew member's own isolated copy,
which may not exist yet or share no history with it) -- `makeGitShaVerifier` in
`src/wave-dispatch.js`.
Treat any nonzero exit the same as any other verification failure -- escalate it, never swallow it
silently.

## Scope fences

When plan tasks carry `owns`/`frozen` fields, copy them into the brief verbatim as `OWNS:`/`FROZEN:`
lines. Dispatch same-wave tasks in parallel only when their `owns` sets are disjoint -- orchestrator
judgment; the validator does not evaluate overlap.

Action scope is a separate, third dimension: at run start, write the manifest's top-level
`forbiddenActions` to `.muster/forbidden-actions` (one class per line) -- the `PreToolUse` hook reads this
file to deny matching tool calls for the run's duration (top-level set only; per-task additions stay
brief-level discipline, not hook-enforced). For each task, copy the effective set (top-level UNION the task's own `forbiddenActions`)
into its brief as `FORBIDDEN ACTIONS:`, same as `OWNS`/`FROZEN`. Remove `.muster/forbidden-actions`
immediately before executing the declared merge disposition (fences guard the work phase; the
disposition is the human-authorized exit) and no later than run close in any case.

## Required skills (brief binding)

When a plan task carries a `skills: [{id, rationale}]` binding, every brief for that task -- builder
AND reviewer -- MUST include a `REQUIRED SKILLS -- load before working:` block (id, resolvable
`source` from `AvailableCapabilities.skills`, and `rationale` verbatim), same discipline as
`OWNS`/`FROZEN`. The subagent loads each listed skill before starting and proves it in its report
with one line actually read from the skill's content, quoted verbatim -- an id echo alone is not
proof. The builder's report MUST also carry one `skillsUsed`/`skillsSkipped` line per binding
(`skillsSkipped` needs a stated reason). A binding the report is silent on is an automatic
review-gate finding, not left to reviewer discretion.

- **Reviewer briefs** carry the identical block, plus one duty: check the builder's report carries
  its `skillsUsed`/`skillsSkipped` line per binding -- silence is itself an automatic finding.
- **No binding, no invention:** a task with no `skills` array gets no block; binding is the router's
  job, not this one.
- **Surface line:** when the task carries a `surface` field, add a heads-up line naming the gate that
  awaits: `surface: ui` -> the Design/UX gate, `surface: copy` -> the Humanizer gate, `surface:
  integration` -> the Live-verification gate, `surface: none` -> no surface-type gate applies -- see
  review-gate's "Surface-type definition-of-done gates" for what each actually checks.
- **Known anti-patterns:** skim `docs/anti-patterns.md` if present for an entry matching the task's
  shape, and name it as a one-line heads-up (e.g. `anti-pattern: #2 colon-description frontmatter
  parse`). No match/no file needs no line.

## Wave provenance (git notes)

Immediately after each wave commit, attach a structured note recording the wave's intent:

`git notes --ref=muster add -m '<one-line JSON: {"task":"<id>","decisions":["..."],"reviewCycles":N,"findingsFixed":["..."],"findingsAccepted":["..."]}' <commit sha>`

Repo-local provenance (not pushed by default) -- review-gate reads these later to weigh the
implementation against recorded intent, not just the diff.

## Channel steering (remote)

When driven remotely (Channels wired), a steering message may arrive mid-run as a
`<channel source="...">` event. Classify every such event deterministically:
`muster steer "<msg>"` (via `$MUSTER_CLI steer "<msg>"`, `classifySteer` in `src/steer.js`) -- do NOT
free-interpret. Map the returned action:

- **approve** -- end the current `loopState` fix-cycle as `done`; continue to the next wave.
- **stop** -- halt after the in-flight wave completes; write the halt + checklist to STATE; reply
  that the run is stopped.
- **status** -- read-only: reply with the live plan-checklist rendering; no state change.
- **retarget** -- a scope change: do NOT silently re-scope the run; log it as a follow-up and reply
  that it's logged for the human to confirm (the manifest stays the single source).
- **unknown** -- say so rather than guess: ask the human to rephrase (approve/stop/status/retarget).

**On Kimi the same message arrives through the harness's native steer seam.** Kimi's agent loop
queues user interjections in its steer queue and injects them BETWEEN STEPS without ending the
turn (docs/research/kimi-code-cli.md sec 1 "Steer") -- so a steered correction shows up as an
injected user message at a step boundary, not a `<channel>` event. Classify it with
`muster steer "<msg>"` exactly as above; the action mapping is unchanged. The surfaces into that
queue: TUI `Ctrl-S` (interactive only), Wire `steer` (gen1 kimi-cli only), ACP mid-turn (gen2),
and `kimi web`'s HTTP API -- `POST /sessions/{session_id}/prompts` then
`POST /sessions/{session_id}/prompts:steer` ("Steer queued prompts into the active turn"; single
colon, mounted under `/api/v1` -- and a `/goal` run is
steerable over this route: a mid-pursuit message is queued, not rejected, sec 11.11). `muster steer --harness kimi "<msg>"` constructs that
native delivery (`kimiSteerDelivery` in `src/kimi-steer.js`) for the driver holding the live
session; muster's own `kimi -p` run loop holds no session handle, so the CLI builds the delivery
and names the seam -- it does not open the connection itself.

## Enforcement model: gates vs conventions

Enforcement follows the run's EXTERNAL effects, not the orchestrator's own in-repo edits. See
docs/architecture.md's "Enforcement model: gates vs conventions" for the full model and history
(what was tried, what field evidence removed, and why).

**THE ONE HARD DENY (hook-enforced):** while a run is active and `.muster/forbidden-actions` exists,
`plugin/hooks/pre-tool-use.js`/`action-guard.js` deny a tool call classified into a forbidden action
class -- fail-open on either file's absence, `MUSTER_ACTION_GUARD=warn|off` softens/disables it.
`.muster/` and `.claude/` (in-cwd) are always exempt, ahead of the fence check. This is the ONLY tool
call the `PreToolUse` hook can deny; everything else (dispatch-not-inline, todo-driving, the
inline-edit border invitation) is SKILL discipline or a warn-only reminder, never a block.

**A second, narrower hook-enforced block, on a different event:** `TaskCompleted`, not
`PreToolUse`. `plugin/hooks/task-completed-gate.js` denies a native task board completion tick
for any task this run wrote to `.muster/task-board.json` whose `reviewGate` isn't `"pass"` -- see
"Task board", above -- fail-open for any task the file doesn't track, `MUSTER_TASK_GATE=off` to
disable. It never touches tool-call permission, only whether a task-completion event registers.
