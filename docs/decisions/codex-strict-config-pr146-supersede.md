# PR 146 (Codex app-server strict-config validation): explicit supersede, not a gap

- **Status:** Accepted — explicit supersede, one test-only addition
- **Date:** 2026-08-03
- **Item:** `codex-strict-config-reconcile` — "Land or explicitly supersede PR 146's non-billable
  native strict-config validation. 100% of unknown-key and malformed-TOML fixtures must block
  installation with byte-identical rollback and file-line diagnostics, while valid config
  produces no model turns."
- **Driven by:** `codex-strict-config-reconcile`
- **Relates to:** `docs/decisions/open-pr-branch-reconciliation.md` / `.json` (commit `a5ae73a`),
  which already correctly classified PR 146 as `landedOnMain: true` / legitimately superseded by
  an independent implementation (`src/codex-strict-config.js` + `test/codex-strict-config.test.js`,
  reaching main through commits `c880cee..eb93e84`, further extended by `375c186` "integrate Codex
  runtime identity and strict config work" and `2652b64` "merge final Codex strict-config
  reconciliation," both ancestors of this branch's base). This document is the deeper,
  criterion-by-criterion verification that reconciliation's summary rationale asked a future item
  to carry out; it confirms that classification with a full test map rather than correcting it.

## Conclusion

**PR 146 is explicitly superseded, not landed.** Its own branch is terminal on GitHub (closed
2026-08-03T01:32:18Z, `merged_at: null`, never reopened or merged by this or any run — `gh` was
used read-only only, no mutation performed). Every guarantee the item's outcome text names is
independently present on `main` today via `src/codex-strict-config.js` (`runCodexStrictConfigCheck`,
`runOneStrictConfigCheck`) and its wiring into `runCodexInstall` (`src/codex-install.js:3089`,
`configParser = strictConfigRunner || (!execFile && identity ? runCodexStrictConfigCheck : null)`)
and `runCodexDoctor` (`codex-config-strict` check). One genuine composition gap was found and
closed with a single new test (no production code change) — see "One test-only addition" below.

## Criterion → test map

All tests below are in `test/codex-strict-config.test.js` on this branch, verified running at
commit `5dfeb1c` (this item's only commit). Line numbers are current as of that commit.

**1. Unknown-key fixture blocks installation.**
- Unit level, mocked native parser: `unknown keys and malformed TOML preserve native file:line
  diagnostics` (line 74) → `"unknown key"` subtest (line 79) — fake `app-server` stderr
  `Error: /tmp/config.toml:7:1: unknown configuration field \`mystery\`` rejects
  `runCodexStrictConfigCheck` with that exact diagnostic.
- Unit level, real native parser (skipped when the trusted Codex runtime is unavailable, which it
  is in this sandbox — see Verification below): `real Codex validates unknown and malformed config
  without a model turn` (line 135) — writes `unknown_muster_key = true` to a real project
  `.codex/config.toml`, runs the actual `codex app-server --strict-config` binary, asserts the
  rejection matches `<path>/.codex/config.toml:1:1: unknown configuration field`.
- Install level (three-in-one: blocks install + byte-identical rollback + file:line diagnostic in
  one test): `install validates the complete write and restores config bytes on failure` (line
  212) — runs the full `runCodexInstall` transaction with an injected `strictConfigRunner` that
  throws `${projectPath}:2:1: unknown configuration field \`future_typo\``, asserts the install
  rejects with that message, and asserts both `sharedPath` and `projectPath` bytes are
  byte-identical (`assert.deepEqual`) to their pre-install originals, plus that no partial managed
  file (`agents/.muster-managed.json`) was left behind.

**2. Malformed-TOML fixture blocks installation.**
- Unit level, mocked native parser: same test as above (line 74) → `"malformed TOML"` subtest
  (line 79) — fake stderr `Error: /tmp/config.toml:9:4: unclosed table, expected \`]\`` rejects
  with that exact diagnostic.
- Unit level, real native parser (skipped, same reason): line 135, second half — writes
  `[broken\nkey = true\n` to the real project config, runs the real binary, asserts the rejection
  matches `project config file <path>/.codex/config.toml: TOML parse error at line 1, column 8`.
- Install level (three-in-one, **added by this item** — see below): `malformed TOML fixture blocks
  install and restores config bytes exactly` (line 248).

**3. Byte-identical rollback.**
Proven generically — the install transaction's rollback path does not branch on *why* the parser
rejected a candidate, so every parser-failure test exercises the same rollback code
(`src/codex-install.js`'s `rollbackConfigCandidate` / `retainConfigArtifacts` path) regardless of
fixture kind:
- `install validates the complete write and restores config bytes on failure` (line 212, unknown-key
  content) and `malformed TOML fixture blocks install and restores config bytes exactly` (line 248,
  malformed-TOML content) both assert `assert.deepEqual(await readFile(sharedPath), sharedOriginal)`
  and the same for `projectPath`.
- Concurrency and edge variants extend the same guarantee under adversarial conditions: `rollback
  preserves malformed config bytes exactly` (line 282, invalid-UTF-8 bytes rejected before the
  parser is even invoked — `parserCalled` asserted `false`), `concurrent config replacement blocks
  success without overwriting the writer` (line 303), `a parser failure still preserves a
  concurrent config writer` (line 317), `a delayed shared-config writer during validation is
  preserved` (line 334), `candidate publication is bound to the snapshot used before validation`
  (line 352), `a retired-inode writer immediately after candidate link remains live` (line 376),
  `rollback reconstructs exact originals when retirement artifacts disappear` (line 417), `a live
  writer during staged plugin registration aborts without touching it` (line 514), `a post-commit
  writer holding the retired inode remains receipted` (line 561), `an unreceipted retirement
  artifact blocks install` (line 599), `rollback preserves a delayed writer holding the published
  candidate inode` (line 612).

**4. File-line diagnostics.**
Covered by the same tests as criteria 1 and 2 above (lines 74, 135, 212, 248) — every rejection
path preserves Codex's native `path:line:col` (unknown key) or `line N, column M` (TOML syntax)
positions verbatim in the thrown error message; `diagnostic()` in `src/codex-strict-config.js`
only strips control characters and trims, it does not rewrite positions.

**5. Valid config produces zero model turns (non-billable).**
- `valid config closes app-server stdin and emits zero model turns` (line 55) — asserts
  `{ ok: true, modelTurnEvents: 0 }`, that `app-server --strict-config --listen stdio://` is
  invoked (never a full `exec`/model-turn-capable subcommand), and that stdin is closed
  (`writableEnded === true`) without ever writing an `initialize` or `thread/start` request — the
  mechanism `src/codex-strict-config.js:155-157`'s comment documents: EOF makes app-server parse
  config and exit without a turn.
- `waits for drained streams before accepting zero model turns` (line 115) and the `model-turn
  event` / `thread notification` subtests of `parser absence, timeout, capped output, and
  model-turn events fail closed` (line 91) prove the inverse: any observed `thread/`- or
  `turn/`-prefixed JSON-RPC method or type in stdout/stderr, even after a clean exit code 0, flips
  the result to a rejection (`modelTurnEventCount` in `src/codex-strict-config.js:16-27`), so
  validation cannot silently become billable.
- `real Codex validates unknown and malformed config without a model turn` (line 135, first half)
  proves the zero-model-turn contract against the real binary for a genuinely valid config, not
  just the mocked spawn.
- `doctor reports the same non-billable parser boundary` (line 672) proves `muster doctor --codex`
  reuses the identical `strictConfigRunner` boundary (same `cwd`/`codexHome` arguments, same
  failure surfaced as `codex-config-strict` check detail) rather than a separate, potentially
  billable path.

## One test-only addition (this item's only change)

The unknown-key fixture already had a single test proving all three of "blocks install" + "byte-
identical rollback" + "file:line diagnostic" together through the **full `runCodexInstall`
transaction** (line 212). Malformed TOML had that same three-in-one proof only at the standalone
`runCodexStrictConfigCheck` level (mocked at line 74, real-binary at line 135) — genuinely never
exercised through the install transaction itself. Since `runCodexInstall`'s rollback path is
generic to any parser rejection (see criterion 3 above), there was no reason to expect this gap
to be behavioral rather than a coverage omission, and it wasn't: the added test, mirroring line
212's structure exactly with a TOML-syntax-shaped diagnostic
(`project config file <path>: TOML parse error at line 2, column 8`) instead of an unknown-key
diagnostic, passed on first run with zero production code changes — see Verification below. This
is the one commit on this branch (`5dfeb1c`, `test/codex-strict-config.test.js` only).

## Explicitly out of scope (not touched by this item)

- The `native acceptance is rejected when staged candidate bytes are mutated` (line 161) and `real
  staged registration publishes a live installed plugin cache` (line 482) tests also skip in this
  sandbox for the same reason (no trusted Codex runtime identity resolvable —
  `CODEX_MANAGED_PACKAGE_ROOT is not an absolute path`); they are pre-existing, unrelated to this
  item's fixture-composition gap, and not modified here.
- No changes to `src/codex-strict-config.js`, `src/codex-install.js`, or `src/codex-doctor.js` —
  this item found no code gap, only a test-composition gap, consistent with this run's own
  "test-only candidate is accepted when the evidence is real" guidance.

## Verification (this item, on `muster/codex-strict-config-reconcile-20260803` @ `5dfeb1c`)

Focused per-file run (`.agents/plugins` staged first via `node scripts/build-codex.mjs`, required
once per worktree before this file's real-binary-attempt tests can even reach their skip checks):

```
node scripts/build-codex.mjs
Codex plugin v0.6.0 generated at <worktree>/.agents/plugins/plugin

node --test test/codex-strict-config.test.js
ℹ tests 32
ℹ suites 0
ℹ pass 29
ℹ fail 0
ℹ cancelled 0
ℹ skipped 3
ℹ todo 0
```

Baseline (before this item's one test addition, same command): `tests 31 / pass 28 / fail 0 /
skipped 3`. The 3 skips are `real Codex validates unknown and malformed config without a model
turn`, `native acceptance is rejected when staged candidate bytes are mutated`, and `real staged
registration publishes a live installed plugin cache` — all three skip identically before and
after this item's change, each for the same reason (`trusted Codex runtime identity is
unavailable` / `trusted Codex runtime is not installed`), confirmed via
`resolveCodexRuntimeIdentity()` throwing `trusted Codex package identity is unavailable
(CODEX_MANAGED_PACKAGE_ROOT is not an absolute path)` in this sandbox. This is a sandbox
limitation (no real Codex binary installed), not a gap this item can or should close — the
mocked-parser and install-transaction tests exercise the same code paths deterministically without
a live binary, and the real-binary tests exist in the suite for environments where one is
available.

Note: running this file concurrently with other Codex test files under a single `node --test`
invocation can intermittently race on `.agents/plugins` (a pre-existing, unrelated test-isolation
issue in `test-support/codex-helpers.js`'s module-load-time `resolveCodexPlugin` call); this item
ran the file in isolation per the dispatch brief's stated constraint and observed no such race.

## Decision

PR 146 is recorded **closed — superseded**, not reopened, not merged. No further backlog item is
needed for PR 146 itself. `CHANGELOG.md` already carries a dedicated `[Unreleased]` bullet for
this surface (see the entry beginning "Codex installs now fail closed on native strict
configuration validation," landed with `375c186`/`2652b64`), so no changelog change was needed
here.

## Consequences

- One new test, zero production code changes. The install-level three-in-one proof (blocks
  install + byte-identical rollback + file:line diagnostics) now exists for both fixture kinds
  named in this item's outcome text, not just one.
- Future readers of `open-pr-branch-reconciliation.md` looking for PR 146's disposition can treat
  this document as the detailed criterion evidence backing that reconciliation's existing
  "landedOnMain: true" classification.
