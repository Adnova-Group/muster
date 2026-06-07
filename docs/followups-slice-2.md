# Slice 2 — deferred follow-ups

Non-blocking nits from the final review (2026-06-07, VERDICT: PASS). Hardening already applied before
merge: wave fail-loud on missing `plan`, `computeWaves` non-array/duplicate-id guards, deterministic
tie-break in `pickWinner`, orchestrator skill wording.

Deferred (nits, safe to address later):

- **`tallyReview` silently skips unknown severities.** A finding with `severity: "critical"` is
  ignored (only blocker/risk/nit counted). Reasonable default, but untested + undocumented — add a
  test asserting the skip, or normalize/reject unknown severities.
- **`src/cli.js` top-level catch loses the stack.** Friendly for user errors, but unexpected runtime
  bugs print only `e.message`. Consider printing the stack under `DEBUG`.
- **`src/memory.js` `exists()` bare catch.** Treats any stat error (incl. permission denied) as
  "absent". Low impact; could narrow to ENOENT.
- **Plan-doc wording.** Slice-2 plan "Shared shapes" lists `deps: string[]` without marking it
  optional, while design §5 allows omission. Align the wording.
