---
name: autopilot
description: Drive a Muster run hands-off — branch, detect, greenfield-bootstrap if needed, route, orchestrate waves, commit per wave, then present merge. No pauses except the merge decision + escalations.
---

# Autopilot

Input: an `outcome` string. If absent, stop (outcome-anchored).

1. **Branch** — create a work branch off the base (never run on the base branch).
2. **Detect** — `npx muster detect`. If `greenfield: true`, run the **greenfield** skill, then re-detect.
3. **Route** — `npx muster capabilities` → invoke the **router** skill → validated Crew Manifest at
   `.muster/manifest.json` (`npx muster manifest validate` until ok).
4. **Show the plan** — `npx muster plan-checklist .muster/manifest.json` and display it.
5. **Orchestrate** — run the **orchestrator** skill over the manifest (waves, tournaments, review gate)
   **without pausing** at gates. After each green+reviewed wave:
   - commit the wave's changes (`feat(wave N): <summary>`),
   - re-render the checklist with the completed task ids (`--done …`) and append it to the run STATE.
6. **Escalation** — if a wave's review gate escalates (fix-loop cap) or a tournament has no passing
   candidate, STOP and report the unresolved items. Do not proceed. The branch stays intact.
7. **Finish** — after the last wave, present merge options (the finishing-a-development-branch skill).
   This is the single human decision. No auto-push.

Glass box: branch, each commit, escalations, and the ticking checklist are all recorded in STATE.
