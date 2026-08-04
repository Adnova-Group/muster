---
name: audit-pattern-coverage
description: Hunt-list pattern skill for muster's coverage audit dimension -- untested exported behavior, missing TDD/mutant-kill evidence, and gap classes in muster's own repo. Loaded by the audit orchestrator as a REQUIRED SKILLS binding on the test-author dimension task; read on demand, never dispatched standalone.
---

<!-- prompt-lint-disable ANTH-ROLE-001: reference hunt-list loaded ON DEMAND into an already
role-anchored test-author dispatch; a second "You are..." opener here would duplicate the persona. -->

# Audit pattern: coverage

**Version:** 1

Hunt-list for the **coverage** audit dimension (`buildAuditManifest`, `src/audit.js`, role
`test-author`).

## Where to dig

- Untested-export sweep: for every `export (function|async function|const) NAME` in `src/*.js`,
  check whether ANY file under `test/` imports `NAME` from that module (`grep -rln "NAME" test/`
  after resolving the import path). An export with zero test imports is either dead (see
  `audit-pattern-tech-debt`) or genuinely uncovered -- decide which before filing the finding.
- Branch/edge coverage, not just call coverage: a function with a test that calls it once but
  never exercises its error path (a `catch`, a `fail()`/`throw`, an early return) is a coverage
  gap even though it technically "has a test". Grep the function body for `catch`/`throw`/early
  `return` and check the test file for a matching negative-path assertion.
- Mutant-kill evidence: `docs/decisions` and PR history reference a "mutant-kill" convention for
  new guards -- a new test or eval guard should demonstrate a KILL (mutate the guarded artifact,
  show the guard fails, restore) not just a happy-path pass. A guard test with no accompanying
  kill evidence in its own commit history/PR body is a coverage-QUALITY finding, not just a
  coverage-COUNT one.
- Focused-vs-broad test discipline: `test/*.test.js` files should exercise ONE subsystem; a test
  file that has grown past ~500 lines covering multiple unrelated concerns is itself a coverage
  organization smell (see the `split-codex-test-monolith` precedent, backlog item, which split
  `test/codex.test.js` for exactly this reason).

## Repo-specific conventions to enforce

- TDD-first: `review-gate`'s mutant-kill rule and the orchestrator's TDD convention both expect
  the FAILING test to exist before the implementation. A finding here is strongest when it names
  the missing test AND states what failing-first assertion it would need.
- `test-support/helpers.js` is the shared fixture/harness surface (`trackedMkdtempSync`,
  `bareCapabilities()`, etc.) -- new coverage should reuse it, not hand-roll a parallel fixture.

## Known false positives to rule out

- Prose/prompt files (`plugin/agents/*.md`, `plugin/commands/*.md`, `plugin/skills/*/SKILL.md`)
  are NOT "uncovered code" in the traditional sense -- their correctness is checked by
  `prompt-lint`, `corpus-contradiction`, and doctor's `skill-doc-refs`, not by `node --test`
  import coverage. Route a prose-correctness finding to `audit-pattern-prompt-quality` instead.
- A read-only/investigator-style module (e.g. `src/plugin-inventory.js`'s pure helpers) that is
  exercised indirectly through an integration test (`test/integration.*.test.js`) rather than a
  unit test importing it directly is still covered -- check integration suites before flagging.

## Appended patterns

- (2026-08-04, source: scoped-audit-shakedown coverage ledger) A split module reusing a sibling's "concurrent state was preserved" defense-in-depth pattern but lacking that sibling's test-only interceptor seam (e.g. scope-lock's `afterValidation`) is a coverage red flag by construction — check whether the facade exposes an equivalent injection point before concluding indirect integration coverage is adequate. — false-positive note: indirect coverage IS adequate when an injection point exists and race branches are exercised through it.
- (2026-08-04, source: scoped-audit-shakedown coverage ledger) For any regex-based structural/line-count ratchet in test/, inspect its character classes and single-line anchoring for declaration forms it silently fails to match (multi-line arrow signatures, default/destructured params, let/var bindings, class declarations, generators) — an unmatched declaration does not fail the ratchet, it becomes invisible to it. Prove blind spots with a negative-control mutant. — false-positive note: convention-based ratchets are acceptable when the codebase provably follows the convention; the finding is the absent negative-control, not the regex itself.

(none yet -- `muster-improver` may append dated, evidenced entries here from run receipts; see
`plugin/skills/improve/SKILL.md`.)

Report findings as a bullet list, one finding per line: severity (P0/P1/P2), location
(file:line), problem, suggested fix -- matching the audit dispatch's own return contract
(`plugin/commands/audit.md` step 3).
