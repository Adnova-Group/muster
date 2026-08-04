---
name: audit-pattern-dead-code-duplication
description: Hunt-list pattern skill for the dead-code/duplication pillar -- zero-reference exports, orphaned modules, and repeated helper shapes in muster's own repo. Loaded by the audit orchestrator as a REQUIRED SKILLS binding on BOTH the tech-debt and simplification dimension tasks (this pillar composes with two existing dimensions rather than adding a third); read on demand, never dispatched standalone.
---

<!-- prompt-lint-disable ANTH-ROLE-001: reference hunt-list loaded ON DEMAND into an already
role-anchored dispatch (tech-debt or simplification); a second "You are..." opener here would
duplicate the persona. -->

# Audit pattern: dead-code/duplication

**Version:** 1

Hunt-list for the **dead-code/duplication** pillar named explicitly in the
`audit-pillar-pattern-library` item. It is NOT a separate dispatched audit dimension (adding a
9th crew role would redesign the audit protocol, out of scope for that item) -- it composes with
the two EXISTING dimensions whose `focus` text already names its two halves: `tech-debt` ("dead
code") and `simplification` ("duplication"). See `src/audit.js`'s `PATTERN_SKILL` map, which binds
this skill id to both dimension tasks.

**Seeded verbatim from the 2026-08-04 dead-code/duplication survey** (backlog items
`cleanup-dead-exports` and `dedupe-crypto-helpers`) -- this is one of the 2 proven 2026-08-04
survey briefs seeded as a skill (the other is `audit-pattern-readability`).

## Where to dig

- **Three-bucket unused-export procedure** (the general, repeatable procedure -- supersedes a
  bare "grep once, count hits" sweep): for every `export (const|function|class|async function)
  NAME` in `src/*.js`, grep every IMPORTER across the full surface an export can legitimately be
  called from -- `src/`, `scripts/`, `mcp/`, `cowork/`, `bin/`, `eval/`, and `test/` -- and sort
  the result into exactly one bucket:
  - **(A) imported nowhere** -- genuinely dead. Delete-eligible once the contract-surface check
    below also clears it.
  - **(B) imported ONLY by its own test file** -- a "test-only zombie": the export exists solely
    to satisfy its own unit test, with zero production caller. This is the EXPENSIVE kind (the
    test suite hides it, so a naive "does it have a test" sanity check falsely reads it as
    covered/live) -- report bucket B exhaustively, not just bucket A.
  - **(C) imported by a real production/tooling caller** -- live, not a finding.
  Buckets A and B are this pillar's highest-value output; a sweep that only reports bucket A
  undercounts by missing every test-only zombie.
- **Verified 2026-08-04 finding, quoted verbatim from backlog item `cleanup-dead-exports`** (still
  open as of this writing -- re-verify each name is still zero-reference before citing as
  current): "the 5 zero-reference exports (`CODEX_MARKETPLACE`, `codexInvocationConfigDirs`,
  `assertRegularFile`, `parseCodexTurnUsage`, `DESKTOP_HARNESS_SURFACES`), `src/brief-lint.js`,
  the 4-function kimi-dispatch interpretation cluster, and codex-fix-loop's orphaned binding
  functions". That item's own success criterion is the contract-surface bar to hold a deletion to:
  "100% of deletions pass a contract-surface check proving 0 invocations from plugin skills,
  generated runtimes, or docs."
- **Verified 2026-08-04 finding, quoted verbatim from backlog item `dedupe-crypto-helpers`** (still
  open as of this writing -- re-verify counts before citing as current): "the 8 independent sha256
  one-liner helpers and the 12+ `/^[0-9a-f]{64}$/` regex declarations each collapse to exactly 1
  shared export with every prior site importing it; 0 behavior changes proven by the existing
  suites." Grep shape: `grep -rn "createHash(\"sha256\")" src/*.js` for the helpers,
  `grep -rln '\[0-9a-f\]{64}'` for the regex literal.
- **Missing duplication grep shapes** (beyond the crypto pair above -- same-shaped small helpers
  born independently on parallel branches, the recurring PATTERN, not a one-time list): grep each
  of these shapes across `src/*.js` and flag any that recur in 2+ files without a shared import --
  `execFileSync("git"` (ad hoc git-spawn wrappers), `mkdtemp` (raw temp-dir creation outside
  `fs-safe.js`/`test-support/helpers.js`), `readNoFollow`-shaped manual no-follow-read reimplementations,
  `timingSafeEqual` (hand-rolled constant-time comparisons), JSON-line/NDJSON parsers (a
  `split("\n").map(JSON.parse)`-shaped block), and `AbortController`/retry-with-backoff shapes.
  Also grep for **duplicated numeric limits or regex constants declared under different local
  names** (e.g. two files each defining their own `MAX_.*_BYTES`/`MAX_.*_MS` constant at the same
  value, or the same validation regex re-typed instead of imported) -- same class as the crypto
  pair, just harder to `grep` for verbatim since the literal differs by name; compare VALUES, not
  just identifiers.
- Duplicated-lock/lifecycle reimplementation is the SAME class at a coarser grain -- see
  `audit-pattern-readability`'s `codex-install-lock-unification` citation for a worked example
  (a hand-rolled lock duplicating an existing shared primitive rather than importing it).

## Repo-specific conventions to enforce

- A deletion's contract-surface proof (0 invocations from plugin skills, generated runtimes, or
  docs -- NOT just `src/*.js`) is the bar every dead-code removal in this repo is held to; a
  finding that only checked `src/` is incomplete.
- **Mandatory contract-surface check before ANY deletion**: never propose or perform a bucket-A/B
  deletion straight off one grep pass. Independently re-verify with a SECOND tool/method (see the
  false positives below) before it enters the ledger as delete-eligible. When a retention
  decision's expiry is genuinely ambiguous (see the post-supersession entry below), say so in the
  finding instead of guessing.
- A shared-export consolidation collapses ALL prior sites to import ONE export, not just the
  majority -- a partial consolidation that leaves even one site with its own copy re-creates the
  drift risk the fix was for.

## Known false positives to rule out

- A role/skill id referenced ONLY as a bare string inside `catalog/*.yaml` (never imported as a
  JS symbol) is a REAL reference, not dead code -- the catalog is data resolved at runtime.
- `plugin/builtins/wsh-*`/`sp-*`/`gsd-*` vendored content is intentionally NOT deduplicated
  against muster-authored code (different provenance/license, tracked in `vendor/manifest.yaml`)
  -- a similar-looking helper inside a vendored skill is not a duplication finding against
  muster's own `src/*.js` helpers.
- Two functions with an identical SHAPE but different SEMANTIC contracts (see
  `audit-pattern-simplification`'s `isContainedLexical` vs. `resolveContainedRealpath` example)
  are not duplicates.
- **Dated 2026-08-04, all discovered live during this pillar's own seed run** (each is a reason
  bucket-A/B evidence from a single pass is never trustworthy on its own -- see the mandatory
  contract-surface check above):
  1. **The environment's default `grep` may resolve to `ugrep`, which SILENTLY SKIPS
     binary-sniffed files.** `test/codex-release.test.js`'s control-byte literals made that file
     read as binary to `ugrep`, hiding a live consumer of what looked like a dead export from a
     plain grep sweep. Always use `rg` (ripgrep, text-mode by default) or `grep -a` (force
     text) for a contract-surface check; a hit-count of 0 from an unverified `grep` alias is not
     proof of zero-reference.
  2. **A live consumer can sit outside the expected test-file glob.**
     `test/prompt-scan-brief-lint.test.js` imported `src/brief-lint.js` -- a module elsewhere
     flagged "orphaned" because the sweep only checked the file's OWN same-named test file
     (`test/brief-lint.test.js`), not the full `test/` directory. Always grep the WHOLE `test/`
     tree, never assume a 1:1 file-to-test-file naming convention.
  3. **Prose-wiring contract tests can bind exact identifiers into plugin docs, making a
     textually-uncalled function load-bearing anyway.** The kimi-dispatch
     `interpretKimiGoalExit`-style interpretation cluster is never called from `src/*.js`
     directly, but a corpus/contract test asserts the exact identifier is quoted verbatim in a
     `plugin/` doc -- deleting the function would silently break that doc-fidelity contract even
     though no JS import ever breaks. Grep `test/*.test.js` for the candidate name as a
     STRING literal (inside a doc-quoting assertion), not only as an import, before deleting.

## Appended patterns

- (2026-08-04, source: docs/decisions/codex-fix-loop-reconcile.md — PR 152's binding-object layer was superseded by the receipt layer INSIDE its own branch before merge, leaving `createCodexFixLoopBinding`/`planCodexFixContinuation`/`fingerprintCodexRoleProfile` "orphaned relative to any live entry point" with only their own tests as consumers) Post-supersession orphan sweep: after any documented in-branch supersession, grep the superseded layer's exports for bucket-B status (imported only by their own tests) — supersession-born zombies are the highest-confidence bucket-B class because a decision record already names them non-live; the contract-surface check still applies before deletion. — false-positive note: a superseded layer explicitly retained as design documentation (the reconcile record says retention was a deliberate, separately-scoped call) is filed as a "has the retention decision expired?" question, never a direct delete order.

(none yet -- `muster-improver` may append dated, evidenced entries here from run receipts; see
`plugin/skills/improve/SKILL.md`.)

Report findings as a bullet list, one finding per line: severity (P0/P1/P2), location
(file:line), problem, suggested fix -- matching the audit dispatch's own return contract
(`plugin/commands/audit.md` step 3).
