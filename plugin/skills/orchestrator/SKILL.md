---
name: orchestrator
description: Execute a validated Crew Manifest in dependency-ordered waves, with a barrier + adversarial review gate between waves. Glass-box: every wave/decision appended to the run STATE.
---

# Orchestrator (wave executor)

Inputs: a validated `.muster/manifest.json` and a `runId` (e.g. a slug of the outcome).

1. Compute waves: `npx muster wave .muster/manifest.json` -> ordered list of waves.
2. For each wave, in order:
   a. Dispatch every task in the wave **concurrently** (use the harness Agent tool):
      - `mode: single` -> one implementer agent, given the task + the Crew Manifest as BRIEF.
      - `mode: tournament` -> invoke the **tournament** skill for that task.
      - **Model:** dispatch each agent with the model for its role from capabilities
        (`muster capabilities` -> `roles[<role>].model`): mechanical roles (code-navigation,
        docs-research, research) run on **haiku**, the default is **sonnet**, heavy judgment is **opus**.
        This keeps quota spend proportional to the work (Muster runs on your interactive subscription).
   b. BARRIER: wait for all wave tasks to finish.
   c. Invoke the **review-gate** skill over the wave's changes. The review→fix cycle loops using the
      Ralph loop primitive (`loopState` in `src/loop.js`): re-dispatch fix attempts until the gate
      passes (`done`) or the iteration cap is hit (`max-iterations`), then escalate per step 2e.
   d. Append to the run STATE: the wave index, tasks, winners, and review result — AND the re-rendered
      plan checklist with completed tasks ticked (`npx muster plan-checklist .muster/manifest.json
      --done <comma-separated completed ids>`), so the STATE shows the plan progressing `- [ ]` -> `- [x]`.
   e. If the review gate escalates, stop and report to the user (do not start the next wave).
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
(record it in STATE); keep the manifest the single source (spec-as-current-truth); never let a channel
event silently re-scope the run or abandon an in-flight wave.
