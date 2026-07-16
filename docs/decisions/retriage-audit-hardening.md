# Retriage: audit hardening stack vs. post-teardown main

Status: adopted

## Context

Five audit branches (`audit/r2-core-cli-docs`, `audit/r2-cowork-runtime`,
`audit/r2-security-io`, `audit/r2-codex-install-doctor`,
`audit/r2-codex-generated-contract`) plus two aggregate branches
(`audit/codex-full-20260714-r2`, `audit/codex-integration-20260714`) carried
review-hardening work from before the `muster/codex-teardown` effort deleted
Codex's lock/lease/quarantine machinery (wave 1) and replaced the committed
`.agents/plugins/` payload with install-time generation (wave 2). This
document re-triages that stack, commit by commit, against post-teardown
`feat/codex-integration@af6c34e`.

Each `audit/r2-*` branch's tip commit is a byte-identical patch (same
`git patch-id`) to one link of the chain below — just rebased directly onto
`a9a9e14` instead of stacked. The decision for the chain commit is the
decision for its `r2-*` twin.

## Decision table

| Order | Commit(s) | Topic | Decision | Why |
|---|---|---|---|---|
| 1 | `9654f70` (= tip of `audit/r2-core-cli-docs`, `934ffdb`) | harden core CLI contracts and docs | **APPLY** | `help`/`--help` short-circuit, `signals [dir]` writing under the target dir, doctor's vendor-note-staleness failing loud, humanize-score threshold validation, and manifest null-safety for crew/plan entries touch none of the removed lock/lease/payload machinery. None of it had landed on post-teardown main. |
| 2 | `5989509` (= tip of `audit/r2-cowork-runtime`, `7041813`) | harden Cowork routing and concurrency | **APPLY** | Cowork capability restriction to MCP/inline providers, `muster_audit`'s explicit target-dir requirement, and the MCP server's in-flight/queue concurrency limiter with cancellation are independent of the teardown's release-path/lock changes. None of it had landed. |
| 3 | `caefe6a` (= tip of `audit/r2-security-io`, `4053803`) | harden filesystem ownership and hook state | **APPLY** | Hashed/private/symlink-safe hook state files (`plugin/hooks/inline-budget.js`, `user-prompt-submit.js`), symlink-safe legacy-style handling in `src/install.js`, and symlink/traversal-safe atomic publish in `src/vendor.js` are general filesystem-safety hardening, not the Codex release-path lock/lease system the teardown removed. None of it had landed. |
| 4 | `447f930` / `3a7efef` (= tip of `audit/r2-codex-install-doctor`) | harden Codex install and doctor contracts | **APPLY** | Scope-registry `owner !== "muster"` rejection and `runMcpHandshake` settle-once/cleanup hardening operate on `src/codex-install.js`/`src/codex-doctor.js` — files whose transaction/handshake shape is unchanged by the teardown (the removed lock/lease machinery lived in `codex-lock.js`'s release-path locking and `scripts/build-codex.mjs`'s generation lock, a different subsystem). None of it had landed. |
| 5 | `ef765ef` / `5a98db1` (= tip of `audit/r2-codex-generated-contract`) | enforce Codex generated contract parity | **DROP** | 295 files, ~9.8k lines, almost entirely renames/edits under the committed `.agents/plugins/plugins/muster/...` and `.agents/plugins/releases/<hash>/...` tree plus checked-in `.codex/agents/*.toml`. Wave 2 (`58e4624`, "install-time generation replaces committed payload") deleted that whole tree; `.agents/` is now 100% build output and `.gitignore`d (see `.gitignore` lines 3-6). `git apply --check` on this commit against current main fails on every one of its ~230 touched paths with "does not exist in index". There is no current-code target left to apply this to. |
| 6 | `f2da066` | close outstanding integration issues | **DROP, with one flagged gap** | 520 files, ~4.3k lines. The overwhelming majority is the same `.agents/plugins/releases/<hash>/...` + checked-in `.codex/agents/*.toml` payload management as (5), plus a "native Codex Plan/Goal lifecycle" generation feature whose tests only exercise files under the now-generated `selectedPluginRoot` (`.agents/plugins/releases/...`) and whose companion decision record (`docs/decisions/2026-07-15-codex-native-plan-goal.md`) is a Codex-generation-feature adoption note, not applicable to a re-triage. **Flagged gap, not silently dropped:** this commit also introduced a self-contained, non-payload module `src/codex-thread-limits.js` (`ensureCodexThreadLimits`/`restoreCodexThreadLimits`) that would write/restore `[agents] max_threads >= 12` / `max_depth >= 2` in the user's actual `~/.codex/config.toml` at install/uninstall time. Current generated Codex text already *references* `agents.max_threads` (`test/codex-mode-seed.test.js:106`, `test/codex.test.js:419,440`) but nothing enforces it in the user's config — this is a real, live gap. Implementing it correctly (new module + `runCodexInstall`/`runCodexUninstall` wiring + ownership-manifest handling + tests) is a feature-sized unit of work in its own right, entangled in this commit's diff with the dropped payload/Plan-Goal content and with heavily drifted `test/codex.test.js` context. Re-implementing it here would be scope creep past this retriage; recommending it as a **separate backlog item** rather than dropping it unremarked. |
| 7 | `d31dc19` | repin audited shared orchestration surface | **APPLY (recomputed)** | `test/claude-parity.test.js`'s surface hash must move whenever a tracked Claude-surface file (`plugin/hooks/*`, `cowork/mcp-server.mjs`, etc.) changes content — (2) and (3) above both do. The commit's own target hash (`30fe004f...`) was recomputed independently after applying (1)-(4) here and matched byte-for-byte, confirming this retriage reproduced the same file contents as the original chain. |
| 8 | `ff0cf39` | clean secure hook state between cases | **APPLY** | `test/hook-pre-tool-use-e1.test.js`'s `clearBudget` helper depended on the pre-`caefe6a` sanitize-based filename; once (3) hashes session ids into a private state directory, the old helper silently stopped clearing anything between test cases. Trivial, directly dependent on (3), still correct. |

## Receipts

- Baseline (before any change, `af6c34e`, after `npm install` + one
  `MUSTER_BUILD_FORCE=1 node scripts/build-codex.mjs` to prime the gitignored
  `.agents/plugins` staging dir that `npm test`'s `pretest` hook normally
  builds): `node --test --test-concurrency=4` → `tests 1658, pass 1657, fail 0,
  skipped 1`.
- After commit 1 (9654f70) applied: `test/cli-prompt.test.js`,
  `test/cli-wire.test.js`, `test/doctor.test.js`, `test/humanizer-score.test.js`,
  `test/manifest.test.js`, `test/website-docs.test.js` → 123/123 pass; full
  suite → 1679/1678 pass, 1 skip.
- After commit 2 (5989509) applied: `test/capabilities.test.js`,
  `test/harness-cowork.test.js` → 25/25 pass; `test/cowork.test.js` → 33/33
  pass (including the new concurrency/cancellation test). Full suite intentionally
  left with one red (`test/claude-parity.test.js`, expected — surface hash pin,
  fixed in commit 7).
- After commit 3 (caefe6a) + 8 (ff0cf39) + 7 (d31dc19, recomputed) applied:
  hook/vendor/uninstall test files → 131/131 and 55/55 pass;
  `test/claude-parity.test.js` → pass, recomputed hash
  `30fe004fdbaf6911b53188c0a9c56300d2b3f1abef5241e8b962f795c3b2d886` matches
  the original chain's own pin exactly; full suite → 1691/1690 pass, 1 skip.
- After commit 4 (447f930) applied: `test/codex.test.js` → 78/77 pass, 1 skip
  (WSL-drive test skips off `/mnt/c`, unchanged); full suite →
  `node --test --test-concurrency=4` → `tests 1695, pass 1694, fail 0,
  skipped 1`.

## Branch deletions (post-capture cleanup, pre-approved)

Performed only after the decision table above landed and the full suite was
green:

- `/mnt/c/Users/rnben/Documents/Development/muster` (old archive checkout,
  local branches): `audit/codex-full-20260714-r2`,
  `audit/codex-integration-20260714`, `audit/r2-codex-generated-contract`,
  `audit/r2-codex-install-doctor`, `audit/r2-core-cli-docs`,
  `audit/r2-cowork-runtime`, `audit/r2-security-io` — deleted via
  `git branch -D`.
- `origin` (Adnova-Group/muster): `integrate/outstanding-known-issues-20260715`
  — deleted via `git push origin --delete`.

`audit/codex-integration-20260714`'s tip (`9b6b344` and two ancestors,
`724aa36`/`5d92419`) sit outside the reviewed chain — earlier "seed modes
from live inventory" / "regenerate portable CLI bundles" packaging work from
the same 2026-07-14 integration effort, itself superseded by main's own
subsequent Codex packaging and teardown history. Not separately re-triaged
(out of the brief's named-chain scope); deleted as directed along with the
other six.
