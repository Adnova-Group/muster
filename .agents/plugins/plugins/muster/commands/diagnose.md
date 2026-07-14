---
name: diagnose
description: "Failure-first bug fix. Reproduce, find root cause (systematic debugging via the best available debug provider — installed wshobson/external else built-in), fix, add a regression test, verify. No symptom-patching. Usage: $muster-diagnose <symptom | paste failing test/CI output>"
---

## Codex harness binding

Read `${PLUGIN_ROOT}/runtime/codex-skill-adapter.md` before following this command. Its Codex tool, named-profile dispatch, bounded-context-fork, input, mode-name, and plugin-root bindings override legacy harness names below; this command's domain rules and gates remain authoritative.


You are muster's diagnose command: drive a failure through the full debug loop — reproduce, root cause, fix, regression test, verify.

Respond with a structured debug record: one section per phase (hypothesis table, confirmed root cause, fix applied, regression test, verify result). Escalate to the user when the root cause cannot be found within the cap.

<failure>$ARGUMENTS</failure>

If the failure description is empty, ask for a symptom or failing output and stop. Otherwise drive the diagnose loop:

**Run-active lifecycle:** Write `.muster/run-active` at invocation start (before step 1) -- the mode/run-in-progress marker Muster's Codex lifecycle hooks use for state diagnostics. Remove it after the merge decision or on escalation exit. Codex hooks never delete state markers automatically; on startup, verify and clear only a marker proven stale and owned by the interrupted workflow.

1. **Seed**: `node ${PLUGIN_ROOT}/runtime/muster.mjs diagnose "<symptom>"` (or `--ci <file>` for pasted output) prints `{mode, manifest}` JSON to stdout.
   Extract the emitted `manifest` object and write that object to `.muster/manifest.json`; validate (`node ${PLUGIN_ROOT}/runtime/muster.mjs manifest validate .muster/manifest.json --codex`).
2. **Reproduce** (plan: `repro`) — confirm the failure reproduces. If it can't be reproduced, report and stop.
3. **Root cause** (plan: `root-cause`, role `debug`) — dispatch the chosen `debug` provider (an installed
   wshobson/external debugger if present, else built-in systematic-debugging). Produce a HYPOTHESIS
   TABLE -> cheapest test first -> the root cause. Record it in STATE. A confirmed root cause is required before proceeding — symptom-patching is a failure mode.
4. **Fix** (plan: `fix`, role `implement`) — apply the minimal fix targeting the root cause.
5. **Regression** (plan: `regression`, role `test-author`) — add a test that fails before the fix and
   passes after. A fix without a regression test is not done.
6. **Verify** (plan: `verify`, role `code-review`) — run the **review-gate** + the full suite; must be green.
   Tick progress: `node ${PLUGIN_ROOT}/runtime/muster.mjs plan-checklist .muster/manifest.json --done <ids>` into STATE.
7. Escalate if the root cause can't be found or the gate can't pass within the cap. Then present merge.

Reuses the orchestrator + review-gate; glass box records hypotheses, the chosen debug provider, and the root cause.
