# audit-pattern-batch2 — second improver batch on the audit-pattern-* skill family (2026-08-04)

The user approved a 24-entry proposal ledger (`plugin/skills/improve/SKILL.md`'s judgment,
research basis: the nine `audit-pattern-*/SKILL.md` files as they stood after today's first
appended-patterns cycle, 19 `docs/decisions/*.md` records, `.muster/STATE.md`, and live grep-yield
probes) for the second `## Appended patterns` cycle across the pattern-skill family, plus the
synthesis's recommendation to create a tenth pattern skill. This item implements exactly what was
approved: nothing more, nothing dropped without a documented reason.

## What was approved

- A 24-entry proposal ledger grouped by target skill (architecture 5, coverage 4, security 3,
  design-ux 2, prompt-quality 3, readability 3, tech-debt 2, simplification 1,
  dead-code-duplication 1), each already in the improve-step-4 append format.
- The synthesis's recommendation: create `audit-pattern-documentation` (a tenth pattern skill)
  composed onto `readability` (unconditional) and `design-ux` (conditional, information-
  architecture half) -- the same two-dimension precedent `audit-pattern-dead-code-duplication`
  already established for `tech-debt` + `simplification` -- and migrate 4 named entries into it
  (P1, P3 from prompt-quality; R1, R2 from readability).
- One user-approved caveat: trim the coverage flake-class entry's citation to the in-repo
  precedent only, dropping the "corroborating literature" clause citing Luo et al., FSE 2014 (the
  primary source was flagged as unrenderable in the research environment; keep the pattern
  content, drop the unverifiable secondary citation).

## The documentation-pillar composition rationale

The synthesis's own rationale (point 3): "the repo's docs are mostly truth-tracking artifacts
(19 decision records, STATE, research-with-quotes) whose one recurring failure mode is
drift/misreporting -- already half-guarded by deterministic tests (`docs-currency`,
`website-docs`, `docs-authority`, `corpus-contradiction`), so the skill's job is the judgment
residue those guards can't reach." `audit-pattern-documentation/SKILL.md`'s own "Where to dig"
charter restates this directly rather than re-deriving it, and names the concrete guard list
(`test/docs-currency.test.js`, `test/website-docs.test.js`, `test/docs-binding-interface.test.js`'s
grep-audit, `test/docs-public.test.js`, `test/corpus-contradiction.test.js`) so a future auditor
knows exactly what NOT to re-hunt.

Composing it into TWO existing dimensions rather than adding an eleventh crew role keeps the
audit protocol unredesigned, mirroring `audit-pattern-dead-code-duplication`'s precedent exactly:
`src/audit.js`'s `PATTERN_SKILL` map now binds `audit-pattern-documentation` onto both
`readability`'s and `design-ux`'s plan tasks.

## Placement calls

The assignment named 4 entries as definite migrations (citation-drift sweep + count-claim guard
coverage from prompt-quality; decision-record receipt audit + timeless-language sweep from
readability) and asked me to judge whether the Diátaxis quadrant-mixing entry (proposed under
design-ux) also migrates, "if the synthesis's IA-half framing reads that way."

**Call: yes, it migrates too (5 entries total, not 4).** The synthesis's point 2 explicitly names
the design-ux half of the new skill's composition as "conditional information-architecture half:
Diátaxis quadrant routing for README/website" -- that IS the Diátaxis quadrant-mixing entry's
exact subject matter, word for word. Leaving it behind in `audit-pattern-design-ux/SKILL.md`
while composing `audit-pattern-documentation` onto `design-ux` specifically FOR its IA half would
leave the new skill's own composition rationale contradicted by its own content. The remaining
design-ux entry (CLI failure-surface remediation check) stays in `audit-pattern-design-ux` --
its subject (actionable CLI error messages) has nothing to do with documentation truth-tracking.

Migrated (5, into `audit-pattern-documentation`): file:line citation-drift sweep, count-claim
guard coverage (both from prompt-quality); decision-record receipt audit, timeless-language sweep
(both from readability); Diátaxis quadrant-mixing test (from design-ux).

Stayed in place (19, verbatim-appended to their originally-proposed skill): architecture (5),
coverage (4, incl. the Luo-trimmed flake-class entry), security (3), design-ux (1, CLI
failure-surface remediation), prompt-quality (1, brief-only procedure persistence), readability
(1, nesting-weighted split ranking), tech-debt (2), simplification (1), dead-code-duplication (1).

## The Luo trim

Original ledger source clause: `Luo et al., "An Empirical Analysis of Flaky Tests", FSE 2014 --
per corroborating literature the top causes are Async Wait 45%, Concurrency 20%, Test Order
Dependency 12% (primary PDF not renderable in this environment; verify quote before appending) +
in-repo precedent PR #175 "deterministic changed-read injection replaced the timing race"`.

Per the user-approved caveat, the appended entry's source now reads: `in-repo precedent PR #175
"deterministic changed-read injection replaced the timing race" + the kimi-probe-flake-containment
pattern` -- the Luo/FSE/"corroborating literature" clause is dropped entirely; the pattern content
(classify by cause class, deterministic injection for async-wait, environment-gated skips for
quota/live-binary) is unchanged, since that guidance stands on the in-repo precedent alone.

## Two incidental prompt-lint fixes

Two of the newly appended/created entries introduced a new `GUARD-IDK-001` prompt-lint trigger
word (the rule fires on `answer|question|fact|factual` and requires a nearby "if unsure, say so"
qualifier once it fires): `audit-pattern-dead-code-duplication/SKILL.md`'s post-supersession-
orphan entry ends "...is filed as a 'has the retention decision expired?' **question**..."; and
`audit-pattern-documentation/SKILL.md`'s own "Where to dig" charter states each doc "asserts a
**fact** about the repo." Both files gained a one-line "say so" qualifier in their existing
"Repo-specific conventions to enforce" sections, matching the convention every other pattern
skill in this family already uses for the same rule (see `audit-pattern-architecture/SKILL.md`'s
existing "say so" line from the pattern-library-ripples item).

## Count ripple table

| Surface | Before | After | File(s) |
|---|---|---|---|
| `plugin/skills` directories | 21 | 22 | new `audit-pattern-documentation/` |
| `CODEX_COUNTS.nativeSkills` | 21 | 22 | `src/codex-inventory.js` |
| `CODEX_COUNTS.internalSkills` | 72 | 73 | `src/codex-inventory.js` |
| Total Codex skills (public + internal) | 86 | 87 | README.md, website/guides/codex.md, docs/research/codex-cli.md, docs/research/codex-desktop.md |
| `docs/binding-interface.md` prose-file scope | 42 | 43 | docs/binding-interface.md, test/docs-public.test.js:72-73 |
| `docs/binding-interface.md` hook row | files=11 mentions=29 | files=15 mentions=33 | 4 new entries each use "hook" as an ordinary word (architecture, coverage, security, documentation) |
| `docs/binding-interface.md` AskUserQuestion/dispatch/worktree rows | unchanged | unchanged | none of the 20 new/appended entries mention those terms |
| `eval/modes/README.md` skill-protocol coverage table | 21 | 22 | new `audit-pattern-documentation` structural row |
| `test/mode-evals.test.js` `STRUCTURAL_SKILLS` | 9 entries | 10 entries | `audit-pattern-documentation` added |
| `test/audit-pattern-skills.test.js` `NAMED_PILLARS` | 9 | 10 | `documentation` added |
| `test/claude-parity.test.js` claudeSurface file count | 159 | 160 | +1: `plugin/skills/audit-pattern-documentation/SKILL.md` |

All counts above are re-derived from the live tree by the tests/scripts named, not hand-typed
independently of them -- see the TESTS section of this item's return receipt for the exact
verbatim command output.
