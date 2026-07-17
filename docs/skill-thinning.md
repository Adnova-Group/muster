# Skill content-only thinning (backlog item `skill-content-only-thinning`)

Last item in the native-delegation sequence (`docs/strategy/native-delegation.md` backlog item
11, Part D's scorecard), run after all nine sibling delegation items landed on main
(workflow-tool-delegation, codex-spawn-agent-dispatch, task-board-authoritative,
worktree-isolation-native, hermes-kanban-binding, coordination-footprint, native-plan-mode-parity,
brief-lint-coverage, cowork-plugin-loader-probe). Those items taught muster's skills to RIDE native
mechanics (Workflow/spawn_agent dispatch, per-harness worktree isolation, the native task board,
Hermes kanban) instead of hand-rolling them in prose. This item audits every one of the 11 skills
for prose that still *re-narrates* one of those now-delegated mechanics step by step, and strips
only that narration -- never the judgment (routing/escalation/gate criteria), the capability check
(which native primitive, how it's detected), or the fallback prose itself.

## Method

`eval/perf/skill-size-audit.mjs` (speed-tuning item) reads every `plugin/skills/*/SKILL.md` off
disk and reports real byte counts via `src/skill-footprint.js`'s `computeSkillFootprint`. Before
touching anything, each of the 11 was read in full and checked against one question: does this
prose *restate how a native primitive works mechanically* (redundant, since the primitive
documents itself), or does it carry judgment/capability-check/fallback (load-bearing, keep)?

## Per-skill audit (before -> after, real byte counts)

| skill | before (chars) | after (chars) | delta | verdict |
|---|---:|---:|---:|---|
| coordination | 24,438 | 24,438 | 0 (0%) | **excluded per brief** -- already cut in speed-tuning (30.6%) + coordination-footprint (a further 40.04%, two review rounds each restoring over-trimmed load-bearing clauses); at its safe re-cut floor, most remaining bulk is the three-binding protocol itself (claim-race arbitration, identity validation, hostile-input handling), not narrative. Re-cutting risks the exact over-trim its own history already had to walk back twice. |
| orchestrator | 24,429 | 22,821 | -1,608 (-6.6%) | **cut** -- the only skill the strategy doc names as still carrying a load-bearing *mechanic* that delegates (Part D: "orchestrator wave loop -> Workflow/spawn_agent/delegate_task"). Its "Wave dispatch: native Workflow vs prose fallback" / "Codex-native dispatch: spawn_agent" / "Worktree isolation per harness + base-SHA receipts" span (added across 3 prior items) narrated HOW each native tool joins/reads results step by step; that narration is redundant since the tool documents its own mechanics. See "What was cut" below. |
| review-gate | 7,344 | 7,344 | 0 (0%) | **excluded per brief** -- already cut 40.9% in speed-tuning; the "Fast-path reviewer brief" section added since is muster's OWN gate-cadence/citation-check code-backed logic, not a native-mechanic narration to strip. |
| tournament | 6,201 | 6,201 | 0 (0%) | **audited, unchanged** -- one native-dispatch declaration line ("every agent dispatch below uses the Claude Code Agent tool"); the rest is tournament's own judgment (approach diversity, de-identified scoring, fusion-map taxonomy) -- irreducible per Part C item 5, not mechanic narration. |
| interview | 5,491 | 5,491 | 0 (0%) | **audited, unchanged** -- no native-mechanic narration; this is requirements-gathering judgment (question ordering, decomposition, backlog-write format) with no dispatch/isolation/task-board prose at all. |
| router | 4,654 | 4,654 | 0 (0%) | **audited, unchanged** -- crew-composition judgment (ladder rules, specialist search, skill bindings, surface assignment); no native-mechanic narration present. |
| roadmap-prioritization | 4,371 | 4,371 | 0 (0%) | **audited, unchanged** -- domain pipeline content (RICE estimation, evidence-gathering); its GitHub issue/Project-board steps are muster's own graceful-degradation prose around `gh`, not a harness-native mechanic muster rides. |
| advisor | 3,897 | 3,897 | 0 (0%) | **audited, unchanged** -- one native-dispatch declaration line, same shape as tournament's; the budget/consult-tracking logic is muster's own judgment, not mechanic narration. |
| prd-pipeline | 1,828 | 1,828 | 0 (0%) | **audited, unchanged** -- a 5-phase pipeline pointer skill; no dispatch/isolation/task-board prose to narrate. |
| domain-router | 1,734 | 1,734 | 0 (0%) | **audited, unchanged** -- a 4-step classification skill; no native-mechanic prose present. |
| greenfield | 1,385 | 1,385 | 0 (0%) | **audited, unchanged** -- a 4-step bootstrap skill; no native-mechanic prose present. |
| **total** | **85,772** | **84,164** | **-1,608 (-1.9%)** | |

## What was cut (orchestrator/SKILL.md)

Scoped to the span from the `## Wave dispatch: native Workflow vs prose fallback` heading through
the end of `### Worktree isolation per harness + base-SHA receipts`, immediately before
`## Scope fences` -- the exact span `scripts/build-codex.mjs`'s `adaptOrchestratorForCodex` already
wholesale-replaces for the Codex build regardless of content, so editing inside it cannot desync
that build (re-verified with `MUSTER_BUILD_FORCE=1 node scripts/build-codex.mjs`).

Cut (redundant native-mechanic narration -- restates what the tool already does):
- "each task becomes one `Workflow` step naming its resolved `subagent_type`/`model`/brief, same
  resolution rules as step 4a below, let the native tool's own barrier join them, then read each
  step's result exactly once" -> the native fan-out/barrier/result-read is the tool's own
  documented behavior, not something muster's prose needs to re-derive.
- The per-harness worktree-mechanism bullets' repeated "muster scripts nothing, the harness creates
  it" / "muster only selects which invocation shape" framing, tightened to name the mechanism
  without re-explaining that it's automatic.
- Restated clauses in the Codex spawn_agent subsection ("nothing outside a running session can
  auto-probe... the same shape as... just inverted" scaffolding trimmed to the operative rule).
- The parenthetical `(agent_type may be absent from it but must be sent anyway)` in the
  fail-closed-on-a-rejected-profile paragraph -- redundant with the call signature two lines above
  (`agent_type: "<exact chosen.id>"`, already always sent) and with the identical clarifying rule
  in `docs/research/codex-cli.md` sec 6, cited in the same paragraph, and `src/wave-dispatch.js`'s
  own code comment.

Kept verbatim in meaning (judgment / capability check / fallback -- the brief's explicit floor):
- The capability-check mechanism itself: `$MUSTER_CLI wave-dispatch [--agent-teams|--no-agent-teams]`,
  the `MUSTER_AGENT_TEAMS` env fallback, DECLARED-not-auto-probed shape, default to `"prose"`.
- **"Parallel isolation is not relaxed"** -- the one safety rule a prior review-gate fix loop added
  specifically to this section (claude-parity.test.js's own history records this): a multi-file
  wave stays on the prose path even when native is declared, because per-step isolation on the
  `Workflow` tool is an unconfirmed gap. Untouched.
- AUGMENT, NOT SUPERSEDE -- the prose floor is unconditional; native is preferred only when declared.
- The Codex `fork_turns: "none"` constraint and the fail-closed-on-a-rejected-profile rule
  (`assertCodexSpawnAgentAccepted`) -- a real anti-pattern guard from the codex burn, not narration.
- The 4-harness worktree-mechanism table (CLI/Desktop/Hermes/Codex) and the base-SHA receipt
  requirement (`buildBaseShaReceipt`), including its "refuses to build one over a missing/non-hex
  baseSha" fail-loud rule.
- Every citation (`docs/research/claude-code-cli.md` sec 1/11, `docs/research/codex-cli.md` sec 6,
  `docs/research/claude-code-desktop.md` sec 2.2, `docs/research/hermes.md` sec 6) and every named
  code symbol (`resolveWaveDispatch`, `resolveCodexWaveDispatch`, `resolveWorktreeIsolation`,
  `buildBaseShaReceipt`, `assertCodexSpawnAgentAccepted`).

## No load-bearing rule dropped -- proof

- **corpus-contradiction.test.js**: the surface taxonomy tokens (`surface: ui/copy/integration/none`),
  the gate-name mapping ("`surface: X` -> the Y gate" x3), and the "3 fix iterations" literal all
  live outside the edited span (in the "Required skills" and step-4c sections) and are untouched --
  re-verified green.
- **harness-delegation.test.js**: the "## Task board" section (its own TaskCreate/TaskUpdate/
  reference-harness-design.md citation/STATE-alone fallback) is a *different* section, also outside
  the edited span, untouched -- re-verified green.
- **docs/binding-interface.md's grep-audit** (test/docs-binding-interface.test.js): live re-scan of
  all 30 plugin-prose files for AskUserQuestion/dispatch(Agent-Task-tool)/hook/worktree mentions
  returns the SAME counts as before the edit (13/35, 5/17, 11/28, 5/22) -- the cut reworded
  sentences without changing which LINES carry those terms, so `docs/binding-interface.md` needed
  no update.
- **scripts/build-codex.mjs**: `MUSTER_BUILD_FORCE=1 node scripts/build-codex.mjs` rebuilds clean --
  the two boundary headings the wholesale-replace anchors on are untouched, and everything between
  them is discarded for the Codex build regardless of content anyway.
- **test/claude-parity.test.js**: the Claude-surface hash is re-derived (file COUNT unchanged at
  137) with a new dated comment recording exactly what changed, following this project's established
  pin-history convention.
- **Full suite**: `node --test --test-concurrency=4` -- 1982 pass / 1 skip (unchanged from the
  b483f06 baseline) after the hash update.

## Why the other 9 skills (besides orchestrator, and excluding coordination/review-gate) show 0%

Per Part C of `docs/strategy/native-delegation.md`, muster's irreducible core is judgment: routing,
crew composition, adversarial-gate orchestration, the opinionated skill know-how (the domain
pipelines), and tournament/fusion. Nine of the 11 skills are almost entirely this kind of content --
they were never carrying step-by-step narration of a dispatch/isolation/task-board mechanic to
begin with (their one or two native-dispatch declaration lines, in tournament/advisor, are already
the terse "NATIVE only" capability-declaration shape this item asks skills to keep). Cutting them
further would mean cutting judgment, which the brief's hard constraint forbids. An honest 0% here
is the same practice this project already established for coordination's 30.6% honest miss
(`docs/weight-reduction.md`) and criterion 3's 39.8% honest miss: report the real number, not a
fabricated one.
