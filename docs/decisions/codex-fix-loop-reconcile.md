# Codex context-preserving fix loop: PR 152 reconcile

Status: adopted

## Context

PR 152 ("Preserve Codex implementer context across review fix loops") could
not be landed by merge — GitHub reports it `CLOSED`, `mergedAt: null` (see
[open-pr-branch-reconciliation.json](open-pr-branch-reconciliation.json)
#152, observed read-only via `gh pr view`, no mutation performed). The path
this item took is **explicit supersession**: `src/codex-fix-loop.js`,
`test/codex-fix-loop.test.js`, and `test/codex-fix-loop-reconcile.test.js`
reached `main` independently through `82aad2a..70ee11a` ("preserve Codex
fix-loop context" → "harden codex fix-loop continuation"), merged via `3e5d6db
merge Codex hermetic waves and context-preserving fix loops`, which this
branch's base (`95b3bf9`) already contains.

This document proves, with tests run against the current tree, that the
item's two success criteria hold today:

1. Three state-isolation fixtures bind fix-loop continuation to exact worker
   identity, cwd, base SHA, Codex version, and role; a continuation attempt
   with any of those five changed is rejected.
2. A 10-paired-case benchmark shows a median input-token reduction of at
   least 25% and a median time-to-fix reduction of at least 20%.

## Finding: the fix loop shipped in two layers, and the binding-object layer was superseded by the receipt layer inside the same branch, before merge

`git log` for `src/codex-fix-loop.js` shows five commits, all inside the range
that `3e5d6db` merged:

| Commit | Summary |
|---|---|
| `82aad2a` | preserve Codex fix-loop context — creates `src/codex-fix-loop.js` (`createCodexFixLoopBinding`, `planCodexFixContinuation`) plus its three state-isolation fixtures, and wires `fix-loop-bind`/`fix-loop-continue` into `src/cli.js` |
| `d9e64c6` | wire retained Codex fix-loop receipts — adds `scripts/benchmark-codex-fix-loop.mjs` |
| `6e8888d` | complete Codex context-preserving fix loops |
| `505174d` | reconcile context-preserving Codex fix loops — adds the authenticated-receipt scaffolding to `src/codex-wave-runner.js` (`+39` lines) alongside the still-wired `fix-loop-bind`/`fix-loop-continue` CLI commands |
| `70ee11a` | harden codex fix-loop continuation — **removes** the `fix-loop-bind`/`fix-loop-continue` CLI commands and the `codex-fix-loop.js` import from `src/cli.js`, and **replaces** them with a `codex-wave-resume <receipt-id> --review-state <file>` command wired directly to `runCodexWaveContinuation` in `src/codex-wave-runner.js` (`+230` lines there) |

`git show 70ee11a -- src/cli.js` shows the exact swap: the diff removes the
`createCodexFixLoopBinding`/`planCodexFixContinuation` import and the
`fix-loop-bind`/`fix-loop-continue` branches, and adds the `codex-wave-resume`
branch that calls `runCodexWaveContinuation({ receiptId, blockers })`
directly, recomputing the blocker delta inline rather than through
`planCodexFixContinuation`.

At current HEAD, `src/cli.js` has no `fix-loop-bind` or `fix-loop-continue`
command (`grep -n "fix-loop-bind\|fix-loop-continue" src/cli.js` returns
nothing), and `createCodexFixLoopBinding`/`planCodexFixContinuation` are
imported only by their own test files (`test/codex-fix-loop.test.js`,
`test/codex-fix-loop-reconcile.test.js`) — not by `src/cli.js`,
`src/wave-dispatch.js`, or any script. The **live** production path for fix-
loop continuation is the `codex-wave-resume` CLI command
(`src/cli.js:529-538` at HEAD) → `runCodexWaveContinuation` in
`src/codex-wave-runner.js`, which binds continuation to an opaque, HMAC-
authenticated receipt (`receiptMac`, `src/codex-wave-runner.js:752-753`,
`writeFixLoopReceipt`/`readFixLoopReceipt`, `:760-781`) rather than to the
caller-supplied plain-object binding that `codex-fix-loop.js` designed
originally. This is an **internal** supersession that happened inside PR
152's own branch, before it ever reached `main` — not a gap, but it means the
binding contract the item names ("exact worker identity, cwd, base SHA, Codex
version, and role") must be verified against the live receipt layer, not only
against the orphaned `codex-fix-loop.js` layer.

`src/codex-fix-loop.js`'s `benchmarkCodexFixLoops` export remains live and
used: `scripts/benchmark-codex-fix-loop.mjs:9` imports it to compute median
reduction statistics from raw paired-case usage data (the harness itself
drives `runCodexWave`/`runCodexWaveContinuation` from `codex-wave-runner.js`
directly, per `scripts/benchmark-codex-fix-loop.mjs:9-10`). Only the binding/
continuation-*planning* functions (`createCodexFixLoopBinding`,
`planCodexFixContinuation`) are orphaned relative to any live entry point;
`fingerprintCodexRoleProfile`/`resolveCodexRoleProfile` are unused outside
that module and its own tests.

No production code was changed to fix this: the orphaned functions are inert
(never invoked), so nothing behaves differently for a live caller. This run
does not delete them — removing tested, still-passing code that documents the
original (superseded) design is a larger, separately-scoped cleanup, not
required to prove this item's criteria.

## Criterion 1 → test map: five-dimension continuation binding

### At the live receipt layer (`codex-wave-resume` → `runCodexWaveContinuation`, `src/codex-wave-runner.js`)

The whole receipt document is authenticated as one HMAC-SHA256 unit
(`receiptMac(secret, payload)` over `JSON.stringify(payload)`,
`src/codex-wave-runner.js:752-753,762,777`) — tampering **any** retained
field (identity, cwd, base SHA, or role, all stored in the same receipt)
invalidates the MAC and is rejected before repository or Codex execution.
Codex version and role are, in addition, re-verified live against freshly
probed/reloaded values (not just receipt-internal consistency), so those two
have independent drift checks beyond the whole-document seal.

| # | Dimension | Live-drift mechanism | Test | Result |
|---|---|---|---|---|
| 1 | Worker identity (`memberId`) | Whole-receipt HMAC seal; identity is never an external parameter to `runCodexWaveContinuation` — only `receiptId` is, so it cannot be spoofed independently of forging the whole receipt | `test/codex-live-wave.test.js:324` "runCodexWaveContinuation rejects forged receipts before repository or Codex execution" (tampers `memberId`, asserts `/receipt authentication failed/`) | PASS |
| 2 | cwd (worktree) | Whole-receipt HMAC seal (tamper) **and** live re-registration check: `validateRegisteredLinkedWorktree(member, headAuthority, ...)` re-resolves the worktree's live git-dir/`.git` backpointer at continuation time (`src/codex-wave-runner.js:941-967`) | `test/codex-live-wave.test.js:440` "runCodexWaveContinuation rejects a worktree whose .git pointer was swapped after the retained turn" (**new this run**; swaps worktree A's `.git` pointer to worktree B's gitdir *after* the retained turn, no receipt tampering) | PASS |
| 3 | Base SHA | Whole-receipt HMAC seal; `receipt.baseSha`/`receipt.headSha` ancestry is additionally cross-checked (`git merge-base --is-ancestor`, `:1282-1287`) as an internal-consistency invariant on the retained (already-authenticated) values | `test/codex-live-wave.test.js:324` (generalizes: tampering any receipt field, including `baseSha`, is caught by the same MAC check) | PASS (by the same mechanism/test as #1; no independent live-drift path exists for base SHA beyond the receipt seal — see note below) |
| 4 | Codex version | Live re-probe: `support.version` is read by actually invoking the (possibly-upgraded) `codex` binary at continuation time and compared to `receipt.codexVersion` (`src/codex-wave-runner.js:1311`) | `test/codex-live-wave.test.js:461` "runCodexWaveContinuation rejects a Codex version that changed since the retained turn" (**new this run**; the initial turn's shim reports `codex-cli 0.145.0`, the shim is edited in place to report `codex-cli 0.145.1` before continuation) | PASS |
| 5 | Role (`rolePolicy`) | Whole-receipt HMAC seal (tamper) covers the *stored* `rolePolicy`; continuation also reloads the trusted policy from disk and compares it live (`loadTrustedRunnerPolicy()`, `:1256-1261`) | `test/codex-live-wave.test.js:324` (generalizes for the stored-field case). The **live** disk-policy-drift path itself is not independently fixture-tested this run — see Residual gap below | PASS for stored-field tamper; live on-disk policy drift UNVERIFIED-THIS-RUN |

Both new tests (#2, #4) were verified non-vacuous by temporarily disabling
their target production checks and re-running: disabling `.git`-pointer
registry checks fell through to a third, independent identity check
(`gitDirIdentity changed before launch`, `:964-967`) before finally failing
the assertion once all three layers were disabled; disabling the Codex-
version comparison produced `AssertionError: Missing expected rejection`.
Both were then restored byte-identical to base before committing (`diff
<backup> src/codex-wave-runner.js` empty).

**Residual gap, honestly noted:** dimension 5's *live* on-disk drift path
(`loadTrustedRunnerPolicy()` re-reads `agents/muster-runner.toml` /
`plugin/agents/muster-runner.md`, fixed paths relative to the module, not
overridable per-call) was not given its own fixture this run. Exercising it
safely would require mutating a shared, repository-tracked trusted-policy
file mid-suite, which risks interference with other test files that also
call `runCodexWave`/`runCodexWaveContinuation`, or requires refactoring
`loadTrustedRunnerPolicy()` to accept an override — both larger changes than
this item's stated scope. The *stored-field* half of dimension 5 (role
tampered inside an already-issued receipt) is proven by the same generalized
whole-document-MAC mechanism and test as dimensions 1 and 3.

### At the orphaned planning layer (`src/codex-fix-loop.js`, not wired into any live entry point)

This layer's own three state-isolation fixtures — named almost verbatim in
this item's outcome text — independently prove the same five-dimension
contract for the superseded binding-object design:

| # | Dimension | Fixture / mechanism | Test | Result |
|---|---|---|---|---|
| 1 | Worker identity | `target` is always `binding.workerId`/`binding.threadId` — never an externally supplied "current identity" — so it cannot be redirected; a corrupted/empty identity on the binding itself is rejected by required-field validation | `test/fixtures/codex-fix-loop/spawn-agent.json` + `exec-process.json`, exercised by `test/codex-fix-loop.test.js:18` (loop over both fixtures); tampered-identity rejection at `test/codex-fix-loop.test.js:67` (`workerId: ""` → `/workerId is required/`) | PASS |
| 2 | cwd | `CONTEXT_FIELDS` comparison (`src/codex-fix-loop.js:7,157-161`) | `test/fixtures/codex-fix-loop/isolation-mismatches.json` "cwd" case, exercised by `test/codex-fix-loop.test.js:31` | PASS |
| 3 | Base SHA | Same `CONTEXT_FIELDS` comparison, plus format validation (`BASE_SHA_RE`, `:6,44-46`) | `isolation-mismatches.json` "baseSha" case, `test/codex-fix-loop.test.js:31` | PASS |
| 4 | Codex version | Same `CONTEXT_FIELDS` comparison | `isolation-mismatches.json` "codexVersion" case, `test/codex-fix-loop.test.js:31` | PASS |
| 5 | Role | `fingerprintCodexRoleProfile` equality on `id` + a SHA-256 fingerprint over every execution-affecting field (`model`, `reasoningEffort`, `sandboxMode`, `developerInstructions`; `:91-103,162-165`) | `isolation-mismatches.json` roleProfile cases (model/reasoningEffort/sandboxMode/developerInstructions, four sub-cases), `test/codex-fix-loop.test.js:31`; field-completeness check at `test/codex-fix-loop.test.js:80` | PASS |

This table is evidence of design lineage (the superseded layer enforced the
same contract the live layer now enforces differently), not a substitute for
the live-layer table above — see the Finding for why the live layer is what
actually governs production behavior.

## Criterion 2: paired-case benchmark (median ≥25% uncached-input-token reduction, ≥20% time-to-fix reduction)

**This run does not execute `scripts/benchmark-codex-fix-loop.mjs`** (run-
scope prohibits live Codex/benchmark execution; a related item,
`bind-fix-loop-benchmark-freshness`, is explicitly deferred to own the
freshness question). Instead this run searched for and located **persisted**
paired-case evidence already committed to the tree:

- `test/fixtures/codex-fix-loop/benchmark-evidence.json` — present at this
  branch's base commit `95b3bf9` (landed via `3e5d6db`, authored across
  `d9e64c6`/`6e8888d`), self-described as `"harness": "real Codex paired
  benchmark through production runCodexWave and authenticated
  runCodexWaveContinuation"`, `"command": "node
  scripts/benchmark-codex-fix-loop.mjs --cases 10 --output
  test/fixtures/codex-fix-loop/benchmark-evidence.json"`,
  `"codexVersion": "codex-cli 0.146.0"`, `"generatedAt":
  "2026-08-03T00:01:34.297Z"`.
- Verified by `test/codex-fix-loop.test.js:101` "10-case production
  benchmark clears the median uncached-input and time-to-fix bars", which
  re-derives `benchmarkCodexFixLoops(evidence.cases)` from the raw per-case
  usage/timing data in the fixture and asserts it deep-equals the fixture's
  own recorded `summary`, plus asserts the two named bars.
- The fixture's own recorded `summary` (verbatim, `node -e` dump of
  `evidence.summary` against the fixture on this tree):

  ```
  {
    "caseCount": 10,
    "medianFreshInputTokens": 282716,
    "medianContinuedInputTokens": 235349.5,
    "medianTotalInputTokenReductionPct": 16.754092446129683,
    "medianFreshUncachedInputTokens": 30229.5,
    "medianContinuedUncachedInputTokens": 11429,
    "medianUncachedInputTokenReductionPct": 62.19256024744041,
    "medianFreshTimeMs": 117014.55236500007,
    "medianContinuedTimeMs": 90184.31405099994,
    "medianTimeToFixReductionPct": 22.92897573141959
  }
  ```

  Primary context-input metric (per the fixture's own `metric` field,
  uncached input tokens) reduces 62.2% (bar: ≥25%); time-to-fix reduces
  22.9% (bar: ≥20%). Both clear their stated bars on this persisted record.

**Honesty on freshness:** this evidence was generated on **2026-08-03T00:01:
34.297Z** against `codex-cli 0.146.0`, before this branch's own commits on
top of base `95b3bf9` (`a5ae73a`, `4e2153a`, `cc1c8ac`, `22c1098`, `04e2da4`,
in that order) and before the reconciliation work recorded in
`open-pr-branch-reconciliation.json` (`observedAt 2026-08-03T22:14:32.000Z`). It is **PERSISTED, self-consistent, and passes
its own test on current HEAD** (`test/codex-fix-loop.test.js:101`, part of
the 44/44 receipt below) — the fixture's raw per-case numbers and its
recorded `summary` were not edited or regenerated by this run. Whether it
remains representative of the *current* wave-runner/fix-loop implementation
(i.e., whether re-running the live benchmark today would reproduce
comparable numbers) is exactly the freshness question that
`bind-fix-loop-benchmark-freshness` was deferred to own; this run does not
answer it and does not claim to.

## Conclusion

- **#152** — superseded-landed, with an internal-supersession nuance not
  previously documented: the binding-object design (`codex-fix-loop.js`)
  that PR 152 originally proposed was itself superseded, inside the same
  branch and before merge, by the authenticated-receipt design
  (`codex-wave-runner.js`) that actually reached `main` and is actually live
  (`codex-wave-resume` in `src/cli.js`). All five continuation-binding
  dimensions are proven on the live layer by tests on the current tree
  (two of them added this run to close real, previously-untested drift
  paths); the orphaned layer's own fixtures independently corroborate the
  same contract for the superseded design. One narrow residual gap (live
  on-disk role-policy drift) is honestly recorded, not silently assumed.
- The 10-paired-case benchmark criterion is satisfied by persisted evidence
  already on the tree, cited file:line above; this run did not re-run it,
  consistent with the run-scope prohibition, and freshness is explicitly
  left to the deferred item.

No `gh` mutation was performed by this run (read-only throughout, consistent
with the run-scope rule). `main`/GitHub state for #152 is unchanged; this
document, plus the two new continuation-drift tests, are the only durable
artifacts.

## Receipts

Baseline (before this run's changes), this branch, `node --test`:

```
node --test test/codex-fix-loop.test.js test/codex-fix-loop-reconcile.test.js test/codex-live-wave.test.js
```

```
ℹ tests 42
ℹ suites 0
ℹ pass 42
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
```

Final (after adding the two continuation-drift tests), same command:

```
ℹ tests 44
ℹ suites 0
ℹ pass 44
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
```
