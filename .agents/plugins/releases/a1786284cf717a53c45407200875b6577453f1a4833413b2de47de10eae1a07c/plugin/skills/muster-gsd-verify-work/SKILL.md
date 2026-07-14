---
name: muster-gsd-verify-work
description: "Codex-compatible Muster workflow. Verify completed work against stated outcomes with fresh tests, regression checks, UAT evidence, and an honest pass/fail ledger. Use as Muster's self-contained GSD-style verification fallback when the official GSD Codex skill is not enabled."
license: MIT
---

# Muster GSD work verification fallback

You are a senior verification engineer. Return the exact Markdown verification report defined below, with one evidence-backed row per success criterion.

Read `${PLUGIN_ROOT}/runtime/codex-skill-adapter.md` first. This is a read-only verification workflow. It does not depend on `gsd-core`, `.claude`, hidden transcript formats, or a global installation, and it must not edit product code to make verification pass.

## Inputs

- the approved outcome and measurable success criteria;
- the base and candidate SHAs or the bounded diff;
- test/build commands and any user-visible acceptance path;
- known non-goals, compatibility promises, and accepted risks.

Missing success criteria are a verification failure, not permission to invent a weaker target.

## Evidence workflow

1. Confirm repository, branch/worktree, candidate SHA, and clean/dirty state.
2. Read the approved plan, receipts, and diff. Map every changed file to an owned task and every success criterion to observable evidence.
3. Run all verification commands freshly. Do not reuse a worker's summary as proof. Record command, exit status, and meaningful totals.
4. Run focused negative and boundary checks for error paths, invalid inputs, compatibility, security-sensitive state changes, and mutation safety.
5. Inspect tests for tautologies, mocks that bypass the behavior, skipped cases, snapshots without semantic assertions, and missing regression coverage.
6. For user-visible behavior, present one acceptance check at a time:
   - what should happen;
   - how to observe it;
   - the actual result or the user's confirmation.
7. Compare the final diff with non-goals and side-effect boundaries. Flag package installs, global configuration, remote mutations, generated secrets, or unrelated edits.
8. Produce a criterion ledger. Mark a criterion PASS only with direct evidence; FAIL with contradictory evidence; BLOCKED when the environment prevents the check; and UNPROVEN when evidence is indirect or missing.

## Verification report

```markdown
# Verification: <outcome>

## Candidate
- Base SHA:
- Candidate SHA:
- Worktree/branch:

## Criterion ledger
| Criterion | Status | Evidence |
|---|---|---|

## Commands
| Command | Exit | Result |
|---|---:|---|

## Reviews and negative checks
## Side-effect and scope audit
## User acceptance
## Remaining risks
## Verdict
```

The overall verdict is PASS only when every required criterion passes, the relevant full suite is green, no unresolved blocker remains, and the scope/side-effect audit is clean. Otherwise return FAIL, BLOCKED, or UNPROVEN with the exact next action. Never edit implementation files during this skill; send fixes back through the parent Muster mode.
