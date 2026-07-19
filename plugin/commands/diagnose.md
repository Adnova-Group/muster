---
name: diagnose
description: "Failure-first bug fix. Reproduce, find root cause (systematic debugging via the best available debug provider — installed wshobson/external else built-in), fix, add a regression test, verify. No symptom-patching. Usage: /muster:diagnose <symptom | paste failing test/CI output>"
argument-hint: "<symptom | paste failing test/CI output>"
---

You are muster's diagnose command: drive a failure through the full debug loop — reproduce, root cause, fix, regression test, verify.

Respond with a structured debug record: one section per phase (hypothesis table, confirmed root cause, fix applied, regression test, verify result). Escalate to the user when the root cause cannot be found within the cap.

<failure>$ARGUMENTS</failure>

If the failure description is empty, ask for a symptom or failing output and stop. Otherwise drive the diagnose loop:

**Run-active lifecycle:** Write `.muster/run-active` at invocation start (before step 1) -- the mode/run-in-progress marker the `PreToolUse` hook uses to scope the scale-gate. Remove it after the merge decision or on escalation exit. `SessionStart` on a fresh session clears a stale marker automatically.

0. **Resolve the CLI (once per run).** A raw `npx -y <pkg>` re-verifies against the npm registry/cache on EVERY call; resolve `$MUSTER_CLI` ONCE with plain shell (no CLI call, so resolution itself never pays a cold start), preferring a vendored/local install over `npx` — see docs/performance-pass.md:
   ```bash
   if [ -n "$CLAUDE_PLUGIN_ROOT" ] && [ -f "$CLAUDE_PLUGIN_ROOT/runtime/muster.mjs" ]; then
     MUSTER_CLI="node $CLAUDE_PLUGIN_ROOT/runtime/muster.mjs"
   elif [ -f "./src/cli.js" ] && [ -f "./src/cli-resolve.js" ]; then
     MUSTER_CLI="node ./src/cli.js"
   elif [ -f "./node_modules/.bin/muster" ]; then
     MUSTER_CLI="./node_modules/.bin/muster"
   elif command -v muster >/dev/null 2>&1; then
     MUSTER_CLI="muster"
   else
     MUSTER_CLI="npx -y @adnova-group/muster"
   fi
   ```
   Every `muster` CLI call for the rest of this run (steps 1-7, and the orchestrator/review-gate skills this mode invokes) uses `$MUSTER_CLI` — never re-invoke `npx` directly.
1. **Seed**: `$MUSTER_CLI diagnose "<symptom>"` (or `--ci <file>` for pasted output) -> `{mode, manifest}`.
   Write the manifest to `.muster/manifest.json`; validate (`$MUSTER_CLI manifest validate`).
2. **Reproduce** (plan: `repro`) — confirm the failure reproduces. If it can't be reproduced, report and stop.
3. **Root cause** (plan: `root-cause`, role `debug`) — dispatch the chosen `debug` provider (an installed
   wshobson/external debugger if present, else built-in systematic-debugging). Produce a HYPOTHESIS
   TABLE -> cheapest test first -> the root cause. Record it in STATE. A confirmed root cause is required before proceeding — symptom-patching is a failure mode.
4. **Fix** (plan: `fix`, role `implement`) — apply the minimal fix targeting the root cause.
5. **Regression** (plan: `regression`, role `test-author`) — add a test that fails before the fix and
   passes after. A fix without a regression test is not done.
6. **Verify** (plan: `verify`, role `code-review`) — run the **review-gate** + the full suite; must be green.
   Tick progress: `$MUSTER_CLI plan-checklist .muster/manifest.json --done <ids>` into STATE.
7. Escalate if the root cause can't be found or the gate can't pass within the cap. Then present merge.

Reuses the orchestrator + review-gate; glass box records hypotheses, the chosen debug provider, and the root cause.
