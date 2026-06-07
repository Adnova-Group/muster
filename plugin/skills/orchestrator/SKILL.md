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
   b. BARRIER: wait for all wave tasks to finish.
   c. Invoke the **review-gate** skill over the wave's changes.
   d. Append a STATE line recording wave index, tasks, winners, and review result
      (append to the run STATE file via the appendState helper / record the wave outcome in <runId>.state.md).
   e. If the review gate escalates, stop and report to the user (do not start the next wave).
3. After the last wave, summarize the run and ensure FOLLOWUPS are recorded.

Iron rules: never start wave k+1 before wave k passes the gate; never silently drop a failed task
(record it in STATE); keep the manifest the single source (spec-as-current-truth).
