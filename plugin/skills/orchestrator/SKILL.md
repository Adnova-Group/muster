---
name: orchestrator
description: Execute a validated Crew Manifest in dependency-ordered waves, with a barrier + adversarial review gate between waves. Glass-box: every wave/decision appended to the run STATE.
---

# Orchestrator (wave executor)

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
- **Honest limit:** this is steering, not a hard gate — nothing in the plugin can block a main-loop
  edit. The real fix is harness-level (a PreToolUse hook that blocks main-loop Edit/Write while a wave
  is active); until that exists, this rule is the guardrail.

1. Compute waves: `npx muster wave .muster/manifest.json` -> ordered list of waves.
2. For each wave, in order:
   a. Dispatch every task in the wave **concurrently** (use the harness Agent tool):
      - `mode: single` -> one implementer agent, given the task + the Crew Manifest as BRIEF.
      - `mode: tournament` -> invoke the **tournament** skill for that task.
      - **Provider kind:** look up the role's chosen provider from capabilities
        (`npx muster capabilities` -> `roles[<role>].chosen = { id, source, kind }`):
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
      - **Model (authoritative, regardless of kind):** always pass the crew member's `model` (bound
        into the manifest by the builders; same value as `roles[<role>].model`) as the Agent tool's
        `model` **override** — this takes precedence over an agent's own frontmatter model, so
        `modelForRole` governs: mechanical roles (code-navigation, docs-research, research) run on
        **haiku**, the default is **sonnet**, peak judgment (the tournament judge, architecture
        review) is **fable**. This keeps quota spend proportional to the work (Muster runs on your
        interactive subscription). **Fable fallback:** fable may be unavailable on the current plan
        (e.g. it requires extra usage credits). If a fable dispatch is rejected for that reason,
        retry once with `fallbackModelFor` from `src/model.js` (fable -> **opus**) and record the
        degradation in STATE — never fail the task over a model tier, and never drop the override
        (a dropped override silently inherits the orchestrator's model).
   b. BARRIER: wait for all wave tasks to finish.
   c. Invoke the **review-gate** skill over the wave's changes. The review→fix cycle loops using
      `reviewGateState` (from `src/loop.js`): re-dispatch fix attempts until the gate passes (`done`)
      or the iteration cap is hit (`max-iterations`), then escalate per step 2e.
   d. Append to the run STATE: the wave index, tasks, winners, and review result — AND the re-rendered
      plan checklist with completed tasks ticked (`npx muster plan-checklist .muster/manifest.json
      --done <comma-separated completed ids>`), so the STATE shows the plan progressing `- [ ]` -> `- [x]`.
   e. If the review gate escalates (fix-loop cap, or a tournament with no passing candidate), stop and do
      not start the next wave. Present the resolution choices via the **AskUserQuestion** selection UI —
      e.g. **Retry with more context** / **Re-scope the task** / **Abort the run**.
3. After the last wave, summarize the run and ensure FOLLOWUPS are recorded.

## Channel steering (remote)

When the orchestrator is driven remotely (Channels wired), a steering message may arrive mid-run as a
`<channel source="...">` event. Classify **every** such event deterministically with `classifySteer`
(from `src/steer.js`) — do NOT free-interpret it. Map the returned action:

- **approve** — treat as the human passing the current review gate: end the current `loopState`
  fix-cycle as `done` and continue to the next wave.
- **stop** — halt after the current in-flight wave completes (never abandon a wave mid-flight); write
  the halt + current plan-checklist to STATE; reply through the channel that the run is stopped.
- **status** — read-only: reply through the channel with the live `npx muster plan-checklist
  .muster/manifest.json --done <completed ids>` rendering; do not change run state.
- **retarget** — a scope change: do NOT silently re-scope the run; record it as a follow-up and reply
  through the channel that it's been logged for the human to confirm (spec-as-current-truth: the
  manifest stays the single source).
- **unknown** — reply through the channel asking the human to rephrase (approve / stop / status /
  retarget); take no action.

Iron rules: never start wave k+1 before wave k passes the gate; never silently drop a failed task
(record it in STATE); never do a wave's implement/review work inline — always dispatch to the resolved
provider and record the `dispatching <id> -> <subagent_type>` line in STATE; keep the manifest the
single source (spec-as-current-truth); never let a channel event silently re-scope the run or abandon
an in-flight wave.
