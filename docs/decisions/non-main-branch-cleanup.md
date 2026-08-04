# non-main-branch-cleanup — ref, worktree, and run-marker disposition (2026-08-04)

Run `go-backlog-2026-08-03-95b3bf9`, executed at the run's terminal cleanup phase after all 34
sibling items reached signed implementation + review + integration receipts and were merged into
local `main` (95b3bf9 → 32eba67, 26 merge commits + contained no-ops + 2 composition fixes).

## Local branches (37 inventoried)

| Disposition | Refs | Rationale |
|---|---|---|
| PRESERVE | `main` | release branch |
| DELETE after this item's own integration | 35 × `muster/<item>-20260803` (incl. this branch once merged) | all 34 sibling item tips are ancestors of `main` (`git branch --no-merged main` lists only the abandoned benchmark branch and this candidate, which merges on landing); work landed via receipted merges recorded in `.muster/backlog.md` `{merge:}`/`{done:}` annotations. Note on `{done:}` dual use: 8 items carry `{done: 95b3bf9…}` as audited satisfied-at-base proof points, while `unify-codex-process-wave-contract` carries `{done: be1278d…}` because its reviewed tip is contained linearly under `finish-wave-dispatch-split`'s merged branch — both are reachability-verified; the annotation key is shared deliberately since the CI scanner's grammar defines only `{merge:}`/`{done:}` |
| DELETE (abandoned attempt) | `muster/bind-fix-loop-benchmark-freshness-20260803` @ 0564b23 | partial benchmark attempt verified abandoned 2026-08-03 (no live process, no receipt, `complete:false` evidence); the backlog item itself stays OPEN and unchecked for a fresh future run — stale partial evidence must not seed a freshness-focused benchmark |

## Linked worktrees (37 inventoried, excluding the main checkout)

`git worktree list --porcelain` enumerates 38 entries: the main checkout at `/home/ryan/dev/muster`
(preserved), 36 item worktrees under `/tmp/muster-go-backlog-20260803/*`, and the driver worktree.
All 36 item worktrees plus the driver worktree
`/tmp/muster-go-backlog-driver-V7MJHi`: REMOVE after this item integrates. Run records
(STATE.md, sprint-progress.json with all signed receipts, broker state, public verification keys)
are archived to `.muster/runs/go-backlog-2026-08-03-95b3bf9/` in the main checkout before driver
removal; broker PRIVATE keys are destroyed at close so no post-run receipt can be forged.

## Remote refs (read-only inventory; no remote mutation this run)

`git ls-remote --heads origin` returns 5 heads: `main`, `gh-pages`, and 3 item heads that back
currently OPEN pull requests — #195 (`muster/exercise-desktop-init-surfaces-20260803`),
#196 (`muster/improve-runner-prompt-examples-20260803`), and
#197 (`muster/harden-kimi-action-fence-publication-20260803`), all opened 2026-08-03 by the prior
driver session and OUTSIDE `docs/decisions/open-pr-branch-reconciliation.json`'s scope (that
artifact covers the earlier PR 145-185 batch). Disposition, owner: the run driver. Each PR's
branch content is already an ancestor of local `main` via this run's receipted merges
(`5d57f37`, `7241a37`, `b571fb5`), so all three are stale-but-open: RECOMMENDED
close-with-rationale ("superseded by locally receipted merge; content identical") plus remote
head deletion, to execute together with the eventual push — both actions require remote-mutation
authority this run does not hold. Local `main` has NOT been pushed. No open PR is left unowned:
all three carry this recorded disposition and owner.

## Backlog truth

This commit checks off the 34 completed items in the canonical tracked `.muster/backlog.md`,
binding each to its reachable `{merge:}` commit (or `{done:}` proof point for verified
no-change completions — 8 audited satisfied-at-base on 2026-08-04, plus `unify` contained via its
dependent's merge). Stale `{claimed:}` annotations removed. `bind-fix-loop-benchmark-freshness`
and this item remain unchecked here; this item is checked off on `main` immediately after its own
integration, when its merge SHA exists.

Verification: `scripts/check-backlog-receipts.mjs --release-ref <this branch>` → `ok: true`
(re-run post-commit; the scanner reads the canonical file from the checked commit).
