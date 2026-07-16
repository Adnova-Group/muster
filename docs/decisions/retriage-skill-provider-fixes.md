# Retriage: skill-provider fixes vs. post-teardown main

Status: adopted

## Context

`diagnose/codex-skill-budget-20260714` (local branch at the old archive
checkout, `/mnt/c/Users/rnben/Documents/Development/muster`) carries six
skill-provider commits investigated during a 2026-07-14 diagnose session,
before the `muster/codex-teardown` effort deleted Codex's lock/lease/bootstrap
machinery (wave 1, `1326f45`) and replaced the committed `.agents/plugins/`
payload with install-time generation (wave 2, `58e4624`/`f28f64c`). This
document re-triages that six-commit stack against post-teardown
`feat/codex-integration@af6c34e`.

Three of the six commits (`ac036ce`, `7b0a384`, `8984f85`) turn out to be
`git patch-id`-identical to commits already sitting on mainline's own history
below `af6c34e` (`05a0cbd`, `7b7c6e1`, `6f4b56c` respectively) — same session,
cherry-picked/replayed onto the integration branch before the diagnose branch
diverged further. Their functional content survived wave 1/2/3 untouched. The
other three (`744bafc`, `7191001`, `be5a2a5`) are lease/bootstrap/pointer
machinery and one accidental test-fixture commit, all of which wave 1's
"strip lock/lease/quarantine machinery from codex hooks and release path"
deleted by design — confirmed by reading `1326f45`'s own diff and the
"Wave 2 teardown" doc-comment at the top of current `src/codex-release.js`.

## Decision table

| Order | Commit | Topic | Decision | Why |
|---|---|---|---|---|
| 1 | `8984f85` fix(codex): bound public skill discovery surface | split `plugin/skills` (public mode dispatchers) from `plugin/internal-skills` (ported workflows Codex must not auto-register) | **DROP (already applied)** | `git patch-id` for `8984f85` is byte-identical (`41c4f16d...`) to mainline's own `6f4b56c`, an ancestor of `af6c34e`. Its non-bootstrap deliverables — `internalSkillDir` split in `scripts/build-codex.mjs`, `translatePluginPaths` routing to `${PLUGIN_ROOT}/internal-skills/`, `CODEX_COUNTS.publicSkills`/`internalSkills` in `src/codex.js`, and the internal/public drift checks in `scripts/check-codex.mjs` (lines 75, 82, 85, 152) — are present verbatim in the current tree. Only the commit's `codex/bootstrap/resolve-release.mjs` hunk and its `package.json` `selections`/`releases` file-list churn are dead: no `codex/bootstrap/` directory or bootstrap-immutable-skill-surface check exists post-teardown. |
| 2 | `7b0a384` test(codex): reject invalid internal skill ids | regression test for rejecting a malformed/traversal skill id at the bootstrap resolver | **DROP (already applied, in updated form)** | `git patch-id` for `7b0a384` is byte-identical (`56e1d6e7...`) to mainline's own `7b7c6e1`. The old assertion targeted the now-deleted bootstrap `resolve-release.mjs`'s `internal-skill` kind; the equivalent regression against the *current* architecture (`resolve-skill-provider.mjs`) already lives in `test/codex-cache-package.test.js:76-82` — it rejects `["installed", "Not_Valid"]` (same malformed-id case as the original test), `["builtin", "../../escape"]` (traversal), and `["external", "brainstorming"]` (invalid source), and runs as part of the green suite. |
| 3 | `ac036ce` fix(codex): verify internal skill provider loading | verified, hash-checked bundled-asset reader for internal skill workflows plus a `resolve-skill-provider.mjs` entry point | **DROP (already applied)** | `git patch-id` for `ac036ce` is byte-identical (`c0446f7c...`) to mainline's own `05a0cbd`. `codex/resolve-skill-provider.mjs` and `codex/internal-asset-loader.mjs` in the current tree are byte-for-byte identical to the versions `ac036ce` introduced (verified by direct `diff`); `writeInternalRuntime` in `scripts/build-codex.mjs`, the adapter/orchestrator provider-resolution prose in `codex/skill-adapter.md` and `scripts/build-codex.mjs`, and the provider-resolver validations in `scripts/check-codex.mjs` (lines 154-160) are all present and exercised by `test/codex-cache-package.test.js`'s hash-tamper/symlink-rejection assertions (lines 84-96). Only the commit's `deferFinalPointer`/`pendingPointer`/lease-selection hunks in `src/codex-release.js` and the paired `codex/bootstrap/resolve-release.mjs` changes are dead — see (5)/(6) below. |
| 4 | `744bafc` fix(codex): retain fresh bootstrap generation before publish | fixed a bug where `initialGeneration` was read from the about-to-be-replaced `marketplace.json` instead of the freshly `published` generation | **DROP (dead machinery)** | Patches `scripts/build-codex.mjs`'s `retainedGenerations` pruning and `publishCodexRelease`'s returned `initialGeneration` field. Current `publishCodexPlugin`/`resolveCodexPlugin` in `src/codex-release.js` have no `musterBootstrap`, `initialGeneration`, `selections/`, or generation-retention concept at all (wave 2 replaced the whole committed content-addressed release model with a gitignored install-time staging copy). Nothing to retain; nothing to apply. |
| 5 | `7191001` chore(codex): remove race test fixture | deletes a `.codex-race-<random>/checkout/...` full-repo copy that `be5a2a5` (below) had accidentally `git add`-ed from a concurrency test's tmp output | **DROP (no-op cleanup for content that no longer exists)** | Pure cleanup commit for a stray artifact of the old lease-based concurrency tests. No such directory, no such test harness, and no lease code exist in the current tree — there is nothing here to drop *or* to clean up a second time. |
| 6 | `be5a2a5` fix(codex): defer maintenance pointer publication | adds `deferFinalPointer`/`commitPointer`/`discardPointer` staged-pointer semantics to the old `musterBootstrap`-pointer `publishCodexRelease`, so a bootstrap-maintenance migration doesn't publish until the whole build (staging cleanup included) has succeeded | **DROP (dead machinery)** | Same old committed-generation/bootstrap-pointer model as (4). Current `publishCodexPlugin` publishes by copy-then-atomic-pointer-write in a single call with no maintenance-migration/bootstrap-digest-drift concept, no deferred/staged pointer, and no `commitPointer`/`discardPointer` pair; `test/codex-release.test.js` carries no `musterBootstrap`/`deferFinalPointer` references. The bulk of this commit's diff (924 files changed total; 922 of them under `.codex-race-ZpJOuW/checkout/`) is in fact an accidentally committed full-repo test-fixture dump from a concurrency test's tmp output, cleaned up by (5) above. |

Net: **0 applied, 6 dropped** — 3 as functionally-superseded duplicates already
on mainline pre-teardown, 3 as machinery wave 1/2 deleted by design. No source
change was needed; this document is the sole deliverable of the retriage
itself.

## Receipts

- Baseline (`af6c34e`, after `npm install` + one `MUSTER_BUILD_FORCE=1 node
  scripts/build-codex.mjs` to prime the gitignored `.agents/plugins` staging
  dir that `npm test`'s `pretest` hook normally builds):
  `node --test --test-concurrency=4` → `tests 1658, pass 1657, fail 0,
  cancelled 0, skipped 1, todo 0`.
- No commit changed source or test files, so the baseline run above is also
  the final run: `tests 1658, pass 1657, fail 0, skipped 1` — unchanged,
  confirmed green.
- `git patch-id` cross-checks (old checkout vs. current `af6c34e` ancestry):
  - `744bafc` vs `6bba85e` → `18a099f8...` = `18a099f8...` (MATCH; both dead)
  - `7191001` vs `fa76a27` → differ (both are the same class of stray-fixture
    cleanup, same tmp-dir random suffix `ZpJOuW` on both sides; the only
    byte-level difference is a `node_modules` symlink target embedding the
    machine-local checkout username, harmless either way)
  - `be5a2a5` vs `c9568a5` → differ (same intent — deferred-pointer machinery
    — landed independently on each branch; both fully superseded by wave 2)
  - `ac036ce` vs `05a0cbd` → `c0446f7c...` = `c0446f7c...` (MATCH)
  - `7b0a384` vs `7b7c6e1` → `56e1d6e7...` = `56e1d6e7...` (MATCH)
  - `8984f85` vs `6f4b56c` → `41c4f16d...` = `41c4f16d...` (MATCH)

## Branch deletion (post-capture cleanup, pre-approved)

Performed only after this decision table landed and the full suite was
confirmed green:

- `/mnt/c/Users/rnben/Documents/Development/muster` (old archive checkout,
  local branch): `diagnose/codex-skill-budget-20260714` — deleted via
  `git branch -D`.
