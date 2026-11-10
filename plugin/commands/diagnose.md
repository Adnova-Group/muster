---
name: diagnose
description: "Failure-first bug fix: reproduce, root-cause, fix, regression test. Usage: /muster:diagnose <symptom | failing output>"
argument-hint: "<symptom | failing output>"
upstream: []
---

You are muster's diagnose command: drive a failure through the full debug loop — reproduce, root cause, fix, regression test, verify.

Respond with a structured debug record: one section per phase (hypothesis table, confirmed root cause, fix applied, regression test, verify result). Escalate to the user when the root cause cannot be found within the cap.

<failure>$ARGUMENTS</failure>

If the failure description is empty, ask for a symptom or failing output and stop. Otherwise drive the diagnose loop:

**Run-active lifecycle:** Write `.muster/run-active` at invocation start (before step 1) -- the mode/run-in-progress marker the action fence uses to scope itself to this run. Remove it after the merge decision or on escalation exit. Nothing clears a stale marker automatically: overwrite one an interrupted run left behind, and delete `.muster/run-active` by hand to disarm a leftover action fence outside a run.

0. **CLI.** `M` below means `sh "${CLAUDE_PLUGIN_ROOT}/runtime/muster.sh"`: it runs this plugin's own source checkout, else the npm release pinned to this plugin's version, never a global `muster`. Repeat it in full in every Bash call; shell variables do not survive between calls.
1. **Seed**: `M diagnose "<symptom>"` (or `--ci <file>` for pasted output) -> `{mode, manifest}`.
   Write the manifest to `.muster/manifest.json`; validate (`M manifest validate`).
2. **Reproduce** (plan: `repro`) — confirm the failure reproduces. If it can't be reproduced, report and stop.
3. **Root cause** (plan: `root-cause`, role `debug`) — dispatch the chosen `debug` provider (an installed
   wshobson/external debugger if present, else built-in systematic-debugging). Produce a HYPOTHESIS
   TABLE -> cheapest test first -> the root cause. Record it in STATE. A confirmed root cause is required before proceeding — symptom-patching is a failure mode.
   When two or more causes stay plausible, run `Workflow({name:"muster:debug", args:{symptom, repro}})`: parallel read-only investigators, a cross-examination round, a deterministic verdict. `ROOT_CAUSE` gives the cause; `INCONCLUSIVE` escalates. Steps 4-5 may then run as a one-task `tdd="true"` plan through `muster:team` (independent test writer, then the fix).
4. **Fix** (plan: `fix`, role `implement`) — apply the minimal fix targeting the root cause.
5. **Regression** (plan: `regression`, role `test-author`) — add a test that fails before the fix and
   passes after. A fix without a regression test is not done.
6. **Verify** (plan: `verify`, role `code-review`) — dispatch `muster:muster-reviewer` (read-only) on the fix commits; a FAIL loops back to step 4 at most twice; then the full suite; must be green.
   Tick progress: `M plan-checklist .muster/manifest.json --done <ids>` into STATE.
7. Escalate if the root cause can't be found or the gate can't pass within the cap. Then present merge.

Follows the orchestrator skill's run rules; glass box records hypotheses, the chosen debug provider, and the root cause.
