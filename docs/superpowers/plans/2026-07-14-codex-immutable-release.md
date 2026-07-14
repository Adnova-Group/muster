# Codex Immutable Release Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Publish and consume coherent immutable Codex generations through a stable bootstrap plus append-only selectors, while generated workflows enforce event-driven, wait-first continuation to completion.

**Architecture:** A shared release module validates ordinary-file trees, computes canonical content hashes, publishes immutable releases, and appends a selected generation without replacing the stable marketplace/bootstrap surface. The generator builds only in staging and all consumers resolve the current/LKG selector. Codex-only generated workflows receive a common event-driven wait/list/receipt invariant.

**Tech Stack:** Node.js 20 ESM, `node:fs/promises`, SHA-256, esbuild, Node test runner.

## Global Constraints

- Never mutate a selected or previous release.
- The marketplace/bootstrap surface is stable during ordinary publication; append-only selectors are the consumer-visible generation choice.
- Reject symlinks, special files, traversal, and containment escapes.
- Preserve public commands, typed Codex inventory behavior, and Claude workflow bytes.
- Retain only bounded current/LKG generations plus live leases; expire idempotent hook-cleanup leases so a forged stale lock cannot disable the shard cap.
- Hooks are diagnostic/advisory only: they cannot prove liveness or reliably enforce every shell/subagent action.

---

### Task 1: Release contract and pointer resolver

**Files:**
- Create: `src/codex-release.js`
- Create: `test/codex-release.test.js`

**Interfaces:**
- Produces: `inspectRegularTree(root)`, `createReleaseMetadata(releaseRoot, packageVersion)`, `validateCodexRelease(releaseRoot, expectedGeneration)`, `resolveCodexRelease(repoRoot)`, and `publishCodexRelease(options)`.

- [ ] Write failing tests for canonical hashing, Windows-shaped/traversal paths, symlinks/special files, exact selector resolution, atomic selector-append failure, and coherent profile/plugin selection.
- [ ] Run `node --test test/codex-release.test.js`; expect failures because the module is absent.
- [ ] Implement strict `lstat`/containment validation, canonical metadata, immutable release validation, and append-only selector publication.
- [ ] Re-run the test; expect all cases to pass.
- [ ] Mutate containment and pointer-before-validation gates; confirm the focused suite fails, then restore.

### Task 2: Staged content-addressed generator

**Files:**
- Modify: `scripts/build-codex.mjs`
- Modify: `.agents/plugins/marketplace.json`
- Generate: `.agents/plugins/releases/<sha256>/**`
- Test: `test/codex-build-repro.test.js`

**Interfaces:**
- Consumes: Task 1 release functions.
- Produces: one validated selected release containing `plugin/`, `profiles/`, and `release.json`.

- [ ] Replace the current race test with failing exact-old/exact-new single-file and multi-file snapshot assertions, plus early-cleanup, stale-stage, symlink escape, repeated-build, and forced no-exchange cases.
- [ ] Run the focused test; verify partial/mixed-generation and layout failures.
- [ ] Generate exclusively in sibling staging inside `try/finally`, validate all copied sources, publish the immutable release, then append its selector without replacing the stable bootstrap.
- [ ] Re-run focused tests and `npm run build:codex`; expect green.
- [ ] Reintroduce live mutation and pointer-before-validation mutants; confirm failures, then restore.

### Task 3: Selected-generation consumers and packaging

**Files:**
- Modify: `src/codex-install.js`
- Modify: `scripts/check-codex.mjs`
- Modify: `test/codex.test.js`
- Modify: package-content tests or add `test/codex-package.test.js`

**Interfaces:**
- Consumes: `resolveCodexRelease(repoRoot)`.
- Produces: installer/check/package behavior tied to one selected generation.

- [ ] Write failing tests for project/user installs, repeated install, rollback, selected profile/plugin coherence, npm pack contents, and local/Windows-shaped marketplace paths.
- [ ] Run focused installer/check tests; expect old `codex/agents` and legacy plugin assumptions to fail.
- [ ] Resolve plugin and profiles through the pointer in installer and check logic; preserve ownership/uninstall behavior.
- [ ] Update hard-coded generated-plugin test paths to use the resolver.
- [ ] Run Codex integration tests, `npm run check:codex`, and `npm pack --dry-run --json`; expect green and no staging paths.

### Task 4: Generated watch-to-completion invariant

**Files:**
- Modify: `codex/skill-adapter.md`
- Modify: `scripts/build-codex.mjs`
- Modify: `scripts/check-codex.mjs`
- Modify: `test/codex.test.js`
- Generate: selected release workflow files.

**Interfaces:**
- Produces: a common watch protocol in the adapter, orchestrator, eight primary modes, and three aliases.

- [ ] Write failing checks requiring event-driven, wait-first `collaboration.wait_agent`, `collaboration.list_agents`, receipt recording, next-eligible dispatch, completion refusal, valid stops, and advisory-hook wording in every generated surface.
- [ ] Run focused checks and observe missing-invariant failures.
- [ ] Add the Codex-only adapter text and generator transformations without editing Claude commands or skills.
- [ ] Rebuild and re-run checks; expect all surfaces to pass.
- [ ] Remove one stop gate and confirm the invariant test fails, then restore.

### Task 5: Final verification and commit

**Files:**
- Modify: `docs/qa/RUNBOOK.md`
- Record: git note or the approved wave `STATE` artifact.

**Interfaces:**
- Produces: reviewed commit and evidence receipt.

- [ ] Run focused release/build/install/watch tests and record raw counts.
- [ ] Run `npm run build:codex`, `npm run check:codex`, `npm test`, and `git diff --check`.
- [ ] Confirm Claude source workflow hashes are unchanged and no `.muster-build-*` remains.
- [ ] Append RED/GREEN/mutant/full-suite evidence to a git note or the approved wave STATE artifact.
- [ ] Commit product, generated release, tests, spec, and plan; exclude `.muster` and `node_modules`.
