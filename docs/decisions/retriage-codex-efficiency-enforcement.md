# Retriage: `codex-efficiency-enforcement` against the post-teardown architecture

- **Status:** Accepted — retired
- **Date:** 2026-07-16
- **Item retriaged:** `codex-efficiency-enforcement` (`.muster/backlog.md`, captured 2026-07-15)
- **Driven by:** `retriage-efficiency-enforcement`

## Context

`codex-efficiency-enforcement` was captured 2026-07-15 and claimed the same day
(`{claimed: codex-efficiency@2026-07-15T20:00:00Z}`), but no commit anywhere in
this repository's history references it (`git log --all --grep` for
`codex-efficiency`/`efficiency-enforcement`/`native programmatic` returns nothing)
and no decision record or implementation exists — the claiming runner died
without producing work. Its stated dependency, `{deps: lock-lifecycle-consolidation}`
(backlog line 96, PR 36), does not resolve to anything present on this branch
(`feat/codex-integration` @ `af6c34e`, this item's actual architecture context):
`git log --all --grep` finds no commit mentioning lock-lifecycle consolidation on
this lineage, and `git show 1326f45 -- src/codex-install.js` is an empty diff —
teardown wave 1 (`1326f45`, "strip lock/lease/quarantine machinery from codex
hooks and release path") touched only `src/codex-lock.js`, simplifying it to a
single create-or-fail lockfile with stale reclaim (`src/codex-lock.js:27-32`,
"a per-user Codex install does not need multi-stage crash-safe lock handoff").
`src/codex-install.js`'s own independent crash-safe quarantine/retirement dance
(`privateScopeRetirement`, `retireOwnedScopeLock`, `restoreQuarantinedScopeLock`,
`src/codex-install.js:231-375`) — the exact duplicate backlog line 96 named as
the consolidation target — is untouched and still live. Whatever PR 36 delivered
is not present as a shared primitive in this branch's tree today, so the
dependency does not point at real, resolvable work here; it is dropped as
unresolvable on this lineage rather than repointed to a nonexistent successor.

Separately, wave 2 (`58e4624`) moved Codex profile/plugin materialization from a
committed payload to install-time generation (`generateCodexProfiles`,
`src/codex-release.js:171-174`, reading fresh from the frozen
`codex/agents.manifest.json` on every install — never cached), and wave 3
(`af6c34e`) retiered per-agent Codex model/effort mappings in that same manifest
against DeepSWE v1.1 + Artificial Analysis evidence.

This retriage asks: does the efficiency contract still make sense rewritten
against that install-time-generation layer, or should it retire?

## Per-clause disposition

| # | Contract clause | Disposition | Why |
|---|---|---|---|
| 1 | Dispatch every Muster leaf through a native programmatic runner whenever the exposed collaboration schema cannot attest role/model/effort | **obsolete-with-why** | Two dispatch surfaces exist and neither has a gap to fill. Claude-side: the router skill's crew assembly already attests `provider`/`source`/`model`/`rationale`/`evidence`/`fallback` per crew member (`plugin/skills/router/SKILL.md:12`, `src/crew.js:45`) — pre-existing, untouched by the teardown. Codex-side: Codex owns its own subagent dispatch and per-call model override; muster's Cowork MCP surface says so explicitly ("plus your own subagent dispatch (parallel fan-out and per-call model override both work)", `cowork/mcp-server.mjs:57`). There is no exposed collaboration schema left for a new runner to sit in front of. |
| 2 | Fail closed on missing profiles, model fallback, rerouting, or effective-tier mismatch | **obsolete-with-why** | The detectable half is already shipped as fail-*loud*, non-blocking diagnostics, not new scope: `muster doctor --codex` reds out `codex-install-generation`/`codex-hooks`/`codex-hooks-overlap` on any installed-vs-current incoherence (CHANGELOG `[Unreleased]`), and the identical failure class for Claude-side vendored agents — "Generated-artifact model-tier drift" — is a named anti-pattern (`docs/anti-patterns.md:153-166`) with a live regression guard (`test/agents.generated.test.js`). The fail-*closed* half (blocking execution, not just reporting) is architecturally unreachable against Codex's own dispatch: Codex hooks are advisory and fail-open by explicit design, stated plainly in the hook source itself — "Codex PreToolUse hooks surface this warning but do not reliably block every unified-shell or subagent action" (`codex/hooks/muster-hook.mjs:82`), "Codex PreToolUse hooks cannot reliably deny every subagent or unified-shell action" (`codex/hooks/muster-hook.mjs:84`), and "Hooks are diagnostic and fail open. Never break a Codex session." (`codex/hooks/muster-hook.mjs:104`). This predates the teardown (CHANGELOG `[0.5.0]`: "todo and spawn enforcement remain explicitly advisory") — the teardown did not remove a working fail-closed mechanism, it never existed. Wave 1's simplification of `codex-lock.js` specifically (dropping *its* multi-stage crash-safe guarantees for a lighter single-lockfile model, `src/codex-lock.js:27-32`) shows a preference against more machinery in the one lock domain that wave actually touched — it is not evidence the architecture rejects heavier guarantees generally, since `codex-install.js`'s own independent crash-safe lock implementation was left untouched (see Context). |
| 3 | Start fresh bounded-context leaf threads with recursive delegation disabled | **obsolete-with-why** | Claude-side, this is a pre-existing mechanism unrelated to Codex or the teardown: fresh context per Task-tool dispatch, sub-dispatch depth bounded by each agent's declared tool grant. Codex-side, the same architectural constraint as clause 2 applies rather than a shipped enforcement: `codex/skill-adapter.md:5` states "Workers are leaves and must not spawn descendants unless an approved manifest explicitly delegates nested orchestration," and `codex/skill-adapter.md:24` says to "Respect the configured `agents.max_threads`; Muster must neither lower nor raise it" — both are advisory prompt-level guidance the harness follows, not a blocking mechanism muster enforces (checked directly: no `max_threads`/`max_depth`-writing code exists in `src/*.js` on this branch — the commit that adds that, `4b039b4`, lives only on the unmerged `origin/integrate/outstanding-known-issues-20260715`, not in this lineage's ancestry). So clause 3's Codex-side half is unreachable for the identical reason clause 2's fail-closed half is: nothing in this dispatch surface is muster-enforceable, and install-time generation (a build-time profile/plugin materialization step) has no attachment point for runtime thread/depth policing regardless. |
| 4 | Enforce native per-worker plus deterministic run-wide token budgets, hard timeout, and one retry | **obsolete-with-why** | No budget/timeout/retry enforcement engine exists anywhere in muster, for either Claude or Codex dispatch, before or after the teardown — nothing was torn down here, it was never built. It is also not an install-time-generation-layer concern: that layer materializes static profile/plugin files at install; budgets, timeouts, and retries are a live dispatch-loop concern with no host in this architecture to attach to. If still wanted, it is a genuinely new capability needing its own from-scratch scoped item, not a rewrite of this one. |
| 5 | Require review receipts before authoritative broad verification | **survives (elsewhere, already shipped)** | Independent of Codex or the teardown, two separately-documented facts already cover this clause's substance: the review-gate skill requires an explicit verdict before disposition, and `muster-runner`'s own lifecycle defers broad/authoritative test suites to final verification, re-reviewing every fix pass (`plugin/skills/review-gate/SKILL.md`, `plugin/agents/muster-runner.md`). No single existing rule states the clause in this exact phrasing, but the ordering it asks for is already true of the system. It "survives" the retriage as a true statement, but not as fresh work this item could deliver — there is nothing left to build or rewrite. |
| 6 | Emit exact model/tier/token/turn/retry telemetry with unequal-scope comparability flags and the substantial-regression rule (>20% and >10,000 weighted tokens over >=3 comparable runs) | **obsolete-with-why** | No telemetry emission or cross-run aggregation mechanism exists in the codebase (confirmed by search — zero implementation hits). This is greenfield infrastructure with no natural attachment point in install-time generation (a build-time step, not a metrics pipeline) and no aggregation substrate (the ">=3 comparable runs" comparability engine) to extend. Same conclusion as clause 4: new capability, new item, if ever wanted. |

## Decision

**Retire** `codex-efficiency-enforcement`, rather than rescope it.

Every clause resolves one of three ways, and none leaves a coherent residue of
net-new, install-time-generation-shaped work:

- Clause 1's Claude-side half, and clause 3's Claude-side half, restate
  attestation/isolation guarantees the system **already has**, delivered by
  pre-existing, unrelated mechanisms (crew glass-box attestation; Claude
  subagent isolation).
- Clause 5 restates a discipline the system **already enforces**
  (review-gate + `muster-runner`).
- Clauses 1's and 3's Codex-side halves, and clauses 2, 4, 6 in full, ask for
  guarantees the architecture **cannot deliver** (fail-closed/blocking control
  over Codex's own advisory-only, fail-open hook and prompt surface — the same
  root constraint recurs in every Codex-side clause) or **has never been built
  and doesn't belong at install-time generation** (budgets, timeouts, retries,
  telemetry) — these would need their own fresh item with honest new scope,
  not a rewrite of a contract whose premise (a controllable native dispatch
  runner sitting in front of Codex's collaboration schema) does not hold.

There is no rescoped text that would both (a) be genuinely new work and
(b) fit "the install-time-generation layer" as instructed — the layer only
materializes static profile/plugin files at install, and every clause that
matters at that layer is already covered by shipped mechanisms cited above.
Manufacturing a thinner rescoped item just to keep the id alive would either
duplicate existing coverage or restate an unreachable goal under new words.

**Claim released.** The stale `{claimed: codex-efficiency@2026-07-15T20:00:00Z}`
annotation is dropped — the claiming runner is dead and left no work in flight.

**Dependency reconciled.** `{deps: lock-lifecycle-consolidation}` is dropped.
As detailed in Context, whatever PR 36 delivered is not present as a shared
primitive on this branch — `codex-install.js` still carries its own
independent crash-safe lock implementation, untouched by wave 1 — so the
dependency does not resolve to real, current work here and there is no
successor primitive for a retired item to depend on either way.

## Consequences

- No implementation work follows from this item; nothing new is scoped.
- If a future need for Codex-side dispatch budgets, timeouts, or telemetry
  resurfaces, it should be captured as a fresh backlog item scoped explicitly
  against what Codex's hook/dispatch model can actually enforce (advisory
  diagnostics, not blocking control) rather than reusing this contract's text.
- The backlog line is proposed as retired (see the runner's return receipt for
  the exact old-line/new-line patch) rather than edited directly here — backlog
  edits stay with the driver.
