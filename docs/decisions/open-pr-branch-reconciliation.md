# Final PR branch reconciliation

This is the final current-state reconciliation for PRs 145–152, 166–176, and 185, observed from GitHub at `2026-08-03T17:42:51.000Z` against base commit `95b3bf9c2d6c8ffc75469b01b4b0c1ee94679be1`. The machine-readable authority is [open-pr-branch-reconciliation.json](open-pr-branch-reconciliation.json).

All 20 entries now have one final disposition: 10 merged, 10 closed, 0 current, and 0 awaiting disposition. The reconciliation was read-only and made no GitHub mutation. A pull request is classified as merged only when GitHub reports a non-null `merged_at`; otherwise a closed pull request is classified as closed, even if the REST response carries a synthetic `merge_commit_sha`.

| PR | Disposition | GitHub evidence |
|---:|---|---|
| 145 | closed | Closed 2026-08-03 01:32:20Z; `merged_at` null |
| 146 | closed | Closed 2026-08-03 01:32:18Z; `merged_at` null |
| 147 | closed | Closed 2026-08-03 01:32:16Z; `merged_at` null |
| 148 | closed | Closed 2026-08-03 01:32:14Z; `merged_at` null |
| 149 | closed | Closed 2026-08-03 01:32:12Z; `merged_at` null |
| 150 | closed | Closed 2026-08-03 01:32:11Z; `merged_at` null |
| 151 | closed | Closed 2026-08-03 01:32:09Z; `merged_at` null |
| 152 | closed | Closed 2026-08-03 01:32:07Z; `merged_at` null |
| 166 | closed | Closed 2026-08-03 01:32:05Z; `merged_at` null |
| 167 | merged | Merged 2026-08-03 01:31:50Z at `df18f5232ca773c4c85a96100b39e3d59b09e4f5` |
| 168 | merged | Merged 2026-08-03 01:31:50Z at `01a82dd131f67bb3c8fcbc5a1e6c9299ca8492fa` |
| 169 | merged | Merged 2026-08-03 01:31:50Z at `9c6eeab778818167a0f5bffd6ae6ff9cea15226c` |
| 170 | merged | Merged 2026-08-03 01:31:50Z at `a8376b0c69a97fe36fc7f93a3d475aefaf64eebd` |
| 171 | merged | Merged 2026-08-03 01:31:50Z at `ddea8ce88164d0e2ae4f75bb6c4aab55c198de63` |
| 172 | merged | Merged 2026-08-03 01:31:50Z at `75a7c44463c6310c6b9c3ab2fe9c0b1729d5e158` |
| 173 | merged | Merged 2026-08-03 01:31:50Z at `75232fcf6a93d81cec2eb6dc5b13753a2af6ca42` |
| 174 | merged | Merged 2026-08-03 01:31:50Z at `f8a3e62c88ae91c0db75e90448d6e42de6ccb94e` |
| 175 | merged | Merged 2026-08-03 01:31:49Z at `a92ab72f9c009db65c4700e1215e064636b89997` |
| 176 | merged | Merged 2026-08-03 01:31:49Z at `1c6963c5536cd9692d61cf203d806e2931a5e345` |
| 185 | closed | Closed 2026-08-03 01:32:03Z; `merged_at` null |

The JSON ledger pins each observed head SHA, close timestamp, merge timestamp, and merge commit where applicable. It is a final evidence artifact, not an action queue.
