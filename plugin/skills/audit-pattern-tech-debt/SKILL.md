---
name: audit-pattern-tech-debt
description: Hunt-list pattern skill for muster's tech-debt audit dimension -- dead exports, orphaned modules, outdated patterns, and fs-safe/trackedMkdtempSync convention drift in muster's own repo. Loaded by the audit orchestrator as a REQUIRED SKILLS binding on the tech-debt dimension task; read on demand, never dispatched standalone.
---

<!-- prompt-lint-disable ANTH-ROLE-001: reference hunt-list loaded ON DEMAND into an already
role-anchored tech-debt dispatch; a second "You are..." opener here would duplicate the persona. -->

# Audit pattern: tech-debt

**Version:** 1

Hunt-list for the **tech-debt** audit dimension (`buildAuditManifest`, `src/audit.js`, role
`tech-debt`). Covers dead code and outdated-pattern drift; its duplication half is
`audit-pattern-dead-code-duplication` (composed together on this same dimension -- see
`src/audit.js`'s `PATTERN_SKILL` map).

## Where to dig

- **Zero-reference export sweep** (the general procedure, not a one-time list): for every
  `export (const|function|class|async function) NAME` in `src/*.js`, grep the WHOLE repo --
  `src/`, `plugin/`, `docs/`, `test/`, `catalog/*.yaml`, `scripts/` -- for `NAME`. A count of 1
  (the declaration itself) means dead. Do not stop at `src/`: an export can be referenced only
  from `catalog/*.yaml` (a data-driven string id) or a generated-runtime doc.
- **Verified 2026-08-04 survey finding** (still open as of this writing -- treat as a worked
  example of the procedure above, re-verify before citing as current): `CODEX_MARKETPLACE`
  (`src/codex-install.js`), `codexInvocationConfigDirs` (`src/codex-install.js`),
  `assertRegularFile` (`src/codex-release.js`), `parseCodexTurnUsage`
  (`src/codex-wave-runner.js`), `DESKTOP_HARNESS_SURFACES` (`src/desktop-harness.js`) all traced
  zero-reference; `src/brief-lint.js` traced as a wholly orphaned module; a 4-function
  `kimi-dispatch.js` interpretation cluster and `codex-fix-loop.js`'s orphaned binding functions
  traced the same way. See backlog item `cleanup-dead-exports` for the exact success criteria (a
  contract-surface check proving 0 invocations from plugin skills, generated runtimes, or docs).
- **Convention drift sweep** (`test-tmpdir-convention` survey, 2026-08-04): `grep -rln
  "mkdtempSync" test/ | grep -v test-support` -- a raw `mkdtempSync` call site in a test file
  outside `test-support/` should be `trackedMkdtempSync`/`trackedMkdtemp`
  (`test-support/helpers.js`) instead, so a killed/timed-out run doesn't leak a temp dir.
  Historical baseline 2026-08-04: 70 raw call sites across 18 files -- that migration landed on
  `main` the same day, so the count is already stale; re-run the grep above and cite whatever it
  reports fresh rather than this historical number.
- Outdated-pattern grep: comments citing a retired mechanism ("run.md step 0b", "sprint.md",
  a pre-rename verb) -- if present, `docs/anti-patterns.md` entry #6 documents this exact failure
  class and its guard (`test/corpus-contradiction.test.js`).

## Repo-specific conventions to enforce

- `trackedMkdtempSync`/`trackedMkdtemp` (`test-support/helpers.js`) is the ONLY sanctioned way a
  test creates a scratch directory; a raw `fs.mkdtempSync`/`mkdtemp` call is tech debt even if it
  "works" today, because it skips the exit-sweep cleanup registration.
- `fs-safe.js` conventions (see `audit-pattern-security` for the full list) apply here too:
  outdated code that reads/writes files without routing through `fs-safe.js` is both a security
  AND a tech-debt finding when a newer, safer helper already exists for the exact operation.

## Known false positives to rule out

- A role/skill id used ONLY as a bare string inside `catalog/*.yaml` (never imported as a JS
  symbol) is still a real reference -- the catalog is data, resolved at runtime, not dead weight.
  Cross-reference `catalog/*.yaml`, not just `src/*.js`, before calling an id dead.
- `plugin/builtins/wsh-*`/`sp-*`/`gsd-*` content is vendored (see `vendor/manifest.yaml`) and
  intentionally NOT swept for muster-style "outdated pattern" findings -- it carries its own
  upstream provenance and update cadence (`docs/decisions/*upstream-drift*`).

## Appended patterns

- (2026-08-04, source: 2026-08-04 INCIDENT — /tmp inodes 98%, muster-init-* fixture debris 33k inodes each, "exit-sweeps never fired for killed processes"; earlier tmp-fixture-leak: 78,290 leaked dirs) SIGKILL-surviving reap coverage: enumerate every distinct temp-dir prefix (`grep -rhoE '"muster-[a-z0-9-]+-"' src/ test/ test-support/ scripts/`) and verify each is covered by an age-gated reap path (`hygiene --reap` or equivalent) that does NOT depend on the creating process exiting cleanly — exit-sweep registration alone is insufficient by proven incident. — false-positive note: prefixes only ever created under a suite that also runs an age-gated sweep are covered; verify the sweep's prefix list actually names them.
- (2026-08-04, source: live probe — plugin/skills/orchestrator/SKILL.md changed 79 times since 2026-06-01 with test/claude-parity.test.js co-changing 33 of them (42%); STATE names parity re-pins #9/#10/#13/#22 as recurring commit content) Change-coupling tax detection: run `git log --since=<window> --name-only` co-change analysis; a file pair co-changing in >40% of either's commits with no import relationship is shotgun-surgery-shaped — for guard pins, evaluate whether the pin can auto-derive instead of demanding a manual re-pin commit per prose edit. — false-positive note: a guard co-changing with its guarded artifact is the guard WORKING; only file it when re-pin commits routinely carry zero other content (pure mechanical tax).

(`muster-improver` may append further dated, evidenced entries here from run receipts, gated by
user approval; see `plugin/skills/improve/SKILL.md`.)

Report findings as a bullet list, one finding per line: severity (P0/P1/P2), location
(file:line), problem, suggested fix -- matching the audit dispatch's own return contract
(`plugin/commands/audit.md` step 3).
