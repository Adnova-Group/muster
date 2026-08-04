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

- **Zero-reference export sweep** (the general, repeatable procedure): for every `export (const|
  function|class|async function) NAME` in `src/*.js`, `grep -rn "\bNAME\b"` across the WHOLE repo
  (`src/`, `plugin/`, `docs/`, `test/`, `catalog/*.yaml`, `scripts/`, generated runtimes) -- a
  count of exactly 1 (the declaration line) means dead. Do not stop at `src/*.js`: an id can be
  referenced only from a `catalog/*.yaml` string or a doc.
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
- Duplicated-lock/lifecycle reimplementation is the SAME class at a coarser grain -- see
  `audit-pattern-readability`'s `codex-install-lock-unification` citation for a worked example
  (a hand-rolled lock duplicating an existing shared primitive rather than importing it).

## Repo-specific conventions to enforce

- A deletion's contract-surface proof (0 invocations from plugin skills, generated runtimes, or
  docs -- NOT just `src/*.js`) is the bar every dead-code removal in this repo is held to; a
  finding that only checked `src/` is incomplete.
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

## Appended patterns

(none yet -- `muster-improver` may append dated, evidenced entries here from run receipts; see
`plugin/skills/improve/SKILL.md`.)

Report findings as a bullet list, one finding per line: severity (P0/P1/P2), location
(file:line), problem, suggested fix -- matching the audit dispatch's own return contract
(`plugin/commands/audit.md` step 3).
