# Open PR branch reconciliation

This reconciles every currently open pull request and branch this run was chartered to own -- PRs
145–152, 166–176, and 185 -- into backlog truth, observed live from GitHub at
`2026-08-03T22:14:32.000Z` against base commit `95b3bf9c2d6c8ffc75469b01b4b0c1ee94679be1`. The
machine-readable authority is [open-pr-branch-reconciliation.json](open-pr-branch-reconciliation.json).

This run made no GitHub mutation. Every PR was verified read-only via `gh pr view` per PR, and every
claimed merge commit was cross-checked with `git merge-base --is-ancestor` against this worktree's
local `HEAD` before being trusted. **None of the 20 PRs are open anymore** -- 10 merged, 10 closed
without merging -- so there is no open PR left unowned. Each closed-unmerged PR was further checked
for whether its promised functionality actually landed on main under a different implementation
(a legitimate supersede) or is genuinely missing (a gap this run flags honestly rather than papering
over as "superseded").

| PR | Disposition | GitHub evidence | Landed on main? |
|---:|---|---|---|
| 145 | close-with-rationale | Closed 2026-08-03 01:32:20Z; `merged_at` null | **No — gap.** MCP-specific Node runtime pin (`test/codex-mcp-node-pin.test.js`) absent; only the distinct lifecycle-hook pin landed. |
| 146 | close-with-rationale | Closed 2026-08-03 01:32:18Z; `merged_at` null | Yes — `src/codex-strict-config.js` + test, independent implementation on main. |
| 147 | close-with-rationale | Closed 2026-08-03 01:32:16Z; `merged_at` null | Yes — exact-hash hook trust check already in `src/codex-doctor.js` (predates this PR). |
| 148 | close-with-rationale | Closed 2026-08-03 01:32:14Z; `merged_at` null | Yes — `src/codex-wave-runner.js` + test, independent implementation on main. |
| 149 | close-with-rationale | Closed 2026-08-03 01:32:12Z; `merged_at` null | Yes — canonical thread ceiling landed (`fed5177`, `cb1b3fc`). |
| 150 | close-with-rationale | Closed 2026-08-03 01:32:11Z; `merged_at` null | Yes — event-driven watcher fix landed (`2101dc9`). |
| 151 | close-with-rationale | Closed 2026-08-03 01:32:09Z; `merged_at` null | N/A — the PR's own benchmark rejected adoption; nothing was meant to land. |
| 152 | close-with-rationale | Closed 2026-08-03 01:32:07Z; `merged_at` null | Yes — `src/codex-fix-loop.js` + tests, independent implementation on main. |
| 166 | close-with-rationale | Closed 2026-08-03 01:32:05Z; `merged_at` null | **No — gap.** `src/codex-doctor.js` is still a single 1416-line file; no concern-based split exists. |
| 167 | merged | Merged 2026-08-03 01:31:50Z at `df18f5232ca773c4c85a96100b39e3d59b09e4f5` | Yes — merge commit is an ancestor of local `HEAD`. |
| 168 | merged | Merged 2026-08-03 01:31:50Z at `01a82dd131f67bb3c8fcbc5a1e6c9299ca8492fa` | Yes — merge commit is an ancestor of local `HEAD`. |
| 169 | merged | Merged 2026-08-03 01:31:50Z at `9c6eeab778818167a0f5bffd6ae6ff9cea15226c` | Yes — merge commit is an ancestor of local `HEAD`. |
| 170 | merged | Merged 2026-08-03 01:31:50Z at `a8376b0c69a97fe36fc7f93a3d475aefaf64eebd` | Yes — merge commit is an ancestor of local `HEAD`. |
| 171 | merged | Merged 2026-08-03 01:31:50Z at `ddea8ce88164d0e2ae4f75bb6c4aab55c198de63` | Yes — merge commit is an ancestor of local `HEAD`. |
| 172 | merged | Merged 2026-08-03 01:31:50Z at `75a7c44463c6310c6b9c3ab2fe9c0b1729d5e158` | Yes — merge commit is an ancestor of local `HEAD`. |
| 173 | merged | Merged 2026-08-03 01:31:50Z at `75232fcf6a93d81cec2eb6dc5b13753a2af6ca42` | Yes — merge commit is an ancestor of local `HEAD`. |
| 174 | merged | Merged 2026-08-03 01:31:50Z at `f8a3e62c88ae91c0db75e90448d6e42de6ccb94e` | Yes — merge commit is an ancestor of local `HEAD`. |
| 175 | merged | Merged 2026-08-03 01:31:49Z at `a92ab72f9c009db65c4700e1215e064636b89997` | Yes — merge commit is an ancestor of local `HEAD`. |
| 176 | merged | Merged 2026-08-03 01:31:49Z at `1c6963c5536cd9692d61cf203d806e2931a5e345` | Yes — merge commit is an ancestor of local `HEAD`. |
| 185 | close-with-rationale | Closed 2026-08-03 01:32:03Z; `merged_at` null | Yes — `src/codex-plan-launch.js` + test, independent implementation on main. |

**Summary: 10 merged, 10 closed with rationale, 0 active-with-owner (no PR remains open).**

## False completed state corrected

The tracked copy of this artifact in this worktree, inherited at base commit `95b3bf9`, was itself
stale: it recorded all 20 PRs as `observedState: "OPEN"` / `backlogState: "awaiting-disposition"` as of
an `2026-08-02T03:40:35.000Z` snapshot. That is no longer true for any of the 20 PRs and has been
replaced in full by the live-verified data above. No other tracked file in this worktree references
any of these PRs' branch names or titles as complete, so no further correction was needed elsewhere.

## Genuine gaps flagged for the dispatcher (not superseded, not this run's to fix)

Two closed-unmerged PRs (145, 166) promised functionality this run could **not** find anywhere on
main under any name, unlike the other eight closed-unmerged PRs whose outcomes verifiably landed
through independent implementations. Both PRs are terminally closed on GitHub and this run does not
reopen, merge, or otherwise mutate them (read-only `gh` only). The honest recommendation is a fresh
backlog item for each, not treating the closed PR as done:

- **#145** — the MCP-specific entrypoint/nested-launch Node runtime pin is still missing; only a
  narrower lifecycle-hook interpreter pin landed.
- **#166** — the "refactor Codex doctor by concern" split never landed; `src/codex-doctor.js` remains
  a single 1416-line file.

## Addendum: PR 145 correction (2026-08-03, `codex-runtime-identity-reconcile`)

The "genuine gap" classification for PR 145 above is **incorrect** and is superseded by
[codex-runtime-identity-pr145-supersede.md](codex-runtime-identity-pr145-supersede.md). PR 145's
promised MCP Node runtime pin was already fully present on `main` at the moment this reconciliation
ran (landed under commit `375c186`, an ancestor of this document's own `95b3bf9` base, via
`src/codex-runtime-identity.js` + `test/codex-runtime-identity.test.js` — different names than
this reconciliation's search terms, which is why the search missed it). No code gap exists; PR 145
is closed-superseded with no further action. The `open-pr-branch-reconciliation.json` machine
record is left as originally captured (a faithful record of what that run's search found) with a
matching `correction` field added rather than rewritten in place.

## Execution preconditions (unchanged posture)

This reconciliation is read-only evidence, not an action queue. Merges already happened externally
(GitHub reports real `merged_at` timestamps and merge commits, all verified as ancestors of this
worktree's local `HEAD`); this run performed zero merges, closes, comments, or any other GitHub
mutation. Any further action on the two flagged gaps belongs to the dispatcher and a human, never to
this run.
