# non-main-branch-cleanup — ref, worktree, and run-marker disposition (2026-08-04)

Run `go-backlog-2026-08-03-95b3bf9`, executed at the run's terminal cleanup phase after all 34
sibling items reached signed implementation + review + integration receipts and were merged into
local `main` (95b3bf9 → 32eba67, 26 merge commits + contained no-ops + 2 composition fixes).

## Local branches (37 inventoried)

| Disposition | Refs | Rationale |
|---|---|---|
| PRESERVE | `main` | release branch |
| DELETE after this item's own integration | 35 × `muster/<item>-20260803` (incl. this branch once merged) | every tip is an ancestor of `main` (`git branch --merged main` = 35/35); work landed via receipted merges recorded in `.muster/backlog.md` `{merge:}`/`{done:}` annotations |
| DELETE (abandoned attempt) | `muster/bind-fix-loop-benchmark-freshness-20260803` @ 0564b23 | partial benchmark attempt verified abandoned 2026-08-03 (no live process, no receipt, `complete:false` evidence); the backlog item itself stays OPEN and unchecked for a fresh future run — stale partial evidence must not seed a freshness-focused benchmark |

## Linked worktrees (28 inventoried)

All `/tmp/muster-go-backlog-20260803/*` item worktrees plus the driver worktree
`/tmp/muster-go-backlog-driver-V7MJHi`: REMOVE after this item integrates. Run records
(STATE.md, sprint-progress.json with all signed receipts, broker state, public verification keys)
are archived to `.muster/runs/go-backlog-2026-08-03-95b3bf9/` in the main checkout before driver
removal; broker PRIVATE keys are destroyed at close so no post-run receipt can be forged.

## Remote refs (read-only inventory; no remote mutation this run)

`git ls-remote --heads origin` returns 5 heads. Local `main` has NOT been pushed (12+ commits
ahead at cleanup time; push remains a separately gated decision). Remote non-main heads map to
closed/merged PRs already dispositioned in `docs/decisions/open-pr-branch-reconciliation.json`;
their deletion requires push authority and is RECOMMENDED-ONLY here, to execute together with the
eventual push.

## Backlog truth

This commit checks off the 34 completed items in the canonical tracked `.muster/backlog.md`,
binding each to its reachable `{merge:}` commit (or `{done:}` proof point for verified
no-change completions — 8 audited satisfied-at-base on 2026-08-04, plus `unify` contained via its
dependent's merge). Stale `{claimed:}` annotations removed. `bind-fix-loop-benchmark-freshness`
and this item remain unchecked here; this item is checked off on `main` immediately after its own
integration, when its merge SHA exists.

Verification: `scripts/check-backlog-receipts.mjs --release-ref <this branch>` → `ok: true`
(re-run post-commit; the scanner reads the canonical file from the checked commit).
