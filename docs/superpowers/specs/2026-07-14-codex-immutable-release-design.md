# Codex Immutable Release Design

## Status

Approved on 2026-07-14. This design replaces in-place Codex bundle publication and adds a generated subagent watch invariant. Claude source workflows remain unchanged.

## Goals

- Publish a coherent Codex plugin and its installable agent profiles as one immutable, content-addressed generation.
- Keep the public marketplace/bootstrap surface immutable during ordinary builds and select complete generations through append-only records.
- Keep a bounded current/LKG set plus any generation protected by a live consumer lease.
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

`.agents/plugins/marketplace.json` permanently names `./.agents/plugins/bootstrap/muster`. That fixed bootstrap exposes the complete skill/command/agent/MCP surface and delegates to a validated generation selected by append-only `.agents/plugins/selections/<sequence>-<generation>.json` records. The marketplace and bootstrap carry one shared content digest and are rewritten only during explicit offline bootstrap maintenance followed by a Codex restart. Normal release publication never replaces either public path.

The resolver retries transient `ENOENT`/`EACCES` cache reads, skips corrupt or incomplete newest selections, and falls back to the next complete LKG or the bootstrap's initial generation. It records a PID/start-time generation lease under `.agents/plugins/leases/` before returning a release. Retention is bounded to current plus the initial and newest prior LKG, with additional generations retained only while protected by a live lease; stale/dead leases are reclaimed. A four-generation overlap may temporarily retain a fourth live generation. npm packages include only the bounded current/LKG selector and release artifacts, not arbitrary locally leased history.

## Build and publication transaction

1. Reclaim only contained, ordinary `.muster-build-*` directories whose lease is old and whose owner PID is no longer live. Never remove another active builder's stage. Reject lease symlinks or special files.
2. Create the new staging directory before any generation work, with all subsequent reads and writes inside `try/finally` cleanup.
3. Validate every copied source root with `lstat`: paths must remain contained and every entry must be a regular file or directory. Build dependencies may be reached through the existing `node_modules` symlink, but no packaged source tree may contain a link.
4. Generate plugin and profiles together in staging.
5. Validate the staged tree and create canonical immutable metadata.
6. Move the completed release to its content-addressed path. Existing identical releases are validated and reused; conflicting content fails closed.
7. Append and sync a selector carrying the release generation plus the immutable bootstrap digest. A failed append leaves the previous selector and release usable.
8. Reclaim only releases outside the bounded current/LKG set and without a live generation lease. Published release contents are never mutated.

## Resolution and installation

A shared resolver validates the stable marketplace/bootstrap contract, selector digest, release containment, metadata, hashes, and ordinary-file topology before returning `pluginRoot` and `profilesRoot`. The cache bootstrap resolver is self-contained and imports only Node built-ins or sibling bootstrap files. `check:codex`, installers, package tests, and generated-runtime tests use the same contract. Project and user ownership manifests record generation/bootstrap/hook hashes and the exact owned hook groups; doctor compares each configured Muster group semantically exactly (event, matcher, commands, timeout, and options) before reporting hook health. A CODEX_HOME registry tracks every managed project and user scope so uninstall removes the shared plugin only after proving no managed scope remains.

Codex inventory continues to trust enabled plugin JSON for active plugin paths. The existing Codex-only strict plugin-kind marker remains in place; Claude resolution retains its original cross-lane semantics.

## Orchestration watch invariant

The generated Codex adapter, orchestrator, every primary mode, and every alias state the same invariant:

- After each `collaboration.spawn_agent`, use event-driven, wait-first continuation: call `collaboration.wait_agent` for the next event, then `collaboration.list_agents` to establish current live state. Do not replace this with polling or arbitrary sleeps.
- Record completion/failure receipts and dispatch the next dependency-eligible manifest work.
- Do not finalize while any live agent or executable manifest step remains.
- Valid stops are: all work complete; explicit approval or HUMAN-HOLD; a proven blocker; or the workflow's merge decision.
- Hooks provide lifecycle context, diagnostics, and supported policy warnings only; they cannot prove agent liveness or enforce every shell/subagent action.

## Failure behavior

- Invalid source, symlink, special file, containment escape, hash mismatch, stale-stage attack, or release conflict: fail before pointer publication.
- Selector append failure: retain the stable marketplace/bootstrap and prior complete selection.
- Bootstrap surface drift: fail closed until explicit offline maintenance and restart.
- Profile-stage failure: no selector publication, so plugin and profiles remain on the prior coherent generation.
- Early generation failure: `finally` removes staging.

## Verification

Tests cover exact old/new concurrent snapshots, forced no-directory-exchange operation, swap failure, plugin/profile coherence, stale-stage recovery, early cleanup, repeated builds/installs, npm package contents, Windows-shaped path rejection, symlink escape, generated watch invariants, mutation kills, full suite, build/check, and diff hygiene.
