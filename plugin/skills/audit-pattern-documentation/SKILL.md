---
name: audit-pattern-documentation
description: Hunt-list pattern skill for the documentation pillar -- decision-record receipt drift, citation drift, count-claim guard coverage, timeless language, and Diátaxis quadrant-mixing in muster's own repo. Loaded by the audit orchestrator as a REQUIRED SKILLS binding on BOTH the readability (unconditional) and design-ux (conditional, information-architecture half) dimension tasks; read on demand, never dispatched standalone.
---

<!-- prompt-lint-disable ANTH-ROLE-001: reference hunt-list loaded ON DEMAND into an already
role-anchored dispatch (readability or design-ux); a second "You are..." opener here would
duplicate the persona. -->

# Audit pattern: documentation

**Version:** 1

Hunt-list for the **documentation** pillar -- a tenth pattern skill approved via the second
improver batch (docs/decisions/audit-pattern-batch2.md), NOT a separate dispatched audit
dimension (adding a crew role would redesign the audit protocol, out of scope) -- it composes
with TWO existing dimensions: `readability` (code-review persona, UNCONDITIONAL home --
decision-record receipt audits, citation drift, count claims, timeless language) and
`design-ux` (frontend persona, CONDITIONAL on real UI/design evidence -- the
information-architecture half: Diátaxis quadrant routing for README/website). See
`src/audit.js`'s `PATTERN_SKILL` map, which binds this skill id to both dimension tasks -- the
same two-dimension composition precedent `audit-pattern-dead-code-duplication` already
established for `tech-debt` + `simplification`.

## Where to dig

Muster's own docs (README, website/, docs/, `.muster/STATE.md`, `docs/decisions/*.md` -- 19+
records as of this writing) are truth-tracking artifacts, not free prose: each one asserts a
fact about the repo (a count, a citation, a decision) that can drift out of sync with the code
it describes. Roughly half of that drift is ALREADY covered by deterministic guards
(`test/docs-currency.test.js`, `test/website-docs.test.js`, `test/docs-binding-interface.test.js`'s
grep-audit, `test/docs-public.test.js`, `test/corpus-contradiction.test.js`) -- this skill's job
is the JUDGMENT RESIDUE those guards can't reach: a citation whose line number silently drifted,
a decision record's self-reported count that was never cross-checked, a hedge word ("currently",
"as of this writing") outside its documented exemption, and user-facing content filed in the
wrong Diátaxis quadrant. Read the migrated entries below before auditing; do not duplicate a
check a deterministic guard already owns.

## Repo-specific conventions to enforce

- The deterministic-guard list above is fixed and known; do not re-propose a check one of them
  already performs -- extend the guard instead of hand-auditing what it already covers.
- Every finding cites the exact drifted claim (file:line, or `docs/decisions/<name>.md`) and the
  current true value, not just the discrepancy's existence. When re-deriving a count or a cited
  fact is genuinely infeasible in scope, say so rather than asserting an unverified number.

## Known false positives to rule out

- A `docs/decisions/*.md` record's own explicitly-dated, self-labeled historical baseline (e.g.
  "still open as of this writing", a superseded count marked as such in the same document) is
  honest history, not drift.
- Content already covered by one of the deterministic guards above that is merely UNTESTED for a
  specific new case is a coverage gap for that guard, not a hand-audited documentation finding --
  route it to `audit-pattern-coverage` instead.

## Appended patterns

- (2026-08-04, source: split-codex-install merged receipt nit "stale doc line-number citations in docs/research need a sync follow-up" + live probe: 66 `src/<file>.js:NN` citations across docs/ and plugin/skills prose; `src/citation-guard.js` checks only `[src:]` anchor resolution, never line drift) file:line citation-drift sweep: extract every `src/[a-z0-9-]+\.js:\d+` citation from prose and verify the cited line still contains the named symbol; recommend symbol-anchored citations (function name + file) over raw line numbers in the fix. — false-positive note: dated decision records quoting a historical commit's line numbers are archival truth — only flag citations that present themselves as describing CURRENT code.
- (2026-08-04, source: go-backlog-2026-08-03 improver signal — 3 count-accuracy incidents in one run (false 46/46, false 13/12, unverifiable "20 commits") + live probe: 8 hardcoded inventory counts in prose; docs-currency.test.js guards README/architecture/website but not plugin/ prose) Count-claim guard coverage: every prose numeric inventory ("26 roles", "23 workflows", "13 mode skills") must be generated from source or covered by a currency guard; an unguarded hand-typed count is pre-drift. — false-positive note: counts inside dated decision records describing a past state are records, not claims about the present.
- (2026-08-04, source: go-backlog-2026-08-03 wave-3/4 receipts — "2/5 decision records misreported their own test counts — reviewers caught both"; hook-trust's "20 commits" was the worker's own `tail -20` artifact) Decision-record receipt audit: for every docs/decisions record quoting test/commit counts, (a) check internal consistency (the same count quoted twice must match; pass ≤ tests), (b) where the quoted command is cheap, re-run it and compare; a count that traces to the author's own truncated tool output is the worst class. — false-positive note: counts explicitly marked as superseded baselines inside the same document are honest history.
- (2026-08-04, source: Google developer documentation style guide, quoted verbatim: "Words like now, new, and currently can render such documentation inaccurate, outdated, or unmeaningful" — https://developers.google.com/style/timeless-documentation + live probe: 10 hits in user-facing docs, e.g. website/guides/kimi.md:39 "currently report-only on every platform") Timeless-language sweep: grep README/website/docs for `currently|as of this writing|soon|latest`; rewrite as state plus condition ("is report-only until a trusted broker exists"). — false-positive note: the style guide's own exception covers "time-sensitive contexts" — decision records, CHANGELOG, and the pattern skills' deliberate "still open as of this writing" re-verify markers are exempt.
- (2026-08-04, source: Diátaxis, quoted verbatim: "crossing or blurring the boundaries described in the map is at the heart of a vast number of problems in documentation" — https://diataxis.fr/ + shakedown P2 "README quickstart buries reference content") Quadrant-mixing test: apply the Diátaxis compass (informs action vs cognition × acquisition vs application of skill) to README.md and website/guides vs website/reference — reference tables inside a quickstart, or tutorial steps inside reference pages, are misfiled content; the fix is a MOVE plus a link, never a rewrite in place. — false-positive note: a deliberate single-page overview that links out per quadrant is compliant; judge whether the content lives there or merely points there.

Report findings as a bullet list, one finding per line: severity (P0/P1/P2), location
(file:line), problem, suggested fix -- matching the audit dispatch's own return contract
(`plugin/commands/audit.md` step 3).
