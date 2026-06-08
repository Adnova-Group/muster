---
name: autopilot
description: "Hands-off full lifecycle. Plans THEN executes end to end: branch, route, run waves (parallel fan-out + tournaments + adversarial review gate), commit per wave, then present merge. Only stops for the merge decision or an escalation. (vs /muster:run, which only plans and shows.) Usage: /muster:autopilot <outcome>"
---

The outcome: `$ARGUMENTS`

If empty, ask for the outcome and stop (outcome-anchored). Otherwise drive this hands-off run:

0. **Issue ref?** If `$ARGUMENTS` is a GitHub issue reference (`#N`, a bare number, or an issues URL), run `npx muster issue "$ARGUMENTS"` and use the returned `outcome` (issue title + body) as the outcome for the rest of the run. If `gh` fails: attended → report and stop; unattended (Routine) → record the failure to the run report and stop (no outcome to run).
1. **Branch** — create a work branch off the base (never run on the base branch) — for full isolation, create a git worktree under `.worktrees/<branch>/` (per superpowers using-git-worktrees) so the main workspace stays clean; a plain branch is fine otherwise.
2. **Detect** — `npx muster detect`. If `greenfield: true`, run the **greenfield** skill, then re-detect.
3. **Route** — first close any info-gap: `npx muster assess "$ARGUMENTS"` → `{ clear, signals }`. In attended
   mode, if `clear: false`, trigger the **interview** skill ONCE to enrich the outcome and gather
   `successCriteria` before routing, then continue hands-off with the approved enriched outcome (unattended
   handling is in the Routine subsection below). Then `npx muster capabilities` → invoke the **router** skill →
   validated Crew Manifest at `.muster/manifest.json` (`npx muster manifest validate` until ok). Dispatch
   honors each role's resolved provider kind (`roles[<role>].chosen.kind`) — installed external agents first,
   then muster's built-in agents, then skills — and always applies the role's `model`.
4. **Show the plan** — `npx muster plan-checklist .muster/manifest.json` and display it.
5. **Orchestrate** — run the **orchestrator** skill over the manifest (waves, tournaments, review gate)
   **without pausing** at gates. Each wave loops until criteria are met via the Ralph loop (`loopState`
   in `src/loop.js`): orchestrator iterates implement→review→fix until the wave's gate passes or the
   iteration cap escalates (step 6). After each green + reviewed wave: commit (`feat(wave N): <summary>`)
   and re-render the checklist with completed ids (`--done …`) into the run STATE.
6. **Escalation** — if a review gate escalates (fix-loop cap) or a tournament has no passing candidate,
   STOP and report the unresolved items; the branch stays intact.
7. **Finish** — after the last wave, present the merge decision (finishing-a-development-branch) via the
   **AskUserQuestion** selection UI with options **Merge locally** / **Open PR** / **Keep branch** /
   **Discard**. The single attended human decision. No auto-push.

**Unattended (Routine) mode**

When autopilot is fired by a Claude Code Routine (no interactive human present), steps 1–6 run identically — except the step 3 info-gap check must **not** block (there is no human to interview). Step 7 is non-interactive:

- On `npx muster assess` returning `clear: false`, **do not** trigger the interview. Record the gap (the `signals`) to the run report in STATE and proceed with best-effort defaults — autonomy still stops at the reviewable artifact (the PR), where the human can close the gap.
- The merge **disposition** comes from the outcome text (e.g. "…then open a PR" / "…keep the branch"). **Default when no disposition is stated: open a Pull Request.**
- **Never** auto-merge to a base branch and **never** push directly to main/master in unattended mode — autonomy stops at the reviewable artifact (the PR).
- Escalations (fix-loop cap reached, tournament with no passing candidate) are written to the run report in STATE instead of blocking on an interactive prompt; the Routine result and any wired Channel can surface them to the human.
- The outcome is supplied via the Routine's `text` field (API `/fire`) or the saved Routine config — the same `$ARGUMENTS` slot, nothing extra to wire.

Glass box: branch, each commit, escalations, and the ticking checklist are recorded in STATE.
