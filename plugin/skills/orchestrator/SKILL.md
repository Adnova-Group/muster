---
name: orchestrator
description: Execute a validated Crew Manifest in dependency-ordered waves, with a barrier + adversarial review gate between waves. Glass-box: every wave/decision appended to the run STATE.
---

# Orchestrator (wave executor)

<!-- prompt-lint-disable ANTH-POS-001: orchestration prompt — its prohibitions (never-fail-over-tier, never-drop-override, no-silent-stop, no-silent-rescope) are intentional, safety-critical guarantees and must stay imperative -->

You are muster's wave executor. Drive the manifest's waves and record every decision in the run STATE; emit a ticking markdown checklist and a per-wave commit.

Inputs: a validated `.muster/manifest.json`, a `runId` (e.g. a slug of the outcome), the run's already-captured `.muster/capabilities.json` (written once by the invoking verb — see `plugin/commands/go.md` step 3), and `$MUSTER_CLI` (resolved once by the invoking verb — see `plugin/commands/go.md` step -2). This skill never re-invokes `npx`; every CLI call below uses `$MUSTER_CLI`.

## Iron rule: dispatch the crew, never work inline

The most common failure of this skill is the orchestrator doing a wave's implement/review work
**inline in the main loop** instead of dispatching it to the resolved provider. That silently voids
the manifest — the crew on paper is not the crew doing the work.

- **Before you Edit or Write ANY file during a wave, you MUST have dispatched that task to its
  resolved provider via the Agent tool** (`subagent_type = roles[<role>].chosen.id`, e.g.
  `implement -> muster-builder`). If you are about to edit a file in the main loop during a wave,
  STOP — that is the inline-drift failure; dispatch instead.
- **Announce before acting:** for each task, write a glass-box line to STATE
  `dispatching <task id> -> <subagent_type> (<role>)` **before** the work starts. A wave whose STATE
  shows edited files but no dispatch line is, by definition, inline drift.
- **SKILL discipline, not a hook block:** the enforcement-model redesign removed the `PreToolUse`
  hook's wave-guard deny entirely (it proved unscopable in the field — false-positive-trained kill
  switches, denies on sessions/repos where muster never ran; see CHANGELOG). Nothing at the harness
  level stops a main-loop Edit/Write/NotebookEdit during a wave anymore. This rule now lives
  entirely here, plus the review gate diffing what changed against what was dispatched after the
  fact — dispatch-not-inline is discipline the orchestrator must actually follow, and a caught
  violation is a review-gate finding, not a blocked tool call. (The `PreToolUse` hook still emits
  exactly one hard deny, unrelated to this rule: the action-class fence — see "Enforcement model:
  gates vs conventions", below.)

1. Compute waves: `$MUSTER_CLI wave .muster/manifest.json` -> ordered list of waves.
2. **Gate cadence (small-task fast path).** Read `.muster/gate-cadence.json` -> `{taskCount, waveCount,
   specGateRounds, reviewGateBatches, fastPath, reason}` — captured once by the invoking verb at spec-gate
   time (see `plugin/commands/go.md` step 4). Do **not** re-invoke `gate-cadence` here: the manifest's waves
   are already fixed by this point, so recomputing the identical result per invoker is pure duplication
   (dedup lever, same treatment as the `capabilities` capture above — see docs/performance-pass.md). Note
   the result in STATE. When `fastPath: true` (small plans, at or
   below the small-task threshold), step 4c below batches the review gate into a single pass over the
   cumulative diff instead of one dispatch per wave — same reviewer tier, same pass bar, same 3-iteration fix
   cap, only the CADENCE collapses (batching lever, not a weaker gate — see docs/performance-pass.md,
   criterion 3). When `fastPath: false`, step 4c keeps today's per-wave cadence unchanged: depth stays
   proportional to wave count as the plan grows.
3. **Pre-flight plan review (once, before wave 1).** Scan the whole plan for conflicts before dispatching anything:
   tasks that contradict each other or the manifest's `successCriteria`/global constraints, and anything a task
   mandates that the review gate would later flag as a defect (a test that asserts nothing, verbatim duplication of
   a logic block, a task that undoes another). Present everything found to the human as **one batched
   AskUserQuestion** — each finding beside the plan text that mandates it, asking which governs — **before**
   execution begins, not one interrupt per discovery mid-run. If the scan is clean, proceed without comment.
   In **unattended (Routine) mode** there is no human to ask: record the conflicts to STATE and proceed best-effort.
   This is a one-shot gate; the review-gate loop (step 4c) remains the net for conflicts that only emerge from
   implementation.
4. For each wave, in order:
   a. Write the wave id (e.g. `wave-1`) to `.muster/wave-active` before dispatching any task -- glass-box bookkeeping for STATE and the review gate's after-the-fact diff, not a marker the `PreToolUse` hook reads or enforces anything against (see "SKILL discipline, not a hook block", above). Note: `.muster/run-active` is a separate, verb-level marker (not per-wave); it is written by the invoking verb (run/autopilot/diagnose/audit) at invocation start and removed when the verb exits. Then dispatch every task in the wave **concurrently** (use the harness Agent tool):
      - `mode: single` -> one implementer agent, given the task + the Crew Manifest as BRIEF.
      - `mode: tournament` -> invoke the **tournament** skill for that task (runs N competing agents, a judge scores each and produces a debate fusion map, then `muster fuse` decides: synthesize the top-K via a hardened synthesizer agent, or fall back to the best passing candidate when candidates already agree).
      - **Parallel isolation (concurrent file writers):** when a wave dispatches more than one task
        that writes files, give each its own git worktree (`isolation: "worktree"` on the Agent tool)
        so independent same-wave tasks cannot collide on the shared working tree; the post-barrier
        step reconciles them. Read-only tasks (investigate/review) and single-task waves skip it.
      - **Provider kind:** look up the role's chosen provider from the run's captured
        `.muster/capabilities.json` (written once at run start — see plugin/commands/go.md step 3) ->
        `roles[<role>].chosen = { id, source, kind }`. Do **not** re-invoke `capabilities` mid-run: the
        inventory does not change during a run, so every wave's provider-kind lookup and review-gate's own
        `AvailableCapabilities` input (below) read the SAME captured file (dedup lever, not a correctness
        risk — see docs/performance-pass.md):
        - `chosen.kind === "agent"` -> dispatch with that agent **as the subagent type**
          (the Agent tool's `subagent_type`/`agentType` = `chosen.id`), passing the task +
          the Crew Manifest as the BRIEF.
          - **Generic-subagent fallback (degraded path):** if `chosen.id` is **not a dispatchable
            type in the running session's registry** — e.g. the plugin's agents were installed after
            the session started and have not been picked up yet (agent types become dispatchable only
            after a Claude Code restart) — do **not** fail the task. Fall back to a **generic**
            subagent (`subagent_type` = the harness default, e.g. `general-purpose`) and inject the
            resolved provider's **brief** into the BRIEF, exactly as the skill/mcp branch below does.
            The output is equivalent; only the specialist's own system prompt is skipped — the role's
            `model` override (next bullet) is still applied, so model selection is never lost on the
            fallback. Glass-box: note in STATE that the role ran via the generic fallback (agent type
            unavailable in session) rather than its native specialist.
        - else (`kind` skill / mcp / inline) -> dispatch a **generic** subagent and inject the
          resolved provider (skill) into the BRIEF, as today.
      - **Model (authoritative, regardless of kind):** always pass the crew member's `model` as the
        Agent tool's `model` **override**. The model is written into each crew member in the manifest
        by the router from `muster capabilities` output (the `roles[<role>].model` value). Fable is
        degraded to **opus deterministically at the emission layer** (`modelForRole` in `src/model.js`)
        because the tier can be disabled platform-wide — so by default the manifest never carries
        `fable` and the orchestrator never dispatches it. (Opt back in with `MUSTER_ENABLE_FABLE=1`
        once the tier returns.) If an opted-in fable dispatch is still rejected, retry once with
        **opus** (`fallbackModelFor("fable")`) and record the degradation in STATE — never fail the
        task over a model tier, and never drop the override (a dropped override silently inherits the
        orchestrator's model).
      - **Subagent failure (error or crash):** a dispatch that errors or dies is NEVER a silent stop.
        Re-dispatch ONCE with the same brief plus the error appended as context (`dispatchRetryState`
        from `src/loop.js` — max 2 attempts; model-availability rejections follow the fable→opus rule
        above instead). If the retry also fails: record the failure in STATE and treat it exactly like
        a review-gate escalation (step 4e) — the wave's OTHER tasks still complete and the barrier
        collects what succeeded; only the failed task escalates.
   b. BARRIER: wait for all wave tasks to finish; then remove `.muster/wave-active` (glass-box bookkeeping only — no hook reads this marker; review-gate fix agents are dispatched via the Agent tool after the barrier, same as any other task).
   c. **Review gate — cadence follows step 2's `gate-cadence` result:**
      - `fastPath: false` (plans above the small-task threshold): invoke the **review-gate** skill over THIS
        wave's changes now, same as always — depth stays proportional to wave count as the plan grows.
      - `fastPath: true` (small plans): do **not** invoke review-gate after every wave. Instead accumulate
        this wave's diff (the commits since the last batched review, or since run start for the first wave)
        and defer the actual review-gate dispatch to step 5, after the LAST wave — one pass over the FULL
        cumulative diff instead of one dispatch per wave. Still commit this wave's work per step d below;
        only the review-gate DISPATCH itself batches.
      Either way, when review-gate does run (per-wave or batched), the review->fix cycle loops: re-dispatch
      fix attempts until the gate passes (`done`) or the iteration cap is hit (`max-iterations`), then
      escalate per step 4e below. The cap is **3 fix iterations** (`REVIEW_GATE_MAX_ITERATIONS` in
      `src/loop.js` -- a plugin-user sees this value enforced by the review-gate skill) — unchanged by
      batching: a batched pass gets the same 3-iteration cap as any single-wave pass, over the larger diff.
      **Advisor escalation (worker-signaled):** if a dispatched worker returns a structured advice-request
      (`{ question, context, decisionType, options? }`) instead of a final result, service it via the
      **advisor** skill -- run `$MUSTER_CLI advise .muster/advice-request.json` (validates + returns
      `{ advisorModel, request }`), check the consult budget (`consultBudget` in `src/advisor.js`;
      default cap 3, `MUSTER_ADVISOR_MAX_CONSULTS`), dispatch a native advisor agent on `advisorModel`
      (`fable->opus`), append the consult to STATE, and re-dispatch the worker with the advice injected.
      The advisor informs; the worker owns the final decision. See `plugin/skills/advisor/SKILL.md`.
   d. Append to the run STATE: the wave index, tasks, winners, and review result (or "review deferred to
      the batched pass" when fast-pathing) — AND the re-rendered plan checklist with completed tasks ticked
      (`$MUSTER_CLI plan-checklist .muster/manifest.json --done <comma-separated completed ids>`), so the
      STATE shows the plan progressing `- [ ]` -> `- [x]`.
   e. If the review gate escalates (fix-loop cap, or a tournament with no passing candidate), do not start
      the next wave. **First dispatch `muster-strategist` (read-only, root-cause) on the failing task plus
      the fix-loop history** — the same error surviving repeated fixes is a design/spec problem, not another
      edit, and the strategist is the read-only reasoner for exactly that. Append its analysis to STATE. Then
      present the resolution choices via the **AskUserQuestion** selection UI — e.g. **Apply the strategist's
      recommendation** / **Retry with more context** / **Re-scope the task** / **Abort the run**. In unattended
      (Routine) mode, record the strategist's root-cause to the run report instead of prompting.
5. After the last wave: when step 2's `gate-cadence` reported `fastPath: true`, invoke the **review-gate**
   skill NOW, once, over the full cumulative diff of every batched wave (step 4c's deferred pass) — same
   fix-loop/escalation handling as 4c/4e, applied to this one pass. Then summarize the run and ensure
   FOLLOWUPS are recorded.

## Return contract (every dispatch)

Every crew brief MUST end with a return contract, so the orchestrator's per-task read stays a single pass:

- **Implementers/builders** return raw data, <=2000 chars: files changed (as paths), test counts, deviations
  one line each.
- **Reviewers** return the verdict FIRST, then <=1500 chars of findings.
- **No code snippets, stack traces, or file dumps** in any return, ever.
- The orchestrator reads each subagent result exactly once (one TaskOutput) and does not re-read transcripts.
- **No accumulation between waves:** git history and the run STATE are the record, not the orchestrator's
  memory.

## Task board

Alongside STATE, maintain one harness-visible task per work item (plan task, sprint item, or fix-wave
slice) via the harness's native task-tracking primitive when present -- on Claude Code CLI/Desktop that is
`TaskCreate`/`TaskUpdate`/`TaskList` (the board that superseded the older `TodoWrite` tool; either name
still counts as proof of an active board -- see docs/research/reference-harness-design.md's `cc-plan`
source, which cites claude-code-cli.md §6 "Native planning and the task board"): create it at dispatch,
flip to in_progress when the item's builder launches,
completed when its merge lands. The native board is authoritative for what the user sees as live progress;
STATE stays the glass-box ledger of WHY each state changed (dispatch rationale, review findings,
escalations) -- both maintained, neither substituting for the other. Umbrella tasks may group but never
replace per-item entries. Fail-soft, per harness (docs/research/reference-harness-design.md Part C's
port-surface table): a harness with no task-tracking primitive at all (Codex CLI/Desktop, Cowork, and the
Agents SDK today) relies on STATE alone (note this once); Hermes's own kanban (an SQLite-backed
`task_events` ledger with atomic claims and heartbeats, richer than a flat todo list) is a further native
fit the capstone names as a future coordination-skill binding, not yet wired into this section.

## Scope fences

When plan tasks carry `owns`/`frozen` fields, copy them into the brief verbatim as `OWNS:`/`FROZEN:` lines --
the dispatched agent sees its fences in the same brief as the task text, never a paraphrase. Dispatch tasks in
the same wave in parallel only when their `owns` sets are disjoint -- this is orchestrator judgment; the
validator does not evaluate overlap between tasks.

A third dimension is action-scoped, not path-scoped: at run start, write the manifest's top-level
`forbiddenActions` to `.muster/forbidden-actions` (one class per line) -- the `PreToolUse` hook reads this
file to deny matching tool calls for the run's duration. The file carries only the TOP-LEVEL set (the hook
reads the file alone, never a task's own `forbiddenActions`); per-task additions stay brief-level discipline.
For each task, copy the effective set (top-level `forbiddenActions` UNION the task's own `forbiddenActions`,
if any) into its brief as a `FORBIDDEN ACTIONS:` line, same as `OWNS`/`FROZEN`. Remove
`.muster/forbidden-actions` immediately before executing the run's declared merge disposition -- fences guard
the work phase, and the declared disposition is the human-authorized exit -- and in any case no later than
when the run closes.

## Required skills (brief binding)

When a plan task carries a `skills: [{id, rationale}]` binding (per the manifest schema), every brief
dispatched for that task -- builder AND reviewer -- MUST include a `REQUIRED SKILLS -- load before
working:` block, one line per binding, carrying the skill's `id`, its resolvable `source` looked up from
`AvailableCapabilities.skills` by that `id` (id + source is enough to locate the skill --
installed/builtin/dynamic), and its `rationale` verbatim from the manifest, same discipline as
`OWNS`/`FROZEN` above. The block carries one added instruction: the dispatched subagent loads/reads each
listed skill BEFORE starting work, and its report proves it -- one line it actually read from the
skill's own content, quoted verbatim; an id echo alone is NOT proof of load. The builder's report MUST
also carry one `skillsUsed`/`skillsSkipped` line per binding: `skillsSkipped` requires a stated reason,
never a bare skip. A binding the report is silent on is an automatic review-gate finding -- not an
inference the orchestrator makes after the fact, and not left to reviewer discretion (glass-box,
fail-loud).

- **Reviewer briefs** carry the identical REQUIRED SKILLS block, plus one added duty: the reviewer
  checks that the builder's report carries a `skillsUsed`/`skillsSkipped` line for each required
  binding -- used with its quoted proof line, or skipped with a stated reason. A binding the report is
  silent on is itself an automatic review finding, by rule, not a judgment call the reviewer weighs.
- **No binding, no invention:** a task with no `skills` array gets no REQUIRED SKILLS block, and the
  orchestrator does NOT invent one at dispatch time -- binding tasks to skills is the router's job, not
  this one; this skill only carries forward whatever binding the manifest already holds.
- **Surface line:** when the task carries a `surface` field, add one line to the brief naming the gate
  that awaits: `surface: ui` -> the Design/UX gate, `surface: copy` -> the Humanizer gate, `surface:
  integration` -> the Live-verification gate, `surface: none` -> no surface-type gate applies. This is a
  heads-up only, e.g. `surface: ui -- the review gate's Design/UX gate will fire` -- see review-gate's
  "Surface-type definition-of-done gates" section (`plugin/skills/review-gate/SKILL.md`) for what each
  gate actually checks; do not duplicate its rules here.
- **Known anti-patterns:** before dispatching, skim `docs/anti-patterns.md` if present -- muster's
  versioned ledger of caught failure classes (symptom, root cause, the guard now in place; not shipped
  in a packed install) -- for any entry that matches the task's shape, and name it in the brief as a
  one-line heads-up, e.g. `anti-pattern: #2 colon-description frontmatter parse -- see
  docs/anti-patterns.md`. No match, or no file, needs no line; this is a targeted reminder, not a
  mandatory recap of the whole ledger.

## Wave provenance (git notes)

Immediately after each wave commit, attach a structured note recording the wave's intent, not just its diff:

`git notes --ref=muster add -m '<one-line JSON: {"task":"<id>","decisions":["..."],"reviewCycles":N,"findingsFixed":["..."],"findingsAccepted":["..."]}' <commit sha>`

Notes are repo-local provenance (not pushed by default) -- the review-gate skill reads them later to weigh the
implementation against recorded intent, not just the diff (see review-gate's "Intent vs implementation").

## Channel steering (remote)

When the orchestrator is driven remotely (Channels wired), a steering message may arrive mid-run as a
`<channel source="...">` event. Classify **every** such event deterministically by running
`muster steer "<msg>"` (via `$MUSTER_CLI steer "<msg>"`, which calls `classifySteer` in `src/steer.js`) — do NOT
free-interpret it. Map the returned action:

- **approve** — treat as the human passing the current review gate: end the current `loopState`
  fix-cycle as `done` and continue to the next wave.
- **stop** — halt after the current in-flight wave completes (never abandon a wave mid-flight); write
  the halt + current plan-checklist to STATE; reply through the channel that the run is stopped.
- **status** — read-only: reply through the channel with the live `$MUSTER_CLI plan-checklist
  .muster/manifest.json --done <completed ids>` rendering; do not change run state.
- **retarget** — a scope change: do NOT silently re-scope the run; record it as a follow-up and reply
  through the channel that it's been logged for the human to confirm (spec-as-current-truth: the
  manifest stays the single source).
- **unknown** — say so rather than guessing at intent: reply through the channel asking the human to
  rephrase (approve / stop / status / retarget); take no action until they clarify.

Iron-rule reminder: dispatch-not-inline is SKILL discipline, checked only by the review gate after the fact -- no hook enforces it; see the opening section.

## Enforcement model: gates vs conventions

**Principle:** enforce where mechanically sound; a gameable gate that fails open is worse than an honest, named convention. The enforcement-model redesign (see CHANGELOG) narrowed this to one rule: enforcement now follows the run's EXTERNAL effects, not the orchestrator's own in-repo edits. A hard main-loop deny keyed on file-system markers (wave-active, a per-turn file count) could not distinguish orchestration-scale drift from legitimate concurrent work in a repo/session muster never touched, and repeated kill-switch escape hatches trained agents to disable the enforcement rather than trust it -- so the wave-guard, the post-run scale-gate, and the todo-driving gate were removed entirely rather than patched a fourth time.

### THE ONE HARD DENY (hook-enforced, deterministic)

- **Action-class fence:** while a run is active (`.muster/run-active` present) and the orchestrator has written `.muster/forbidden-actions` (one class per line, from the manifest's top-level `forbiddenActions` -- see "Scope fences", above), a tool call classified into one of those forbidden classes is denied (`plugin/hooks/pre-tool-use.js`, `plugin/hooks/action-guard.js`). Fail-open on either file's absence. Honors `MUSTER_ACTION_GUARD=warn|off` to soften or disable. This is the ONLY tool call the `PreToolUse` hook can deny.
- **Meta-exempt roots:** `.muster/` and `.claude/` (in-cwd) are always allowed, ahead of the fence check -- orchestrator bookkeeping and repo-local settings must never be blocked. Paths outside the project cwd are likewise exempt by scope (cwd-relative gate).

### WARN-ONLY (hook-enforced, never denies -- "the border invitation")

- **Cumulative inline-file counter (`PreToolUse`):** with no muster run active, crossing `MUSTER_INLINE_SCALE` (default 3) distinct inline-edited files across turns fires one warn-only reminder to reach for a muster run, then stays silent until re-armed by a run starting, `SessionStart`, or 60 minutes of inactivity. Resets (not denies) while a run is active -- that work is tracked/dispatched, not drift.
- **Directive-prompt nudge (`UserPromptSubmit`):** a directive-shaped prompt (`isDirective` in `guidance.js`) with no muster run active fires the same value-toned reminder immediately, on the same re-arm cadence. Neither signal ever denies a tool call or blocks a prompt -- worth reaching for, never commanded.

### CONVENTIONS (not gate-able; enforced by SKILL discipline)

- **Dispatch-not-inline (the iron rule):** previously a hard `wave-active` deny (0.3.x-0.4.x); the enforcement-model redesign removed that deny path (see the "Iron rule" section, above). Enforced only by this skill's discipline and the review gate diffing what changed against what was dispatched after the fact.
- **Todo-driving visibility:** previously a hook-enforced gate (0.3.2-0.4.x, `todo-gate.js`, denied a `Task`/`Agent` dispatch without a native todo write since run start); removed by the same redesign -- gameable with a throwaway todo (it enforced visibility, not compliance), and it added dispatch-time transcript-scan latency for that guarantee. Now this skill's "Task board" section carries the discipline alone: one harness-visible task per work item, created before its dispatch.
- **Crew-owner/state-in-subject:** the `PreToolUse` hook cannot judge who owns a task or whether it is multi-step -- that is runtime judgment, not a file-system observable.
- **Verb selection:** intent classification (is this a bug fix? a new feature? a sweep?) is a model judgment call, not a deterministic signal the hook can test.
- **Content-through-humanizer routing:** the routing decision is judgment; the OUTPUT rules (no em-dash, no banned openers) are enforced post-hoc by contract tests on committed artifacts.
- **Glass-box narration:** narration is output content (the model's reply text), not a tool surface -- there is no hook point to enforce it.

### REJECTED (with reasons)

- **Verb-routing run-active BLOCK:** rejected. Between-wave writes are already `.muster/`-exempt or `agent_id`-exempt; adding a block on absent run-active would add no enforcement power and would false-block trivial multi-file edits outside a run.
- **Transcript-scan todo gate:** rejected in 0.3.1, then revisited and built in 0.3.2 (`todo-gate.js`) once narrowed to dispatch time only -- a todo write since the `run-active` mtime is a bounded, mechanically checkable question, and the hard bias-to-allow decision order removed the fail-open objection at the time. Removed entirely by the enforcement-model redesign (see CHANGELOG): still gameable with a throwaway todo, and the false-positive/latency cost stopped being worth that trade. Todo-driving is convention again (see CONVENTIONS, above).
- **Wave-guard / post-run scale-gate deny paths:** built and repeatedly patched through 0.4.x for field-reported false positives (most recently a session-engagement marker bolted onto the scale-gate); removed entirely by the enforcement-model redesign rather than patched a fourth time -- the root problem was the model itself, not a fixable edge case (see the section intro, above, and CHANGELOG).
