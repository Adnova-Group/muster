# PR 147 (Codex exact hook-trust installation check): explicit supersede, not a gap

- **Status:** Accepted — explicit supersede
- **Date:** 2026-08-03
- **Item:** `codex-hook-trust-reconcile` — "Land or explicitly supersede PR 147's exact Codex
  hook-trust installation check. Five fixtures covering trusted, changed-hash, disabled, absent,
  and stale state must produce exact per-hook results, and installation must never claim success
  when a Muster hook is inactive."
- **Driven by:** `codex-hook-trust-reconcile`
- **Extends:** `docs/decisions/open-pr-branch-reconciliation.md` / `.json` (commit `a5ae73a`), PR
  147 row, which already classified PR 147 as `landedOnMain: true` / `disposition:
  close-with-rationale`, crediting `src/codex-doctor.js:1344-1347`'s exact-hash hook trust check
  as predating PR 147's branch head (`5ef7a1e`, 2026-07-25, vs. PR 147's head, 2026-07-26). That
  classification is correct and is not revised here. This document supplies the fixture-level and
  install-refusal proof this item's dispatch explicitly required, beyond reconciliation's own
  read-only `gh`/`git merge-base` verification.

## Conclusion

**PR 147 is explicitly superseded, not landed.** Its branch is terminal on GitHub (closed
2026-08-03T01:32:16Z, `merged_at: null`, never reopened or merged by this or any run). Every
guarantee PR 147's title promised ("verify exact hook trust state") is implemented on `main` today
— more thoroughly than a from-scratch fixture check, having been built and hardened across 20
commits from `5ef7a1e` (2026-07-25, "doctor fails on untrusted Muster hooks (the silent-disable
hazard)") through `3d06d1f` ("merge final Codex hook-trust reconciliation"), all verified ancestors
of this worktree's `HEAD` (`c4cb439`). **No code changes are required or made by this item** — the
work is producing and recording the fixture/install-refusal proof this item's dispatch demanded,
which did not previously exist as a single consolidated record.

## Where the check lives

- `musterHookTrustGaps({ configTomlText, hooksJsonPath, config, hookGroups })` —
  `src/codex-install.js:966-1010` (pure, text-scoped). For every Muster-owned hook position it
  compares the position's live `hooks.json` content hash against Codex's own
  `config.toml[hooks.state."<hooksJsonPath>:<event>:<groupIndex>:<hookIndex>"]` trust cache entry
  and classifies it into an exact `status`: `"trusted"` (hash matches, enabled), `"modified"` (a
  trust entry exists but its `trusted_hash` no longer matches the current hash), `"disabled"`
  (`enabled = false`), `"untrusted"` (no trust entry at all), or `"invalid"` (malformed/duplicate
  TOML state). Positions with a state entry that names no current hook are additionally reported in
  a separate `stale` array.
- `effectiveHookTrust(inventory, cwd, hooksJsonPath, results, { knownKeys })` —
  `src/codex-install.js:900-965`. Cross-checks the *persisted* trust cache above against Codex's own
  live `hooks/list` inventory (the actual runtime activation proof), rejecting duplicate/foreign/
  malformed inventory records, unexpected active positions, and physical-alias attempts.
- Doctor wiring — `src/codex-doctor.js:1092-1347`. Builds `hookTrustTargets` from `musterHookTrustGaps`
  per coherent scope, then folds a `hooks/list`-based effective-activation proof (before/after
  snapshot stability, alias detection) into the `codex-hook-trust` check pushed at
  `src/codex-doctor.js:1344-1347`: `ok: untrustedCount === 0`, where `untrustedCount` counts every
  persisted gap/stale entry plus every effective-activation failure — never a single lumped boolean
  across a scope's hooks.
- Install wiring — `src/codex-install.js:3279-3343` (`runCodexInstall`). Computes the same
  `musterHookTrustGaps` + `effectiveHookTrust` pair for the scope being installed and folds them into
  `hookTrust: { ok: persistedOk && effective.ok, blocking: !persistedOk || !effective.ok, results,
  stale, effective, remediation }` (`src/codex-install.js:3324-3333`). Critically, the function's
  **overall** return value is `ok: dryRun ? true : hookTrust.ok` (`src/codex-install.js:3335`) — a
  non-dry-run install can never report `ok: true` while any owned hook is untrusted, modified,
  disabled, stale, or unconfirmed active, because `hookTrust.ok` is folded directly into the top-level
  result rather than being a separate, ignorable field.

## Criterion → test map

**1. "Five fixtures covering trusted, changed-hash, disabled, absent, and stale state must produce
exact per-hook results (not a lumped boolean)."**

`test/codex-hook-trust.test.js:24-115`, test `"musterHookTrustGaps returns exact per-hook trust
results for all five Codex states"`, five `t.test` subtests, one per fixture:

| Item's required state | Fixture name (`test/codex-hook-trust.test.js`) | Asserted exact per-hook `status` | Asserted `stale` |
|---|---|---|---|
| trusted | `trusted` (line 26) | `"trusted"` | `[]` |
| changed-hash | `changed-hash` (line 39) | `"modified"` | `[]` |
| disabled | `disabled` (line 52) | `"disabled"` | `[]` |
| absent | `absent-state` (line 66) | `"untrusted"` | `[]` |
| stale | `stale-position` (line 78) | `"trusted"` (for the live position) | `["post_tool_use:1:0"]` (the leftover stale position, reported by exact key) |

Each subtest (lines 104-113) asserts the full per-hook `result` object — `{ key, currentHash,
trustedHash, enabled, status }` — via `assert.deepEqual`, plus the derived `trusted`/`untrusted`/
`stale` arrays, so the check reports one exact status per hook position, never a single pass/fail
boolean for the scope.

**2. "Installation must never claim success when a Muster hook is inactive."**

Mapped per state at the `runCodexInstall`/CLI level (the actual "installation claims success or
not" surface, `hookTrust.ok` folded into the top-level `ok` at `src/codex-install.js:3335`):

| State | Test | Assertion |
|---|---|---|
| absent (no trust entry at all) | `test/codex-hook-trust.test.js:606-627`, `"Codex install blocks on untrusted writes..."` | `first.ok === false`; `first.hookTrust.ok === false`; `first.hookTrust.blocking === true`; every one of 7 results has `status === "untrusted"` (lines 611-617). CLI variant `test/codex-hook-trust.test.js:669-690`, subtest `"absent"`: `run.status === 2`, `output.ok === false`, a result with `status === "untrusted"`. |
| changed-hash (modified) | `test/codex-hook-trust.test.js:669-690`, subtest `"modified"` | `run.status === 2` (CLI exit code), `output.ok === false`, a result with `status === "modified"`. |
| disabled | `test/codex-hook-trust.test.js:669-690`, subtest `"disabled"` | `run.status === 2`, `output.ok === false`, a result with `status === "disabled"`. |
| stale | `test/codex-hook-trust.test.js:658-661` | After a stale `pre_tool_use:9:0` trust entry is planted, `stale.ok === false` and `stale.hookTrust.stale` deep-equals `["pre_tool_use:9:0"]` — install refuses success even though every *other* position is exactly trusted and active. |
| persisted-trust-only, not yet confirmed active (the effective/`hooks/list` half of the guarantee) | `test/codex-hook-trust.test.js:628-643` | `trusted.ok === false` even with every `trusted_hash` exactly correct in `config.toml`, because `trusted.hookTrust.effective.verified === false` (no `hooks/list` proof yet — `"persisted trust alone cannot prove effective activation"`); a `hookInventory` that reports zero active hooks (`suppressedInventory`) also keeps `suppressed.ok === false` even though the persisted trust cache is exactly correct, proving a Codex policy-suppressed hook cannot be reported active by persisted state alone. |
| genuinely trusted AND confirmed active (positive control — install *does* succeed) | `test/codex-hook-trust.test.js:644-656` | Only once a `hookInventory` reports every hook exactly active does `active.ok === true`, `active.hookTrust.ok === true`, `active.hookTrust.blocking === false`, `active.hookTrust.effective.ok === true`, and every result's `status === "trusted"`; the paired `codex-hook-trust` doctor check is `ok: true` with detail matching `/exact current hash and enabled state/i`. |

Every one of the five states named in this item's brief (trusted, changed-hash, disabled, absent,
stale) has its own dedicated install-refusal assertion above except the positive "trusted" control,
which is the required proof that installation *does* report success once — and only once — every
owned hook is both exactly trusted (persisted) and confirmed active (`hooks/list`, effective) — the
same "never inactive AND success" guarantee stated from the other direction.

## Verification (this run, on `muster/codex-hook-trust-reconcile-20260803` @ `c4cb439`)

```
$ node scripts/build-codex.mjs
Codex plugin v0.6.0 generated at .../codex-hook-trust-reconcile/.agents/plugins/plugin

$ node --test test/codex-hook-trust.test.js
▶ musterHookTrustGaps returns exact per-hook trust results for all five Codex states
  ✔ trusted (2.053397ms)
  ✔ changed-hash (0.21343ms)
  ✔ disabled (0.166112ms)
  ✔ absent-state (0.097811ms)
  ✔ stale-position (0.153646ms)
✔ musterHookTrustGaps returns exact per-hook trust results for all five Codex states (3.388479ms)
✔ musterHookTrustGaps matches Codex 0.145 matcher omission and rejects malformed or duplicate state (0.393019ms)
✔ musterHookTrustGaps does not label a current non-Muster hook state stale (0.146872ms)
✔ musterHookTrustGaps never certifies header-shaped text inside TOML multiline strings (0.159548ms)
✔ effectiveHookTrust accepts Codex 0.146 full hook records without relaxing their schema (2.471511ms)
✔ install and doctor reject hooks/list proofs when activation files change during inventory (688.82609ms)
✔ install rejects a runtime changed during plugin registration after the transaction proof (339.94018ms)
✔ install and doctor reject another inventory source physically aliasing the managed runtime (888.337543ms)
✔ Codex project installs use the primary checkout config root from a linked worktree (381.185007ms)
✔ Codex project uninstall reaches a pre-canonical linked-worktree scope (203.227143ms)
✔ effectiveHookTrust rejects duplicate scope and managed hook inventory records (0.938233ms)
✔ Codex reinstall rejects an exact duplicate Muster group left outside manifest ownership (155.04444ms)
▶ ordinary project/user install and doctor reject unexpected active positions
  ✔ project (663.098608ms)
  ✔ user (477.671429ms)
✔ ordinary project/user install and doctor reject unexpected active positions (1141.171703ms)
✔ Codex install blocks on untrusted writes and clears only after exact persisted and effective trust (1645.788443ms)
▶ Codex install CLI exits 2 for absent, modified, and disabled hook trust
  ✔ absent (418.747382ms)
  ✔ modified (416.094753ms)
  ✔ disabled (418.342615ms)
✔ Codex install CLI exits 2 for absent, modified, and disabled hook trust (1253.908716ms)
ℹ tests 25
ℹ pass 25
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 6802.416688
```

`node scripts/build-codex.mjs` was required once before the focused run — without it the file
throws `Error: Codex plugin staging directory is missing: .agents/plugins` from
`test-support/codex-helpers.js`'s module-load-time `resolveCodexPlugin(repoRoot)` call, a
pre-existing generated-artifact dependency unrelated to hook trust (reproduces identically with
zero files changed on this branch).

## Adjacent, not double-counted

`test/codex-hook-state.test.js` (31 tests, independently green — `node --test
test/codex-hook-state.test.js`: `tests 31 / pass 31 / fail 0`) covers a related but distinct
guarantee: pruning **stale** `[hooks.state]` trust-cache entries left behind by deleted/duplicate
scopes (`reconcileConfigTomlHookState`, the `codex-hook-bombardment` fix). It is not cited above as
criterion evidence because it does not exercise `musterHookTrustGaps`' five-state per-hook status
classification or `runCodexInstall`'s inactive-hook install refusal — it is a sibling check
(`codex-hook-state` in doctor) over a related but separate file surface.

## Decision

PR 147 is recorded **closed — superseded**, not reopened, not merged, no code changes required. The
fixture-level per-state proof and the install-never-succeeds-while-inactive proof this item's
dispatch required are both already present and independently green, mapped above test-by-test. This
document is the disposition record; no further backlog item is warranted for PR 147.

## Consequences

- No functional/behavioral code changes in this item — the guarantee already existed, already
  covered by a passing test suite (25/25) before this item started, across five distinct exact-status
  fixtures and a matched set of install-refusal assertions for every one of those five states.
- `docs/decisions/open-pr-branch-reconciliation.md` / `.json` needed no correction (unlike PR 145):
  their PR 147 classification was already accurate; this document only adds the deeper fixture/
  install-refusal proof layer that reconciliation's read-only `gh`/`git merge-base` pass did not
  attempt to produce.
