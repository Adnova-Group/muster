---
name: audit
description: "Autopilot-style whole-codebase review-and-fix. Sweeps architecture, tech-debt, test-coverage, simplification/reuse/duplication, readability/maintainability, and security in parallel via the best available provider per dimension, consolidates a ranked findings ledger, then fixes everything (TDD) and verifies. Usage: /muster:audit [path or empty = whole repo]"
---

The scope: `$ARGUMENTS` (empty = whole repo; or a path/subsystem to scope the audit).

Drive the audit loop:

1. **Seed** — `npx -y @adnova-group/muster audit` -> Crew Manifest at `.muster/manifest.json`; validate (`npx -y @adnova-group/muster manifest validate`).
2. **Branch** — create a work branch off the base (never run on the base branch).
3. **Parallel dimension sweep** — dispatch the chosen provider per dimension CONCURRENTLY, each READ-ONLY, on its role's model (architecture-review on fable, etc.): architecture, tech-debt, coverage, simplification, readability, security. Each returns findings: severity (P0/P1/P2), location (file:line), problem, suggested fix.
4. **Consolidate** — dedupe + rank all findings into a single ledger (by severity, then blast radius). Record the ledger in STATE (glass box).
5. **Fix all** — via the orchestrator + Ralph loop: remediate every finding, TDD (failing test first where behavior changes). Defer an item only with an explicit written reason in the ledger. Keep the suite green per fix.
6. **Verify** — run the **review-gate** + the full suite; must be green. Confirm no regressions.
7. **Escalate** if the fix-loop cap is hit on an item (record it in the ledger, continue the others). Then present the merge decision via the **AskUserQuestion** selection UI with options **Merge locally** / **Open PR** / **Keep branch** / **Discard**.

Reuses the orchestrator + review-gate; glass box records the per-dimension providers + the findings ledger. (vs `/muster:diagnose`, which is failure-first single-bug; audit is breadth-first whole-codebase.)
