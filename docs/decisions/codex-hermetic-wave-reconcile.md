# Codex hermetic wave lane: PR 148/149/151 reconcile

Status: adopted

## Context

PR 148 ("feat(codex): run hermetic process waves") could not be landed by merge
— GitHub reports it `CLOSED`, `mergedAt: null` (see
[open-pr-branch-reconciliation.json](open-pr-branch-reconciliation.json) #148,
observed read-only via `gh pr view`, no mutation performed). The path this item
took is **explicit supersession**: `src/codex-wave-runner.js` +
`test/codex-live-wave.test.js` reached `main` independently through
`45fb316..256ec3f` ("feat(codex): reconcile hermetic process waves" →
"fix(codex): make production waves process-only"), merged via `3e5d6db merge
Codex hermetic waves and context-preserving fix loops`, which this branch's
base (`95b3bf9`) already contains.

Two PRs stacked on #148:

- **#149** ("fix(codex): honor canonical thread ceiling") — also closed
  unmerged; its content landed independently via `fed5177` (`fix(codex): honor
  canonical thread ceiling`) and `cb1b3fc` (`fix codex thread ceiling
  ownership contracts`), both verified ancestors of this branch.
- **#151** ("eval(codex): benchmark native review shadow") — closed unmerged,
  **correctly**: the PR's own paid shadow benchmark rejected adoption (0/10
  schema-valid outputs, `acceptancePassed=false`) and explicitly prohibited a
  production routing change. Nothing from this eval branch belongs on `main`;
  this run does not rerun the benchmark — the historical rejection stands as
  recorded.

This document proves, with tests run against the current tree, that #148's
three success criteria hold today, and records the #149/#151 conclusions
already established in `open-pr-branch-reconciliation.json`.

## Claim → test map

| # | Claim (from the item) | Child PR | Test(s) | Result |
|---|---|---|---|---|
| 1a | Worktree-path validation rejects an **absent** path before Codex execution | #148 | `test/codex-live-wave.test.js:165` "runCodexWave rejects absent worktree paths before Codex execution" | PASS |
| 1b | Worktree-path validation rejects a **wrong** (nested/non-root) path before Codex execution | #148 | `test/codex-live-wave.test.js:170` "runCodexWave rejects a nested/wrong path instead of silently accepting its parent worktree" | PASS |
| 1c | Worktree-path validation rejects the **base-checkout** path before Codex execution | #148 | `test/codex-live-wave.test.js:177` "runCodexWave rejects the base checkout before Codex execution" | PASS |
| 1d | Worktree-path validation rejects an existing but **unregistered** worktree path before Codex execution | #148 | `test/codex-live-wave.test.js:182` "runCodexWave rejects an existing but unregistered worktree path before Codex execution" | PASS |
| 1e | (bonus, same admission gate) a registered path whose `.git` pointer is swapped to a sibling worktree, and symlink-equivalent duplicate worktrees | #148 | `test/codex-live-wave.test.js:190,197` | PASS |
| 2 | 2 concurrent writers stay isolated in their own registered worktrees (deterministic fixture, no live model calls, no real Codex spawns) | #148 | `test/codex-live-wave.test.js:213` "runCodexWave keeps two concurrent conflicting writers isolated in registered worktrees" — two `mkdtemp` git worktrees, a fake `codex` shell shim (no network, no real Codex process), asserts both workers start before either completes and no worker observes the other's ambient env secret | PASS |
| 3 | Canonical thread ceiling is honored (child #149's promised behavior) | #149 | `test/codex-canonical-thread-ceiling.test.js` (14 tests, install/reinstall/uninstall ceiling ownership) + `test/codex-live-wave.test.js:599,619` (`effectiveWaveCeiling` bounds by desired/configured/available) | PASS |
| 4 | Native-review shadow routing stays DISABLED (child #151's rejected benchmark must not be re-adopted) — structural/config assertion, benchmark not rerun | #151 | `test/codex-exec-lane.test.js` "native Codex review remains shadow-only after the failed benchmark" (`resolveCodexReviewRouting()` returns `nativeReviewEnabled: false` even when `requestNativeReview: true` is requested) + `test/codex-live-wave.test.js:934` (generated orchestrator instructions assert `/native-review shadow benchmark rejected adoption/`) + `test/codex-dispatch-module.test.js` "native-review shadow routing stays disabled: no doc drift, no production wiring" (new — see Finding below) | PASS |

## Finding: stale comment in `src/codex-dispatch.js` (fixed this run)

`src/codex-dispatch.js` carries its own copy of the `codexReviewCall` packet
builder (from the `split Codex dispatch module` commit, `4cc019c`,
2026-07-30), predating #151's benchmark rejection. Its comment claimed the
native reviewer "**Replaces** muster's hand-dispatched reviewer for the diff
leg specifically" — the exact opposite of the now-recorded reality. Neither
module's `codexReviewCall` (nor `resolveCodexReviewRouting`) is imported by
`src/cli.js`, the only real production entry point, so **no production
behavior was ever affected** — this was a documentation landmine, not a live
routing bug. The comment now states the same benchmark-rejected reality as
`src/wave-dispatch.js`, and `test/codex-dispatch-module.test.js` pins both
modules to the shared rejection string plus the absence of any `cli.js`
import, so the two copies can never drift apart again without a failing test.

## Conclusion (matches `open-pr-branch-reconciliation.json`)

- **#148** — superseded-landed. All stated success criteria (4 worktree-path
  rejection cases, 2-writer isolation) are proven by tests on the current tree.
- **#149** — superseded-landed. Canonical thread ceiling is proven by tests on
  the current tree.
- **#151** — rejected-by-own-benchmark, correctly closed. Native-review shadow
  routing is proven structurally disabled on the current tree; the failed
  benchmark itself is not rerun.

No `gh` mutation was performed by this run (read-only throughout, consistent
with the run-scope rule). `main`/GitHub state for #148/#149/#151 is unchanged;
this document and the accompanying doc-drift fix are the only durable
artifacts.

## Receipts

Focused suite, this branch, `node --test` (Node test runner, no framework):

```
node --test test/worktree-isolation.test.js test/codex-live-wave.test.js \
  test/codex-dispatch-module.test.js test/codex-exec-lane.test.js \
  test/codex-canonical-thread-ceiling.test.js test/wave-dispatch.test.js \
  test/codex-wave-dispatch.test.js
```

```
ℹ tests 119
ℹ suites 0
ℹ pass 119
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
```

(`test/codex-canonical-thread-ceiling.test.js` requires the gitignored
`.agents/plugins` staging directory; run `node scripts/build-codex.mjs` once
first, or `npm test`'s own `pretest` hook does this automatically.)
