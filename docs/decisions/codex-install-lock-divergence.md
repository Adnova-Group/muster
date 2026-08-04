# codex-install.js's managed-scope lock vs codex-lock.js's withCodexFileLock: divergence record

- **Status:** Accepted — partial unification, full unification deferred pending a semantics decision
- **Date:** 2026-08-04
- **Item:** `codex-install-lock-unification` — "Rebuild codex-install.js's hand-rolled scope-registry
  lock (~lines 1017-1332) on codex-lock.js's withCodexFileLock and retirement primitives. Success
  criteria: at least 250 duplicated lines deleted, 0 behavior changes across lock acquisition, stale
  recovery, quarantine, and rollback fixtures; install and uninstall suites green."
- **Driven by:** `codex-install-lock-unification`

## Conclusion

**A wholesale swap of `acquireScopeLock`/`withScopeRegistryTransaction` onto `withCodexFileLock` is
not a safe, behavior-preserving refactor**, and therefore cannot reach the ≥250-line deletion target
without a deliberate semantics decision this item's dispatch did not authorize. Both lock
implementations are deliberately, not accidentally, different protocols — each with its own passing
test suite pinning the exact points where they diverge. The safe subset actually landed in this item
is a 2-line, zero-risk dedup: `sameInode` (byte-identical) and `pause` (functionally identical,
differing only in its parameter name) are now exported from `codex-lock.js` and imported by
`codex-install.js` instead of being duplicated
(`src/codex-install.js` net -2 lines: 3592 → 3590). Verbatim counts confirming zero behavior change
are in **Verification** below.

## The six divergence points

Characterized by reading both implementations side by side plus their test suites before making any
change. Each point below is load-bearing: swapping it out for `withCodexFileLock`'s behavior would
turn a currently-passing, currently-green test red.

**1. Corruption handling is fail-closed vs fail-open.**
`codex-install.js`'s `parseScopeLock` throws immediately (`Codex managed-scope lock is invalid`) on
malformed JSON or a malformed record, aborting the whole install with nothing written. Asserted by
`test/codex-install-scopes.test.js:250-253` (the `"not-json\n"` fixture: install rejects with
`/lock.*invalid|invalid.*lock/i`, and no `.codex` directory or manifest is ever created).
`codex-lock.js`'s `readLock` instead returns `{ record: null }` on parse failure and lets staleness
logic decide later — fail-open, eventually reclaimed once the age threshold passes. Swapping would
convert an immediate, loud abort into a silent, delayed reclaim.

**2. Live-owner hard expiry is the opposite design choice.**
`codex-install.js`'s `staleScopeLock` enforces a hard cutoff (`age >= SCOPE_LOCK_MAX_STALE_MS`,
15 minutes) that reclaims even a live, correctly-identified owner once the lock is old enough.
Exercised by `test/codex-install-scopes.test.js:341-361`, the `"hard-expiry"` case in `"Codex
reclaims forged and long-lived live-PID recovery sentinels"`: a 20-minute-old `.recover` sentinel
owned by the test's own live `process.pid` with no recorded `processIdentity` is still reclaimed.
`codex-lock.js`'s `lockIsStale` does the opposite by design — its own test is titled
`test/codex-lock.test.js:67`, `"withCodexFileLock never reclaims an exact live owner solely because
maxStaleMs elapsed"`. (`maxStaleMs` is accepted as an option but is not read inside `lockIsStale`,
which only branches on `staleMs`, liveness, and identity match.) `withCodexFileLock`'s direct
importers are `src/chatgpt-work-install.js`, `src/codex-release.js`, and `src/fs-safe.js`; Kimi
install consumes it transitively through `src/fs-safe.js`'s `withFileMutationLock` (`src/kimi-install.js`
imports `withFileMutationLock` from `./fs-safe.js`, which itself calls `withCodexFileLock` at
`src/fs-safe.js:434`). Changing `withCodexFileLock`'s core staleness rule to accommodate the scope
lock's hard cap would regress all of those callers, not just codex-install.js.

**3. The retirement-directory mode check has an escape hatch the shared primitive lacks.**
`codex-install.js`'s `assertPrivateScopeRetirementDirectory` accepts an optional `modeCapability`
callback (default `defaultScopeRetirementModeCapability`) that lets the strict-0700 requirement be
skipped on filesystems that cannot enforce POSIX mode bits, plus an `expectedStat` /
`ownerChanged` / `directoryChanged` re-pin check absent from `codex-lock.js`'s
`assertPrivateRetirementDirectory`. Exercised by `test/codex-install-scopes.test.js:363-416`,
`"Codex scope-lock retirement preserves replacement components"`, the `weakHome` branch: a
retirement directory loosened to `0o777` via the `afterRetirement` hook is rejected
(`/retirement directory/i`), and its mode bits are asserted directly (`(await
lstat(weakScopeRetirement)).mode & 0o077 === 0o077`).

**4. The two protocols use different, non-interchangeable coordination state machines.**
The scope lock coordinates recovery through a nested `.recover` sentinel lock
(`acquireRecoveryScopeLock` / `recoverStaleScopeLock`) plus a sibling quarantine file named
`${path}.muster-reclaim-<pid>-<uuid>`. `withCodexFileLock` coordinates through a
`.muster-transition` gate file (`beginTransition` / `transitionIsActive` /
`retireLockUnderTransition`) plus per-attempt `.acquire-<owner>.<token>` staging files linked into
place. These are two different on-disk state machines, not two parameterizations of the same one —
there is no mechanical, line-for-line correspondence between their intermediate artifacts.

**5. The public hook seams are part of the tested contract, not private test scaffolding.**
`runCodexInstall`'s `scopeLockOptions` exposes `afterAcquire`, `afterQuarantine`, `afterValidation`,
`afterRetirement`, `beforeRelease`, and `modeCapability` as named, public injection points. Each one
is pinned by a dedicated test in `test/codex-install-scopes.test.js:238-424` that asserts an exact
checkpoint inside the recovery-sentinel/quarantine dance (e.g. a replacement lock written inside
`afterQuarantine` must survive; the same inside `afterValidation`; the same inside
`afterRetirement`; a replacement inside `beforeRelease` must survive final release). `codex-lock.js`'s
equivalent seams (`__reclaimRaceHook`, `__afterReclaimValidationHook`, `__afterReleaseValidationHook`,
`__beforeRestoreHook`, and others) are private, double-underscore-prefixed, test-only, and wired to
the transition-gate dance instead. There is no way to delegate to `withCodexFileLock` from outside
and still satisfy these five tests' exact checkpoint assertions, because the checkpoints they assert
do not exist in `withCodexFileLock`'s protocol.

**6. Uninstall does not have a separate duplicated retirement path.**
The survey evidence for this item flagged `runCodexUninstall` (`src/codex-install.js:3445-3590`) as
hand-rolling "its own scope-retirement calls." On inspection this is not a second, duplicated
implementation: `runCodexUninstall` calls the same shared `withScopeRegistryTransaction(home,
uninstallScope)` that `runCodexInstall` calls (`src/codex-install.js:3578`, mirroring
`src/codex-install.js:2870`). There is no additional mechanical swap available on the uninstall side
independent of the install-side unification question above.

## Landed change (this item)

`sameInode` (`src/codex-lock.js:61`) is byte-identical to codex-install.js's private
`sameScopeLockInode`. `pause` (`src/codex-lock.js:6`) is functionally identical to codex-install.js's
private `pause` but not byte-identical: codex-lock.js's parameter is named `ms`, codex-install.js's
was named `milliseconds` — same body (`new Promise(resolve => setTimeout(resolve, <param>))`), same
behavior, different parameter name. Both are now `export`ed from `codex-lock.js` and imported into
`codex-install.js` (`sameInode` aliased to `sameScopeLockInode` at the import so all eight existing
call sites are untouched):

```js
import { pause, processAlive, processStartIdentity, sameInode as sameScopeLockInode } from "./codex-lock.js";
```

This is the only change applied. It is a pure name/import change over two identical function
bodies — no protocol behavior moves.

## Two paths to revisit full unification

Neither path was taken in this item; both require a follow-up item with an explicit scope decision,
not a mechanical refactor:

**A. Thin, parameterized shared primitives (~60-120 line reduction, no semantics change).**
Generalize `codex-lock.js`'s low-level, protocol-agnostic helpers — `assertPrivateRetirementDirectory`
(add an optional `modeCapability` / `expectedStat` parameter, defaulting to today's unconditional
strict-0700 behavior so `withCodexFileLock`'s own callers are unaffected), `privateRetirement`,
`removeRetirement` — and export them for `codex-install.js`'s scope lock to call directly, while
`codex-install.js` keeps owning its own coordination-level functions (`acquireScopeLock`,
`recoverStaleScopeLock`, `retireOwnedScopeLock`, the `.recover` sentinel, the public hook seams).
This does not touch `withCodexFileLock`'s staleness or corruption semantics at all, so divergence
points 1, 2, and 5 above are preserved unchanged. Realistic yield: on the order of 60-120 more lines
removed from `codex-install.js`, still short of 250.

**B. An explicit protocol-semantics change item.**
Pick one behavior and change it deliberately, with its own dispatch and sign-off — e.g. drop the
scope lock's hard-expiry-for-a-live-correctly-identified-owner rule (divergence point 2) to match
`withCodexFileLock`, or add an opt-in hard-expiry mode to `withCodexFileLock` itself for the scope
lock to select. Either choice is a product/security decision about lock semantics, not a
refactor, and is out of scope for a "0 behavior changes" dispatch.

## Verification (this run, on `muster/codex-install-lock-unification-20260804`)

Baseline (before any edit, `node scripts/build-codex.mjs` run once to stage `.agents/plugins/plugin`
— required before `test/codex-install-scopes.test.js` and `test/codex-install.test.js`, which fail
with an unrelated `.agents/plugins` `ENOENT` at module load otherwise):

```
$ node --test test/codex-lock.test.js test/codex-install-scopes.test.js test/codex-install.test.js
ℹ tests 115
ℹ pass 114
ℹ fail 0
ℹ cancelled 0
ℹ skipped 1
ℹ todo 0
```

After the `pause`/`sameInode` export dedup:

```
$ node --test test/codex-lock.test.js test/codex-install-scopes.test.js test/codex-install.test.js
ℹ tests 115
ℹ pass 114
ℹ fail 0
ℹ cancelled 0
ℹ skipped 1
ℹ todo 0

$ node --test test/kimi-install.test.js
ℹ tests 114
ℹ pass 114
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
```

Identical pass/fail/skip counts before and after, for both the touched suites and the other
`withCodexFileLock` consumer (Kimi install) — zero behavior change from the landed export/import
rename.

## Decision

Land the safe, zero-risk `pause`/`sameInode` export dedup and stop there for this item. Record this
document as the disposition for the ≥250-line unification target: it is not achievable without one
of the two semantics decisions in **Two paths to revisit full unification**, and neither is
authorized by this item's "0 behavior changes" success criterion.

## Consequences

- `src/codex-install.js`'s managed-scope lock remains its own, still-owned implementation (as
  `test/codex-install-scopes.test.js:281-284` already documented before this item started), not a
  thin wrapper over `withCodexFileLock`.
- No functional/behavioral code changes beyond the export rename; both touched suites and the
  adjacent Kimi install suite stayed at their exact pre-change pass/fail/skip counts.
- A follow-up item pursuing path A or path B above should cite this document rather than
  re-deriving the six divergence points from scratch.
