# Codex Immutable Release Design

## Status

Approved on 2026-07-14. This design replaces in-place Codex bundle publication and adds a generated subagent watch invariant. Claude source workflows remain unchanged.

## Goals

- Publish a coherent Codex plugin and its installable agent profiles as one immutable, content-addressed generation.
- Switch consumers by atomically replacing one small marketplace manifest only after complete validation.
- Keep prior generations intact for readers and rollback.
- Reject symlinks, traversal, and special files in copied sources, staged output, selected releases, and installer resolution.
- Preserve public CLI/Desktop behavior and the Codex typed-inventory fix.
- Require generated Codex workflows to watch dispatched agents and remaining executable manifest work before declaring completion.

## Release topology

The selected generation lives at:

```text
.agents/plugins/releases/<sha256>/
  release.json
  plugin/
  profiles/
```

`release.json` records format version, generation id, package version, and a sorted digest/size inventory for every regular file below `plugin/` and `profiles/`. The generation id is SHA-256 over the canonical inventory. The release directory name must equal that id.

`.agents/plugins/marketplace.json` is the single consumer-visible pointer. Its plugin source path names `./.agents/plugins/releases/<sha256>/plugin`, and its `musterRelease` block names the same generation plus the profiles path. Codex reads the standard plugin source field; Muster installers and checks read both fields. The old `.agents/plugins/plugins/muster` tree remains untouched as a migration snapshot, but is no longer selected or generated.

## Build and publication transaction

1. Remove only contained, ordinary stale `.muster-build-*` directories. Reject stale symlinks or special files.
2. Create the new staging directory before any generation work, with all subsequent reads and writes inside `try/finally` cleanup.
3. Validate every copied source root with `lstat`: paths must remain contained and every entry must be a regular file or directory. Build dependencies may be reached through the existing `node_modules` symlink, but no packaged source tree may contain a link.
4. Generate plugin and profiles together in staging.
5. Validate the staged tree and create canonical immutable metadata.
6. Move the completed release to its content-addressed path. Existing identical releases are validated and reused; conflicting content fails closed.
7. Write and validate a complete sibling marketplace manifest, sync it, then atomically rename that one file over the pointer. A failed swap leaves the previous pointer and release intact.
8. Never mutate or garbage-collect a published release during build.

## Resolution and installation

A shared resolver validates the marketplace pointer, release containment, metadata, hashes, and ordinary-file topology before returning `pluginRoot` and `profilesRoot`. `check:codex`, `runCodexInstall`, package tests, and generated-runtime tests use this resolver. Project and user profile installation copy only from the selected generation. Profile ownership manifests and uninstall behavior remain unchanged.

Codex inventory continues to trust enabled plugin JSON for active plugin paths. The existing Codex-only strict plugin-kind marker remains in place; Claude resolution retains its original cross-lane semantics.

## Orchestration watch invariant

The generated Codex adapter, orchestrator, every primary mode, and every alias state the same invariant:

- After each `collaboration.spawn_agent`, enter a watch/receipt loop using `collaboration.wait_agent`, then `collaboration.list_agents` to establish current live state.
- Record completion/failure receipts and dispatch the next dependency-eligible manifest work.
- Do not finalize while any live agent or executable manifest step remains.
- Valid stops are: all work complete; explicit approval or HUMAN-HOLD; a proven blocker; or the workflow's merge decision.
- Hooks provide diagnostics only and cannot prove agent liveness.

## Failure behavior

- Invalid source, symlink, special file, containment escape, hash mismatch, stale-stage attack, or release conflict: fail before pointer publication.
- Pointer replacement failure: retain the old pointer and both immutable releases.
- Profile-stage failure: no pointer publication, so plugin and profiles remain on the prior coherent generation.
- Early generation failure: `finally` removes staging.

## Verification

Tests cover exact old/new concurrent snapshots, forced no-directory-exchange operation, swap failure, plugin/profile coherence, stale-stage recovery, early cleanup, repeated builds/installs, npm package contents, Windows-shaped path rejection, symlink escape, generated watch invariants, mutation kills, full suite, build/check, and diff hygiene.
