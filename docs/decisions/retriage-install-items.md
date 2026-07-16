# Retriage: Codex install items against the install-time-generation layer

- **Status:** Accepted — one closed still-true, one re-opened
- **Date:** 2026-07-16
- **Items retriaged:** `codex-desktop-install`, `codex-install-thread-limits`
  (`.muster/backlog.md`, both `{pr: https://github.com/Adnova-Group/muster/pull/34}`)
- **Driven by:** `retriage-install-items`
- **Out of scope (assumption, stated up front):** `codex-native-orchestration`
  is also `{pr: .../pull/34}` and shares the same PR, but the retriaged item's
  own text names only `codex-desktop-install` and `codex-install-thread-limits`
  as the two things to verify still-true/re-open — "PR 34" appears in that
  text as the shared citation the two named items carry, not as a third item
  to retriage. This record does not touch `codex-native-orchestration`.

## Context

Both items were captured and merged (PR 34) before the codex-teardown run.
Since then: wave 1 (`1326f45`) stripped lock/lease/quarantine machinery from
Codex hooks and the release path; wave 2 (`58e4624`) replaced the committed
`.agents/plugins` payload with install-time generation (profiles/skills are
now materialized fresh from `codex/agents.manifest.json` on every
build/install, never cached); wave 3 (`af6c34e`) retiered per-agent Codex
model/effort mappings in that same manifest. `.codex/hooks.json` and
`.codex/muster/.muster-managed.json` are no longer tracked (CHANGELOG
`[Unreleased]`) — install-generated per checkout instead of committed.
A sibling retriage (`docs/decisions/retriage-audit-hardening.md`, commit
`e612c45` on `item/audit-hardening-retriage`, PR 40) separately flagged a live
gap while reviewing an unrelated burn branch: an isolated
`src/codex-thread-limits.js` module (`ensureCodexThreadLimits`/
`restoreCodexThreadLimits`) was dropped with its commit (`f2da066`, never
merged to mainline) and nothing in current code enforces Codex thread limits
at install time.

This retriage asks, for each of the two named items: is its fixed-count
promise (74 skills / 27 profiles / 21 MCP tools) and its cache-boundary
assumption still true against the install-time-generation layer, or has the
teardown invalidated it?

## Verification method (this session, on `item/retriage-install-items` @
`af6c34e`)

1. `node scripts/build-codex.mjs` (fresh regenerate) then directly counted
   the staging tree: `find .agents/plugins/plugin/skills -mindepth 1
   -maxdepth 1 -type d | wc -l` → 12; `find
   .agents/plugins/plugin/internal-skills -mindepth 1 -maxdepth 1 -type d |
   wc -l` → 62; `find .agents/plugins/plugin/agents -maxdepth 1 -type f | wc
   -l` → 27.
2. `node scripts/check-codex.mjs` — the authoritative count source
   (`src/codex.js`'s `CODEX_COUNTS`), wired into `pretest`/`prepublishOnly`,
   so this is a live-enforced invariant, not a static doc claim.
3. `node src/cli.js doctor --codex` — run against this machine's actual
   installed Codex CLI (not a fixture), including a live MCP
   `initialize`+`tools/list` handshake.
4. `node src/cli.js install codex --scope project --dry-run` — exercises the
   dry-run recovery path read-only.
5. Targeted regression re-runs for the two documented recovery flows named in
   `docs/qa/RUNBOOK.md`.
6. `grep -rn "max_threads\|max_depth" src/*.js test/*.js` — searched the
   entire source and test tree for any thread-limit enforcement or coverage.

## Counts observed vs promised

| Surface | Promised (item text) | Observed (staging count) | Observed (`check-codex.mjs`) | Observed (live `doctor --codex`) |
|---|---|---|---|---|
| Skills (public + internal) | 74 | 12 + 62 = 74 | `publicSkills: 12` + `internalSkills: 62` = 74 | n/a (doctor doesn't total skills) |
| Agent profiles | 27 | 27 `.toml` files | `agents: 27` | `"codex-agents": "27/27 generated profiles"` |
| MCP tools | 21 | n/a (not a directory count) | `mcpTools: 21` | `"codex-mcp-handshake": "initialize + tools/list returned 21/21 tools"` |

All three fixed counts still hold, verified three independent ways (static
generation, the code's own enforced invariant, and a live installed-Codex
handshake on real machine state). Verdict: **not invalidated by the teardown**
— the counts are unchanged even though the mechanism producing them moved
from a committed payload to install-time generation.

## Recovery commands re-validated

| Documented command | Source | Re-run | Observed output pattern |
|---|---|---|---|
| `muster install codex --scope project` (regenerate untracked `.codex/hooks.json`/`.muster-managed.json`) | CHANGELOG `[Unreleased]` | `install codex --scope project --dry-run` | `{"ok":true,"target":"codex","scope":"project","dryRun":true,"profiles":27,"hooks":7,"files":[...]}` — 27 profile writes staged, zero mutations under `--dry-run` |
| `muster install codex --scope project`/`--scope user` (legacy pre-0.5.x manifest migration) | CHANGELOG `[Unreleased]`, `docs/qa/RUNBOOK.md:261-262` | `node --test --test-name-pattern='legacy pre-0.5.x' test/codex.test.js` | `✔ Codex doctor gives an actionable legacy pre-0.5.x diagnostic instead of an opaque generation/hooks mismatch` — 1 pass |
| `MUSTER_BUILD_FORCE=1` rebuild escape hatch | `docs/qa/RUNBOOK.md:249-254` | `node --test --test-name-pattern='MUSTER_BUILD_FORCE' test/codex-build-repro.test.js` | `✔ buildCodexPlugin's version-only skip-if-current check can be bypassed with MUSTER_BUILD_FORCE=1` — 1 pass |
| `muster doctor --codex` (live install/hook/count coherence) | README:47, CHANGELOG `[Unreleased]` | `node src/cli.js doctor --codex` against this machine's real Codex install | `"codex-cli": "codex detected on PATH"`, `"codex-plugin": "muster 0.5.0"`, `"codex-agents": "27/27 generated profiles"`, `"codex-mcp-handshake": "...21/21 tools..."`, `"codex-hooks-overlap": "Muster hooks are installed at both project and user scopes..."` — all `ok: true` |

Every documented recovery command still works exactly as described against
the current layout; no doc text needed correction (no stale count was found
in README, CHANGELOG, `docs/qa/RUNBOOK.md`, or `website/reference/*.md` —
searched all four for `74`/`21 MCP`/`27 custom-agent`/`27 agent` and found
only the two directly-matching, still-accurate mentions in README:49 and
CHANGELOG:18).

## Per-item verdict table

| id | Verdict | Evidence |
|---|---|---|
| `codex-desktop-install` | **still-true** | Fixed counts (74/27/21) hold, verified three independent ways (see above). Cross-host install-topology coverage still present: `test/codex.test.js` covers user-scope vs project-scope install/uninstall (`:797`), install-scope reconciliation across duplicate/case-normalized scopes (`:1049`), and WSL drive-path casing vs native Windows paths (`:1315`, `:1329`, `:1379`) — at least the "2 cross-host install topologies" the item's success criteria required. The specific mechanism changed (committed payload → install-time generation, `.codex/hooks.json` now untracked/regenerated) but the item's user-observable contract — exact counts after install, documented recovery per split-state condition, Claude behavior unchanged (full suite green including `test/claude-parity.test.js`) — still holds against the new layer. No re-open needed. |
| `codex-install-thread-limits` | **invalidated-with-evidence** | Zero enforcement exists: `grep -rn "max_threads\|max_depth" src/*.js` returns nothing in any install/uninstall/config-writing path (`src/codex-install.js` has no `config.toml`/`configToml`/`globalConfig` handling at all — its only `.toml` references are the per-agent profile filename pattern, an unrelated concept). The only two `max_threads` hits in the whole test tree (`test/codex-mode-seed.test.js:106`, `test/codex.test.js:419,440`) assert generated orchestration *prose* telling the runtime to "Respect `agents.max_threads`; neither lower nor raise it" — a documentation string for the collaboration/watch protocol, not an install-time `config.toml` mutation. This independently corroborates the sibling retriage's flagged gap (`docs/decisions/retriage-audit-hardening.md`, item 6 of the disposition table, commit `e612c45`): the module that would have implemented this (`src/codex-thread-limits.js`, `ensureCodexThreadLimits`/`restoreCodexThreadLimits`) was introduced on an unrelated burn branch (`f2da066`) alongside dropped payload/Plan-Goal content and never reached mainline. Re-opened as a fresh scoped item below. |

## Decision

**`codex-desktop-install`** stays closed, still-true. No backlog or doc change.

**`codex-install-thread-limits`** is re-opened as a fresh, narrowly scoped
item (proposed line below, not written to the backlog by this runner — the
backlog stays driver-owned):

```
- [ ] Enforce Codex subagent thread limits at install time by reviving the dropped ensureCodexThreadLimits/restoreCodexThreadLimits pair against the current install-time-generation architecture: muster install codex writes or raises max_threads to at least 12 and max_depth to at least 2 in the target Codex CLI/Desktop config.toml without lowering a higher existing value or touching unrelated config. Success criteria: fresh, existing-lower, existing-higher, dry-run (zero config.toml mutations), and uninstall-restore (Muster-owned change only) cases each covered by a deterministic test; doctor reports an exact remediation message when a value falls below the floor; suite green. {id: codex-thread-limits-enforcement} {deps: none}
```

`node src/cli.js assess "<outcome above>" --codex` → `{"clear": true,
"signals": []}`.

Narrower than the original: drops the original's "split WSL/Windows" and
"repeated-install" enumerated automated-test cases as separately named
requirements (fresh/existing-lower/existing-higher/dry-run/uninstall already
cover the behavioral space; WSL-vs-Windows path handling is a pre-existing,
separately-tested concern — `commandWindows` — not specific to thread-limit
enforcement) to keep the rewritten scope honestly sized to what's actually
new.

## Consequences

- No implementation work lands in this PR beyond this decision record — the
  gap is real but is a feature-sized unit of work (new module +
  `runCodexInstall`/`runCodexUninstall` wiring + ownership-manifest handling +
  tests), correctly sized as its own item rather than folded into a retriage.
- If a future runner claims `codex-thread-limits-enforcement`, it should
  start from `docs/decisions/retriage-audit-hardening.md`'s item 6 finding and
  the dropped `f2da066` commit's `src/codex-thread-limits.js` shape as prior
  art, but re-implement fresh against current `src/codex-install.js` rather
  than attempting to cherry-pick the old commit (that commit's diff is
  entangled with unrelated dropped payload/Plan-Goal content).
- No doc corrections were needed in this PR — every count and recovery
  command checked out against current code.
