# Codex Install Ownership Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Serialize managed-scope ownership for Codex install and uninstall without changing unrelated lifecycle behavior.

**Architecture:** `src/codex-install.js` will transact `CODEX_HOME/muster/install-scopes.json` under an exclusive, validated lock, rereading it inside the lock before writes or plugin removal. Its Windows command formatter will translate only WSL-drive and native Windows forms, preserving ordinary POSIX spelling.

**Tech Stack:** Node.js ESM and the Node test runner.

## Global Constraints

- Work only in this isolated checkout, on `replay/codex-install-ownership`.
- Limit changes to the installer, focused tests, this plan, and a commit-note receipt.
- Use TDD: observe every new behavior test fail before production changes.
- Dry-run must not create, replace, or remove the lock or registry.
- Invalid, live, non-regular, symbolic, malformed, or ownership-mismatched locks fail closed.

---

### Task 1: Lock the registry transaction

**Files:**

- Modify: `test/codex.test.js`
- Modify: `src/codex-install.js`

- [ ] Add focused failing tests proving parallel installs retain all project entries; parallel uninstalls issue only one final plugin removal; valid expired lock recovery works; dry-runs write no lock/registry.
- [ ] Run `node --test --test-name-pattern='concurrent|stale managed-scope lock|ownership dry-runs' test/codex.test.js` and retain the expected failure output.
- [ ] Implement a minimum safe exclusive lock and `withScopeRegistryTransaction(home, action)`. Read the registry inside the lock. Keep the registry update and final removal decision in that transaction.
- [ ] Rerun the focused tests and confirm passing output.

### Task 2: Format Windows hook commands

**Files:**

- Modify: `test/codex.test.js`
- Modify: `src/codex-install.js`

- [ ] Add a failing test asserting `/mnt/c/work/...` and `C:\\work\\...` yield `C:/work/...` in `commandWindows`, while `/tmp/CaseSensitive/...` is unchanged.
- [ ] Run `node --test --test-name-pattern='commandWindows canonicalizes' test/codex.test.js` and retain the expected failure output.
- [ ] Add a formatter used only by `shellCommand()` that handles drive and WSL-drive path forms without lowercasing generic POSIX paths.
- [ ] Rerun the focused command and existing POSIX case test.

### Task 3: Verify and commit

**Files:**

- Modify: `src/codex-install.js`
- Modify: `test/codex.test.js`
- Create: Git note on the implementation commit

- [ ] In scratch, reintroduce each new transaction/path guard defect, record focused failing output, then restore the intended files byte-identically before committing.
- [ ] Run `node --test test/codex.test.js`, `npm run check:codex`, `npm test`, and `git diff --check`.
- [ ] Commit the focused files and attach the mutation receipt as a git note; report the commit SHA and clean status.
