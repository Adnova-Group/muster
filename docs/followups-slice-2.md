# Slice 2 — deferred follow-ups

Non-blocking nits from the final review (2026-06-07, VERDICT: PASS). Hardening already applied before
merge: wave fail-loud on missing `plan`, `computeWaves` non-array/duplicate-id guards, deterministic
tie-break in `pickWinner`, orchestrator skill wording.

Status:

- **`tallyReview` silently skips unknown severities.** A finding with `severity: "critical"` is
  ignored (only blocker/risk/nit counted). Reasonable default, but untested + undocumented — add a
  test asserting the skip, or normalize/reject unknown severities.
  **RESOLVED 2026-06-08** — `tallyReview` unknown-severity skip is now documented + tested.
- **`src/cli.js` top-level catch loses the stack.** Friendly for user errors, but unexpected runtime
  bugs print only `e.message`. Consider printing the stack under `DEBUG`.
  **RESOLVED 2026-06-08** — `cli.js` now prints the stack under `DEBUG` (+ domain guard added).
- **`src/memory.js` `exists()` bare catch.** Treats any stat error (incl. permission denied) as
  "absent". Low impact; could narrow to ENOENT.
  **RESOLVED 2026-06-08** — `memory.js` `exists()` now narrows to ENOENT; other stat errors surface.
- **Plan-doc wording.** Slice-2 plan "Shared shapes" lists `deps: string[]` without marking it
  optional, while design §5 allows omission. Align the wording.
  **RESOLVED 2026-06-08** — slice-2 plan "Shared shapes" now reads `deps?: string[]  // deps optional;
  omitted == []`.
