---
name: audit-pattern-simplification
description: Hunt-list pattern skill for muster's simplification audit dimension -- reuse opportunities and missed abstraction in muster's own repo. Loaded by the audit orchestrator as a REQUIRED SKILLS binding on the refactor dimension task; read on demand, never dispatched standalone.
---

<!-- prompt-lint-disable ANTH-ROLE-001: reference hunt-list loaded ON DEMAND into an already
role-anchored refactor dispatch; a second "You are..." opener here would duplicate the persona. -->

# Audit pattern: simplification

**Version:** 1

Hunt-list for the **simplification** audit dimension (`buildAuditManifest`, `src/audit.js`, role
`refactor`). Covers reuse/simplification; its duplication half overlaps with
`audit-pattern-dead-code-duplication` (composed together on this same dimension -- see
`src/audit.js`'s `PATTERN_SKILL` map).

## Where to dig

- **Repeated-shape sweep** (the general procedure): a short function body (a one-liner hash, a
  regex literal, a validation check) appearing near-identically in 3+ files is a simplification
  candidate even when each copy is individually trivial -- the cost is drift risk, not per-copy
  complexity.
- **Verified 2026-08-04 survey finding** (still open as of this writing -- treat as a worked
  example, re-verify before citing as current): 8 independent `createHash("sha256")...digest`
  one-liner helpers and 12+ `/^[0-9a-f]{64}$/`-shaped regex declarations across `src/*.js`, each
  collapsible to exactly 1 shared export. See backlog item `dedupe-crypto-helpers` for exact
  scope. Cross-reference with `audit-pattern-dead-code-duplication` -- this same finding is
  seeded there too (the pillar covers both halves).
- Extraction precedent: the `dedup-cluster` backlog item already consolidated a prior wave of
  duplication (`bareCapabilities()` in `test-support`, `escapeRe` into `src/prompt-lint.js`, a
  shared stopword/tokenize helper between `src/match.js`/`src/interview.js`, hoisted `match.js`
  scoring constants, a shared `sliceMdSection` test helper) -- grep for the SAME shape of
  duplication (hand-typed sentinel constants, a helper reimplemented per-file) recurring since.
- Missed-abstraction signal: two modules independently walking a directory tree with nearly
  identical guard logic (symlink rejection, containment checks) instead of sharing
  `src/fs-safe.js`'s primitives is a simplification finding as much as a security one -- file it
  once, cross-reference the other dimension rather than duplicating the finding.

## Repo-specific conventions to enforce

- A shared helper's home is the LOWEST common module both call sites can import without a
  circular dependency -- `src/fs-safe.js` for file-safety primitives, `test-support/helpers.js`
  for test fixtures, `src/roles.js` for the role vocabulary. Don't propose a new top-level module
  for something that already has a natural home.
- `vendor/manifest.yaml`-sourced content (`plugin/builtins/wsh-*`/`sp-*`/`gsd-*`) is excluded
  from cross-file dedup against muster-authored code -- different provenance and license, kept
  deliberately separate (see `audit-pattern-tech-debt`'s false-positive note, same reasoning).

## Known false positives to rule out

- `catalog/*.yaml` role fallback chains list the SAME role served by multiple providers at
  different ranks -- that is intentional redundancy for capability resolution, not duplicated
  logic to simplify away.
- Two functions with similar SHAPE but different SEMANTICS (e.g. `isContainedLexical` vs.
  `resolveContainedRealpath` in `src/fs-safe.js` -- one is a pure string check, the other does a
  real filesystem resolution) are not duplication; verify the contracts differ before flagging.

## Appended patterns

(none yet -- `muster-improver` may append dated, evidenced entries here from run receipts; see
`plugin/skills/improve/SKILL.md`.)

Report findings as a bullet list, one finding per line: severity (P0/P1/P2), location
(file:line), problem, suggested fix -- matching the audit dispatch's own return contract
(`plugin/commands/audit.md` step 3).
