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
- (2026-08-04, source: shakedown dead-weight feedback — mutant-kill-via-git-history flagged expensive; cross-ref readability's no-interpolation error sweep) Error-message-substring kill proxy (the cheap formalization): for each guard branch, take the distinguishing token of its thrown message and grep `test/` for that token; zero hits means no test can tell THIS branch fired versus a sibling — the one-grep proxy for an unkilled mutant, no git surgery. A guard whose message has NO distinguishing token cannot be proxied at all and is simultaneously the readability finding. — false-positive note: branches asserted structurally (error.code, a marker flag like `musterConcurrentConfig`) are killed without message matching; check structural assertions before filing.
- (2026-08-04, source: scoped-audit-shakedown coverage ledger P1 — marketplace plugin-cache concurrency defenses "unreachable by ALL mocked-execFile tests AND skipped in the real-runtime test") Mock-altitude unreachability: for every defense-in-depth branch, locate the suite's mock seam and check whether it sits ABOVE the defense — if every test mocks at a granularity that can never trigger the branch, and the real-runtime test skips it, the defense has zero reachable coverage regardless of suite size. Require one failure injection BELOW the seam or an unskipped real-runtime exercise. — false-positive note: defenses reachable through a documented injection hook (`afterValidation`-style seams) are covered; verify the hook is actually used by a test.
- (2026-08-04, source: test-tmpdir-convention merged receipt — guard hardened against 5 import-evasion forms, "residual nits: re-export laundering inherent to textual guards") Re-export laundering check: for every grep-based guard test asserting "no file imports/calls X", grep for `export { X as ` and `export * from` sites that launder X under a new name past the guard; the finding is the missing laundering-form mutant-kill, not the guard's existence. — false-positive note: guards that resolve re-export chains (or forbid re-export syntactically) already close this; confirm before filing.
- (2026-08-04, source: in-repo precedent PR #175 "deterministic changed-read injection replaced the timing race" + the kimi-probe-flake-containment pattern) Flake-class triage: classify every timing-sensitive/live-probe test by cause class (async wait, concurrency, order dependency, network/quota); async-wait flakes get deterministic injection (the #175 pattern), quota/live-binary flakes get environment-gated skips with attributed baselines (the kimi-probe-flake-containment pattern) — an unattributed intermittent failure in a gate run is itself the finding. — false-positive note: an environment-gated skip with a documented reason is containment, not flake debt.

(`muster-improver` may append further dated, evidenced entries here from run receipts, gated by
user approval; see `plugin/skills/improve/SKILL.md`.)

Report findings as a bullet list, one finding per line: severity (P0/P1/P2), location
(file:line), problem, suggested fix -- matching the audit dispatch's own return contract
(`plugin/commands/audit.md` step 3).
