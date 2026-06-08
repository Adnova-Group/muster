---
name: diagnose
description: "Failure-first bug fix. Reproduce, find root cause (systematic debugging via the best available debug provider — installed wshobson/external else built-in), fix, add a regression test, verify. No symptom-patching. Usage: /muster:diagnose <symptom | paste failing test/CI output>"
---

The failure: `$ARGUMENTS`

If empty, ask for a symptom or failing output and stop. Otherwise drive the diagnose loop:

1. **Seed**: `npx muster diagnose "<symptom>"` (or `--ci <file>` for pasted output) -> `{mode, manifest}`.
   Write the manifest to `.muster/manifest.json`; validate (`npx muster manifest validate`).
2. **Reproduce** (plan: `repro`) — confirm the failure reproduces. If it can't be reproduced, report and stop.
3. **Root cause** (plan: `root-cause`, role `debug`) — dispatch the chosen `debug` provider (an installed
   wshobson/external debugger if present, else built-in systematic-debugging). Produce a HYPOTHESIS
   TABLE -> cheapest test first -> the root cause. Record it in STATE. Do NOT proceed without a root cause (no symptom-patching).
4. **Fix** (plan: `fix`, role `implement`) — apply the minimal fix targeting the root cause.
5. **Regression** (plan: `regression`, role `test-author`) — add a test that fails before the fix and
   passes after. A fix without a regression test is not done.
6. **Verify** (plan: `verify`, role `code-review`) — run the **review-gate** + the full suite; must be green.
   Tick progress: `npx muster plan-checklist .muster/manifest.json --done <ids>` into STATE.
7. Escalate if the root cause can't be found or the gate can't pass within the cap. Then present merge.

Reuses the orchestrator + review-gate; glass box records hypotheses, the chosen debug provider, and the root cause.
