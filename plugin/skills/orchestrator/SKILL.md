---
name: orchestrator
description: Execute a validated Crew Manifest in dependency-ordered waves, with a barrier + adversarial review gate between waves. Glass-box: every wave/decision appended to the run STATE.
---

# Orchestrator (wave executor)

<!-- prompt-lint-disable ANTH-POS-001: orchestration prompt — its prohibitions (never-fail-over-tier, never-drop-override, no-silent-stop, no-silent-rescope) are intentional, safety-critical guarantees and must stay imperative -->

You are muster's wave executor. Drive the manifest's waves and record every decision in the run STATE; emit a ticking markdown checklist and a per-wave commit.

Inputs: a validated `.muster/manifest.json` and a `runId` (e.g. a slug of the outcome).

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
- **Hard gate:** the `PreToolUse` hook (`plugin/hooks/pre-tool-use.js`) enforces this rule at the
  harness level — it will deny any main-loop Edit/Write/NotebookEdit while `.muster/wave-active`
  exists, so inline drift is blocked, not just discouraged. The hook also inspects Bash commands
  for file-write patterns (`sed -i`, `tee`, `>` / `>>` redirects); set `MUSTER_WAVE_GUARD=warn`
  to allow with a reminder if the guard triggers a false positive.

1. Compute waves: `npx -y @adnova-group/muster wave .muster/manifest.json` -> ordered list of waves.
2. **Pre-flight plan review (once, before wave 1).** Scan the whole plan for conflicts before dispatching anything:
   tasks that contradict each other or the manifest's `successCriteria`/global constraints, and anything a task
   mandates that the review gate would later flag as a defect (a test that asserts nothing, verbatim duplication of
   a logic block, a task that undoes another). Present everything found to the human as **one batched
   AskUserQuestion** — each finding beside the plan text that mandates it, asking which governs — **before**
   execution begins, not one interrupt per discovery mid-run. If the scan is clean, proceed without comment.
   In **unattended (Routine) mode** there is no human to ask: record the conflicts to STATE and proceed best-effort.
   This is a one-shot gate; the per-wave review loop (step 3c) remains the net for conflicts that only emerge from
   implementation.
3. For each wave, in order:
   a. Write the wave id (e.g. `wave-1`) to `.muster/wave-active` before dispatching any task — the `PreToolUse` hook reads this marker to enforce the iron rule. Then dispatch every task in the wave **concurrently** (use the harness Agent tool):
      - `mode: single` -> one implementer agent, given the task + the Crew Manifest as BRIEF.
      - `mode: tournament` -> invoke the **tournament** skill for that task.
      - **Provider kind:** look up the role's chosen provider from capabilities
        (`npx -y @adnova-group/muster capabilities` -> `roles[<role>].chosen = { id, source, kind }`):
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
        a review-gate escalation (step 3e) — the wave's OTHER tasks still complete and the barrier
        collects what succeeded; only the failed task escalates.
   b. BARRIER: wait for all wave tasks to finish; then remove `.muster/wave-active` (the hook will allow edits again from this point; review-gate fix agents are dispatched via the Agent tool after the barrier).
   c. Invoke the **review-gate** skill over the wave's changes. The review→fix cycle loops: re-dispatch
      fix attempts until the gate passes (`done`) or the iteration cap is hit (`max-iterations`), then
      escalate per step 3e below. The cap is **3 fix iterations** (`REVIEW_GATE_MAX_ITERATIONS` in
      `src/loop.js` — a plugin-user sees this value enforced by the review-gate skill).
   d. Append to the run STATE: the wave index, tasks, winners, and review result — AND the re-rendered
      plan checklist with completed tasks ticked (`npx -y @adnova-group/muster plan-checklist .muster/manifest.json
      --done <comma-separated completed ids>`), so the STATE shows the plan progressing `- [ ]` -> `- [x]`.
   e. If the review gate escalates (fix-loop cap, or a tournament with no passing candidate), stop and do
      not start the next wave. Present the resolution choices via the **AskUserQuestion** selection UI —
      e.g. **Retry with more context** / **Re-scope the task** / **Abort the run**.
4. After the last wave, summarize the run and ensure FOLLOWUPS are recorded.

## Channel steering (remote)

When the orchestrator is driven remotely (Channels wired), a steering message may arrive mid-run as a
`<channel source="...">` event. Classify **every** such event deterministically by running
`npx -y @adnova-group/muster steer "<msg>"` (which calls `classifySteer` in `src/steer.js`) — do NOT
free-interpret it. Map the returned action:

- **approve** — treat as the human passing the current review gate: end the current `loopState`
  fix-cycle as `done` and continue to the next wave.
- **stop** — halt after the current in-flight wave completes (never abandon a wave mid-flight); write
  the halt + current plan-checklist to STATE; reply through the channel that the run is stopped.
- **status** — read-only: reply through the channel with the live `npx -y @adnova-group/muster plan-checklist
  .muster/manifest.json --done <completed ids>` rendering; do not change run state.
- **retarget** — a scope change: do NOT silently re-scope the run; record it as a follow-up and reply
  through the channel that it's been logged for the human to confirm (spec-as-current-truth: the
  manifest stays the single source).
- **unknown** — reply through the channel asking the human to rephrase (approve / stop / status /
  retarget); take no action.

Iron-rule reminder: the `PreToolUse` wave-guard hook enforces dispatch-not-inline; see the opening section.
