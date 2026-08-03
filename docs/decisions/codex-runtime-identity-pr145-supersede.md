# PR 145 (Codex MCP Node runtime pin): explicit supersede, not a gap

- **Status:** Accepted — explicit supersede
- **Date:** 2026-08-03
- **Item:** `codex-runtime-identity-reconcile` — "Land or explicitly supersede PR 145 and pin
  trusted Node and Codex executable identities. Linux and Windows fixtures with fake
  PATH-precedence binaries must execute no shadow binaries, 100% of generated host overlays
  must use canonical executables, and doctor must verify the same identities and Codex
  version."
- **Driven by:** `codex-runtime-identity-reconcile`
- **Corrects:** `docs/decisions/open-pr-branch-reconciliation.md` / `.json` (commit `a5ae73a`),
  which classified PR 145 as `landedOnMain: false` / "genuine gap." That classification is
  **wrong** — see evidence below. This document is the "fresh backlog item" that reconciliation
  doc's own text asked the dispatcher to raise for PR 145; the finding on arrival is that no
  implementation work remains, only the explicit supersede record itself.

## Conclusion

**PR 145 is explicitly superseded, not landed.** Its own branch is terminal on GitHub (closed
2026-08-03T01:32:20Z, `merged_at: null`, never reopened or merged by this or any run). Every
guarantee PR 145's description promised is independently present on `main` today, verified more
thoroughly than PR 145's own diff, via a different implementation that landed under commit
`375c18687fe6d09fd0ad4b578b473f3c3f1e7f2e` ("integrate Codex runtime identity and strict config
work", 2026-08-02T17:52:40-04:00) — itself an ancestor of `95b3bf9`, the very base commit the
`a5ae73a` reconciliation run measured PR 145 against. **The superseding code already existed at
the moment reconciliation searched for it; the search missed it.**

## Why reconciliation missed it (methodology gap, not a code gap)

`open-pr-branch-reconciliation.json`'s rationale for PR 145 says: `test/codex-mcp-node-pin.test.js`
(the literal filename PR 145's own description cited) is absent, and "no MCP-entrypoint-specific
pin export (e.g. MCP_ENTRYPOINT/mcpEntrypoint/nestedLaunch pin) exists in `src/`." Both statements
are true and both are irrelevant — the actual implementation uses different names:

| PR 145 promised | Landed as (different name) | Where |
|---|---|---|
| MCP entrypoint Node pin | `codexMcpOverlay(nodeExecPath)` | `src/codex-runtime-identity.js:98-101` |
| Trusted Codex/Node identity resolution | `resolveCodexRuntimeIdentity(...)` | `src/codex-runtime-identity.js:44-91` |
| Pinned-identity command execution | `runCodexCommand(execFile, identity, args, options)` | `src/codex-runtime-identity.js:93-96` |
| Doctor verifies MCP Node pin | `codex-runtime` check | `src/codex-doctor.js:887-926` |
| Doctor verifies Codex identity + version | `codex-runtime-identity` check | `src/codex-doctor.js:818-830` |
| Its own fixture test file | `test/codex-runtime-identity.test.js` (not `test/codex-mcp-node-pin.test.js`) | 13 tests |

A literal filename/export-name grep (what the reconciliation run appears to have done) returns
nothing; reading the actual `.mcp.json`-writing and doctor-checking code returns full coverage.

## Evidence: each item criterion verified against current code

**1. "100% of generated host overlays must use canonical executables."**

Both Codex MCP overlay generation sites call the same `codexMcpOverlay(nodeExecPath)`, which
resolves the Node executable through `canonicalRegularFile` (realpath + regular-file check, never
a PATH lookup):
- Top-level dev-mode `.mcp.json` — `src/codex-install.js:2814`
  (`atomicWriteSafe(join(root, ".mcp.json"), JSON.stringify(codexMcpOverlay(nodeExecPath), ...))`)
- Published plugin `.mcp.json` — `scripts/build-codex.mjs:907` inside `buildCodexPluginOnce`

The lifecycle-hook overlay (`hooks.json`, the pin the reconciliation doc already correctly
credited to PR 145's narrower sibling) pins the same way in `src/codex-install.js` and is proven
exhaustive — "every emitted event" — by `test/codex-hook-node-pin.test.js:37-65` and
`test/codex-runtime-identity.test.js`'s `"Codex install invokes only the pinned runtime and emits
canonical Node in every hook overlay"` test (asserts `calls.every(call => call.file ===
identity.node)` across every install-time Codex CLI invocation, not just one sampled call).

No bare `"node"`/`"codex"` command string reaches `execFile`/`spawn` anywhere in the Codex
surfaces: `grep -rn 'execFile(\|spawn(' src/codex*.js scripts/build-codex.mjs
scripts/check-codex.mjs mcp/codex-server.mjs` (run 2026-08-03) returns only calls through
`runtimeIdentity.node`/`identity.node`/`identity.codex`/`identity.nativeCodex` or injected test
placeholders (`INJECTED_CODEX_RUNNER`, `"muster:injected-codex-runner"`).

**2. "Linux and Windows fixtures with fake PATH-precedence binaries must execute no shadow
binaries."**

`test/codex-runtime-identity.test.js:43-61` runs a parameterized
`${platform}: fake PATH-precedence Codex is never executed and the trusted package entrypoint
runs under canonical Node` test for both `linux` and `win32`. The fixture (`fixture()`,
lines 20-41) plants a PATH-precedent shadow `codex`/`codex.cmd` that writes a marker file if
executed, then asserts `resolveCodexRuntimeIdentity` and `runCodexCommand` never touch it
(`assert.rejects(readFile(marker), /ENOENT/)`). The Linux leg runs live on this host. **The
Windows leg is fixture-level, not live** — it is skipped when `process.platform !== "win32"`
(`skip: process.platform === platform ? false : ...`) and exercises the same in-process
resolution logic (`resolveCodexRuntimeIdentity`, path-shape only: `codex.exe`,
`x86_64-pc-windows-msvc`/`aarch64-pc-windows-msvc` triples) rather than a live Windows binary —
stated here honestly per this item's own instruction, not claimed as a live Windows run. This is
also the exact same pattern `test/codex-path-shadow.test.js` uses independently for the `muster`
binary itself, including a real win32 `PATH`/`PATHEXT` resolution test
(`win32-shaped PATH/PATHEXT resolution finds muster.CMD without executing it`).

**3. "Doctor must verify the same identities and Codex version."**

`src/codex-doctor.js:818-830` (`codex-runtime-identity` check): executes the pinned Codex binary
under the pinned Node (`runCodexCommand(execFile, identity, ["--version"], ...)`) and compares the
reported version against `identity.version` via `codexVersionMatches`, reporting `Node
${identity.node}; Codex ${identity.codex}; version ${identity.version}` on success. `src/codex-doctor.js:887-926`
(`codex-runtime` check): independently re-verifies the *generated MCP overlay's* Node pin — exact
document shape (`{mcpServers: {muster: {command, args, cwd}}}`, no extra servers/keys), absolute
path, realpath'd regular file, and canonical-identity match against the running Node — and fails
closed on drift (proven by `test/codex-runtime-identity.test.js`'s `"generated MCP host overlay
pins canonical Node and doctor verifies Node, Codex entrypoint, and Codex version"` test, which
also asserts a drifted/extra-server `.mcp.json` flips `codex-runtime` to `ok:false`). Both checks
are wired into `muster doctor --codex` unconditionally (`src/cli.js:1417`,
`runCodexDoctor({ root: new URL("../", import.meta.url) })` — no flag gates either check off).

## The one PR 145 diff hunk that is genuinely gone (and correctly so)

PR 145's own diff (inspected read-only via `gh pr diff 145`) rewrote a nested
`execFile("node", [CLI, ...argv])` call inside the generated MCP server bundle
(`cowork/mcp-server.codex.mjs` in PR 145's branch) to `execFile(process.execPath, ...)`. That
code path does not exist on `main` under any name — the "in-process deterministic MCP tools"
refactor (`ea2259595fcc215bd9e7cd09030df330f5a2123c`, also an ancestor of `95b3bf9`) replaced the
generated MCP server's nested-CLI-spawn architecture entirely with in-process tool execution
(`mcp/codex-server.mjs`, `mcp/in-process-worker.mjs`, `mcp/in-process-tools.mjs`); confirmed
`grep -n "execFile\|spawn\|child_process\|\"node\"" mcp/codex-server.mjs` returns nothing. There
is no nested Node spawn left to pin because the attack surface itself was removed by an unrelated
architecture change — a legitimate supersede, not an outstanding gap.

## Explicitly out of scope (not touched by this item)

`src/chatgpt-work-install.js:352` still compares its own MCP overlay's `command` against the
literal string `"node"` (`mcp?.mcpServers?.muster?.command !== "node"`). This is a **different
harness** (ChatGPT Work, which the surrounding code explicitly notes Codex never registers) with
its own generation/trust path, not part of PR 145's Codex-specific promise or this item's stated
scope (`doctor --codex` / `src/codex-doctor.js`). Flagged here for visibility, not fixed —
folding it in would be unbounded scope creep against a single narrowly-scoped item, per this
item's own "keep the change bounded to the identity-pinning surfaces" instruction. A future item
scoped to the ChatGPT Work harness should pick this up.

## Verification (this run, on `muster/codex-runtime-identity-reconcile-20260803` @ `a5ae73a`)

Run individually (see note on concurrency below):

```
node --test test/codex-runtime-identity.test.js
ℹ tests 13 / pass 12 / fail 0 / skipped 1 (win32 fixture, this host is linux)

node --test test/codex-hook-node-pin.test.js
ℹ tests 9 / pass 9 / fail 0

node --test test/codex-path-shadow.test.js
ℹ tests 7 / pass 7 / fail 0
```

Note: running all three files concurrently under a single `node --test` invocation intermittently
throws `ENOENT` on `.agents/plugins` inside `test-support/codex-helpers.js`'s module-load-time
`resolveCodexPlugin(repoRoot)` call — a pre-existing test-isolation race unrelated to identity
pinning (it reproduces identically with zero files changed on this branch, i.e. before any work
in this item). Not fixed here: out of this item's bounded scope (test-runner isolation, not
identity pinning), and each file is independently green.

## Decision

PR 145 is recorded **closed — superseded**, not reopened, not merged, no code changes required.
This document is the disposition record; no backlog re-open is warranted for PR 145 itself. The
`chatgpt-work-install.js` bare-`"node"` finding above is a candidate for a fresh, separately-scoped
backlog item if the ChatGPT Work harness is judged to need the same hardening; not raised as a new
item by this run per the same "one item per dispatch" discipline this run itself operates under.

## Consequences

- No functional/behavioral code changes in this item — the guarantee already existed, more
  completely than PR 145 itself proposed, and was already covered by an existing, passing test
  suite before this item started.
- `CHANGELOG.md` gains a dedicated `[Unreleased]` entry for the MCP Node/Codex identity pin
  (previously undocumented in the changelog — `375c186` shipped it without its own bullet, folded
  silently under the adjacent strict-config entry).
- `docs/decisions/open-pr-branch-reconciliation.md` / `.json` gain an addendum pointing here, so a
  future reader of that artifact does not re-flag PR 145 as an open gap.
