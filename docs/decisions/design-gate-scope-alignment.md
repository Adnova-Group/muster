# design-gate-scope-alignment — align DESIGN.md's prose with the gate's resolved scope (2026-08-04)

Backlog item `design-gate-scope-alignment`, seeded from the 2026-08-04 design-ux audit (P2): DESIGN.md's
own text declared "This file is the canonical design context for Muster's public documentation
website... It governs `website/**`", but `design status .` / `design gate . --outcome "..."` resolved
`scopeRoot: <repo root>` with no restriction, and a qualifying human-facing outcome anywhere in the
repository passed the gate under a document that textually disclaimed authority there. Two honest
resolutions were possible: (a) narrow the machinery to match the prose, or (b) widen the prose to
match the machinery. This record picks **(b)** and states why, with the call-site evidence that
drove it.

## 1. What the machinery actually does and documents

`resolveDesignContext` (`src/design.js`) only narrows `scopeRoot` below `repoRoot` inside a
monorepo (`nearestPackageRoot`, gated on `package.json` workspaces / `pnpm-workspace.yaml` /
`turbo.json` / `nx.json` / `lerna.json`). Muster's own repo has none of those markers, so
`isMonorepo` is `false` and `scopeRoot` is unconditionally `repoRoot`. This is not an oversight —
`docs/design.md` documents it as the intended contract: "In a monorepo, a package-local file wins;
otherwise **the repository root file is inherited**." "Inherited" here means inherited by the whole
tree, not by `website/**` specifically; the code has no path-based scope carve-out for a non-monorepo
project at all.

## 2. Every call site treats the gate as whole-repository, not website-only

- `plugin/commands/go.md` step 3.5 runs `design gate . --outcome "$ARGUMENTS"` for **any** outcome
  matching a human-facing signal (`ui`, `ux`, `design`, `frontend`, `brand`, `visual`, `interface`,
  `responsive`, `accessibility`, typography, layout, animation, onboarding, landing page, or
  website) — the outcome can be anywhere in the repository, not just under `website/`.
- `plugin/commands/go-backlog.md` step 3 runs `design gate <item-worktree> --outcome "<item text>"`
  at the item's worktree root for any qualifying item, again regardless of which part of the tree the
  item touches.
- `plugin/commands/audit.md` step 5 and `src/audit.js`'s `design-ux` dimension are conditional on
  `detectAuditDesignEvidence`, which scans the **whole audited scope** (default whole repo, or
  `opts.paths` when the audit itself is scoped) for `DESIGN_NAMES` or `UI_EXTENSIONS` — a generic
  frontend-file sweep, not a `website/**` sweep. The dimension's own `focus` string is "UX/design
  quality, accessibility, hierarchy, responsive behavior, and consistency" with no website
  qualifier.
- `src/design.js`'s `qualifiesDesignOutcome` regex includes generic, non-website-specific terms
  (`interface`, `human-facing`, `accessibility`, `typograph`, `layout`, `animation`, `onboarding`) —
  vocabulary that squarely covers CLI/TUI output and other non-website human-facing surfaces.

None of these call sites pass a `website`-scoped target, filter by directory, or treat a
non-website human-facing outcome as exempt. Redesigning `resolveDesignContext` to narrow to
`website/**` for a non-monorepo project (option a) would change gate semantics at every one of
these call sites: `go`'s step 3.5 and `go-backlog`'s step 3 would need new logic to classify
non-website human-facing outcomes as "not required" or "explicitly out of scope" (a protocol
redesign these commands do not describe today), and the audit's `design-ux` dimension would need a
path filter it does not have. That is a much larger, riskier change than the prose already
warrants, and it would contradict `docs/design.md`'s documented "inherited repo-wide" contract for
non-monorepo projects.

## 3. The direction/voice principles already apply beyond the website

`plugin/output-styles/muster.md` (the CLI's TUI voice) is "terse, decision-first, evidence-backed"
and calls its own show-the-reasoning convention "glass box" — the same visual metaphor DESIGN.md's
Direction section names first: "Muster should feel like an inspectable technical instrument:
precise, calm, and open about how it works... The visual metaphor is a glass box." The CLI voice
was not derived from a separate design document; it already coheres with DESIGN.md's Direction
section despite that file's prose claiming website-only authority. That is evidence the file's
*intent* was always broader than its *stated* jurisdiction.

## 4. Decision: widen the prose (option b)

DESIGN.md's opening paragraph now states that it is Muster's canonical design context for the
repository's entire human-facing surface, names the design gate's actual non-monorepo resolution
behavior (root file inherited repo-wide, per `docs/design.md`) as the reason, and clarifies that
`website/**` remains the concrete *implementation* home for the color tokens, layout rules, and
site provenance documented later in the file — those sections describe the one shipped visual UI,
they do not narrow the file's governing scope. The CLI/TUI voice citation is included so a future
reader does not have to rediscover the coherence argument in section 3 above.

This preserves fail-closed behavior: a missing `DESIGN.md` anywhere still produces `HUMAN-HOLD`
(`designGate`'s `context.designPath` branch is untouched), and no call site's behavior changes —
the fix is entirely textual, so nothing downstream needed to change to stay correct.

## 5. Pin

`test/design-gate-scope-alignment.test.js` parses DESIGN.md's governs declaration (repo-wide
phrase vs. a narrower `` governs `dir/**` `` glob) and asserts it against the actual
`resolveDesignContext`/`designStatus`/`designGate` resolved `scopeRoot` for this repository. It
fails in either direction: if the prose reverts to a narrower claim while the gate still resolves
the repo root (the original bug), or if the gate is ever narrowed while the prose still claims
repo-wide authority (a future regression on option (a)'s side). Both directions were verified by
mutation during review (see the item's return receipts for the verbatim red output of each).
