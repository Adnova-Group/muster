# Retriage: remaining burn salvage branches vs. post-teardown main

Status: adopted

## Context

Eight burn branches (local at the old archive checkout,
`/mnt/c/Users/rnben/Documents/Development/muster`) carried Codex fix/diagnose/
audit/replay work from 2026-07-14, before the `muster/codex-teardown` effort
deleted Codex's lock/lease/quarantine machinery (wave 1, `1326f45`), replaced
the committed `.agents/plugins/` payload with install-time generation
(wave 2, `58e4624`), and redid model tiering evidence-based (wave 3,
`af6c34e`). This document re-triages each branch, commit by commit, against
post-teardown `feat/codex-integration@af6c34e`.

Net: **0 applied, 8 dropped, 1 mined for findings (0 new proposals)**. Every
branch's functional intent turns out to already be present on mainline —
either carried forward through the teardown waves themselves, or landed
independently on `feat/codex-integration`'s own history under a different
commit. No source or test file changed; this document is the sole
deliverable.

## Decision table

| # | Branch | Commit(s) | Topic | Decision | Why |
|---|---|---|---|---|---|
| 1 | `fix/codex-model-policy` | `89303b0` | evidence-backed model tiering | **DROP (superseded)** | Retiers `codex/agents.manifest.json` to a sonnet/opus/terra scheme and deletes the then-committed `codex/agents/*.toml` duplicates. Wave 3 (`af6c34e`, "model-tiering — evidence-backed lanes") replaced the manifest with a materially different, more evidence-backed scheme (DeepSWE pass@1/cost citations, `luna-xhigh` tier, per-role Sol/Luna overrides) that is the current mainline policy. `89303b0`'s target `codex/agents/*.toml` directory no longer exists at all (wave 2 moved generated profiles to gitignored `.agents/`); only `.codex/agents/*.toml` (a separate, dev-loop-only tracked install scope) remains, and it already reflects the current manifest. Nothing to apply; current policy is a superset. |
| 2 | `fix/codex-startup-diagnostics` | `e322025` | diagnose managed scopes + MCP handshake in `src/codex-doctor.js` | **DROP (already landed, evolved)** | Diffed `e322025`'s full `src/codex-doctor.js` against the current file: `registeredManagedScopes`, `runMcpHandshake`, `ordinaryDirectoryPath`/`readRegularFile` symlink-safe readers, and the MCP timeout/handshake logic are present near-verbatim. The only real differences are wave 2's coherence-key rename (`generation`/`bootstrapDigest` → `packageVersion`) plus a legacy-install migration path (`isLegacyManagedManifest`) added afterward — a superset, not a gap. |
| 3 | `fix/codex-mode-seed-inventory` | `c131db9`, `724aa36`, `5d92419` (+ trivial `1f1c464` wip) | seed Codex `diagnose`/`audit` from live inventory | **DROP (already applied)** | The substantive change (outside the now-deleted committed `.agents/plugins/...` duplicate files) is `resolveModeCapabilities()` in `src/cli.js` and the `--codex` rewrite rules for `diagnose`/`audit` in `scripts/build-codex.mjs`'s `bindBundledCodexCli`. Both are present verbatim in current `src/cli.js:75-81,325-341` and `scripts/build-codex.mjs:167-168`. `c131db9`'s patch-id (`7b124c50...`) is byte-identical to `9b6b344`, a twin already accounted for and dropped by the prior `retriage-audit-hardening.md` retriage. |
| 4 | `fix/codex-build-repro` | `7c905f9` (+ trivial `2ecd619` wip) | reproducible esbuild bundling (`absWorkingDir`/`preserveSymlinks`) | **DROP (already applied, evolved)** | `7c905f9`'s patch-id (`3d007d97...`) is byte-identical to `5d92419` (item 3's tail commit) — same fix, two branches. Current `scripts/build-codex.mjs:374` already builds with `preserveSymlinks: true` and a shared `bundleOptions` object under wave 2's tmpfs-staging rewrite. The regression test this commit added compared a rebuilt bundle against the *committed* `.agents/plugins/plugins/muster/...` path; that path no longer exists (wave 2 untracked it), making the specific test moot, but reproducibility itself is preserved and covered by the current build/test suite. |
| 5 | `replay/codex-hook-health` | `50c9214` | mutation-testing "MUTATION RECEIPT" hardening 3 doctor/hook findings | **DROP (superseded / already correct)** | Finding 2 (`LOCK_LEASE_MS` 30s→20min) targets an emission-dedupe/lease subsystem in `codex/hooks/muster-hook.mjs` that wave 1 deliberately deleted by design (see that file's own "Dropped: an emission-dedupe subsystem..." doc-comment) — there is no lease code left to hardened. Findings 1 and 3 (`ownsExactHookGroups` exact-group predicate; missing-`hooks.json` stale-scope catch) are already correctly implemented in current `src/codex-doctor.js:171-193` (`ownsExactHookGroups`) and `:279-304` (the per-scope try/catch that throws on a missing `hooks.json`/manifest/runtime file and falls into `staleHookScopes`) and already covered by passing tests (`test/codex.test.js:824` "requires exact owned hook groups", `:851` "a managed scope missing hooks.json must fail hook health") — verified green in the baseline run below. |
| 6 | `diagnose/codex-skill-cache-20260714` | `7bf4bd7` (+ base `85636ad`, + no-op wip `7f359e0`) | refresh same-version Codex plugin safely (trusted-marketplace check) | **DROP (already applied)** | `sameLocalRoot`, `trustedMusterMarketplace`, `existingMusterMarketplace`, and the rewritten `registerPlugin(execFile, dryRun, repoRoot)` signature from `7bf4bd7` are all present in current `src/codex-install.js:583-625` (async-hardened further). `git log --oneline -- src/codex-install.js` on the *current repo's* `af6c34e` (not the old checkout's own divergent `feat/codex-integration`, which shares only the root commit and does not contain `af6c34e` at all) shows `25ba650 fix(codex): refresh same-version plugin safely` and `88dec29 feat: add Codex CLI and Desktop integration` as the actual ancestors — matching-message twins of `7bf4bd7`/`85636ad` that landed under different hashes on this branch's real lineage. |
| 7 | `diagnose/muster-token-amplification-20260714` | `a200dc9` | bound Codex orchestration quota usage (25-step ceiling, `agents.max_threads`, 3-heartbeat budget exhaustion) | **DROP (already merged)** | `a200dc9` and the already-merged `10ac433 fix(codex): reduce orchestration quota amplification` (carried into `feat/codex-integration` via `2756f7d` "carry quota-fix model downgrades as teardown baseline") are the same fix rebased onto different bases — `git patch-id` differs only because of surrounding context churn from intervening commits, not content. Every marker string (`25-step ceiling`, `Three consecutive heartbeats`, `agents.max_threads`, `fork_turns: "none"`) is present verbatim in current `codex/skill-adapter.md` and `scripts/build-codex.mjs`. |
| 8 | `audit/codex-protocol-conformance` | `9327d04` (dirty snapshot, 26 files) | "protocol conformance" — actually an uncommitted local-install-state dump, not an audit report | **MINE FOR FINDINGS — 0 new proposals** | This is a `wip: snapshot before worktree removal` commit, not a deliberate finding. Its 26 changed files are all generated `.codex/` install artifacts from one local scope. Two classes of drift appear: (a) per-agent `model`/`model_reasoning_effort`/`sandbox_mode` changes in `.codex/agents/*.toml` — expected churn from model-tiering evolving over time, not a bug; (b) `.codex/hooks.json` and `.codex/muster/.muster-managed.json` show the hook `command`/`commandWindows` fields changing from a relative path to an **absolute, worktree-specific path** (including a duplicated Windows-drive variant) baked in by a local `muster install codex` run. That is exactly the leak wave 3 already fixed: current `.gitignore:12-18` stops tracking both files with the comment "bakes this checkout's absolute path into every hook command, so neither file can be tracked without leaking a machine-specific path to every clone," landed in the same `af6c34e` commit that is this retriage's base. No further action or backlog line is warranted — mining this snapshot surfaces a finding that is already fully resolved. |

## Receipts

- Baseline (`af6c34e`, `item/burn-salvage-retriage`, after `npm install` +
  `MUSTER_BUILD_FORCE=1 node scripts/build-codex.mjs` to prime the gitignored
  `.agents/plugins` staging dir): `node --test --test-concurrency=4` →
  `tests 1658, suites 13, pass 1657, fail 0, cancelled 0, skipped 1, todo 0`.
- No commit changed source or test files (every branch dropped or mined),
  so the baseline run above is also the final run — unchanged, confirmed
  green.
- Patch-id cross-checks performed: `c131db9` = `9b6b344` (`7b124c50...`),
  `7c905f9` = `5d92419` (`3d007d97...`) — both pairs of duplicate commits
  across the eight branches.

## Branch cleanup (post-capture, pre-approved)

Performed only after the decision table above landed and the full suite was
confirmed green. At `/mnt/c/Users/rnben/Documents/Development/muster` (old
archive checkout), deleted via `git branch -D`, all remaining burn workflow
branches (`audit/*`, `fix/*`, `diagnose/*`, `replay/*`, `go/*`, `integrate/*`):

`audit/codex-protocol-conformance`, `diagnose/codex-skill-cache-20260714`,
`diagnose/muster-token-amplification-20260714`, `fix/codex-build-repro`,
`fix/codex-mcp-hooks-startup`, `fix/codex-mode-seed-inventory`,
`fix/codex-model-policy`, `fix/codex-startup-diagnostics`,
`go/codex-efficiency-enforcement-20260715`,
`go/codex-native-orchestration-20260715`,
`integrate/outstanding-known-issues-20260715`, `replay/codex-hook-health`.

`fix/codex-mcp-hooks-startup` was not separately re-triaged (out of this
brief's eight named branches) — its six commits (`0de12d8` "apply
evidence-backed model policy", `ab0ffb2` "diagnose managed scopes and MCP",
`6f5de54`, `46d8802`, `08c3287`, `3dfd38e`) are an earlier, longer chain that
items 1/2 above are later rebased/renamed descendants of; already fully
superseded by the same evidence above. Deleted alongside the rest per the
blanket cleanup mandate.

Old checkout's final `git branch` list (29 branches, all mainline —
`feat/*`, `item/*`, `main`, `muster/*`, `release/*` — untouched):

```
feat/codex-integration
item/anti-pattern-ledger
item/binding-interface
item/contradiction-check
item/coordination-preflight
item/corpus-checker-extend
item/cowork-rename
item/dedup-cluster
item/docs-currency-041
item/eval-drain-rubric
item/frontmatter-shared
item/grammar-consumers
item/historical-comment-cleanup
item/isabsolute-crossplatform
item/manifest-inventory-lint
item/match-skills-flag
item/mutant-kill-rule
item/parseref-abs-guard
item/prompt-lint-backlog
item/reanchor-test-tighten
item/release-041
item/remote-text-reanchor
item/scale-gate-verbs
item/scope-batch-harden
item/stub-comment-cleanup
item/symlink-guard
main
muster/codex-teardown
release/v0.3.2-docs
```
