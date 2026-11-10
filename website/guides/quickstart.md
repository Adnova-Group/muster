# Quickstart

Muster turns an outcome into finished work. You give it a goal in plain language; it picks the right tools for each piece and drives toward your success criteria, showing its reasoning the whole way.

## Choose a mode by task

Muster has seven modes, including Design for human-facing work and Init for native repository
instruction setup. Start with the result you need:

<div class="decision-grid">

<article class="decision-card"><strong>Shape an outcome or a backlog before work starts</strong><span>Use <a href="#plan-and-review-muster-plan">Plan</a> to inspect the checked plan and approve it.</span></article>
<article class="decision-card"><strong>Deliver an outcome or a backlog end to end</strong><span>Use <a href="#hands-off-delivery-muster-go">Go</a> for the hands-off lifecycle, attended or scheduled.</span></article>
<article class="decision-card"><strong>Reproduce and fix one failure</strong><span>Use <a href="#fix-a-bug-muster-diagnose">Diagnose</a>.</span></article>
<article class="decision-card"><strong>Find and fix broad codebase risks</strong><span>Use <a href="#sweep-the-codebase-muster-audit">Audit</a>.</span></article>
<article class="decision-card"><strong>Create or improve a human-facing surface</strong><span>Use <a href="#design-a-human-facing-surface-muster-design">Design</a>.</span></article>
<article class="decision-card"><strong>Turn decisions into backlog items</strong><span>Use <a href="#turn-a-discussion-into-backlog-items-muster-capture">Capture</a>.</span></article>
<article class="decision-card"><strong>Prepare a repository for Muster</strong><span>Use <a href="#initialize-a-repository-muster-init">Init</a>.</span></article>

</div>

If you have not installed Muster yet, [choose your harness first](/guides/get-started).

::: tip On Codex?
Every mode below is available on Codex as a skill (`$muster-plan`, `$muster-go`, and so on) once Muster's managed profiles and plugin are installed. See the [Codex guide](/guides/codex) for that install path. If something does not appear or behaves oddly, start at [Troubleshooting](/guides/troubleshooting).
:::

## Plan and review: `/muster:plan`

The approve-first planner. One `muster preflight` call sizes up the outcome; if it is unclear, Muster asks up to four questions in one prompt and records your answers as decisions in the run's `CONTEXT.md`. Then the `muster:plan` workflow writes PLAN.md and has a checker review it (revising at most three times), and Plan **stops for your approval**: Approve & build continues as `/muster:go` on the same branch, Revise re-plans with your feedback, Cancel stops.

```sh
/muster:plan Add rate limiting to the public API with tests
```

Plan also takes a backlog (`/muster:plan .muster/backlog.md`): every item gets its own checked plan, and you approve the batch once.

::: tip Skip the per-run Workflow prompt
Plan and Go call Claude Code's Workflow tool, which asks for consent per run in manual and accept-edits modes. Add `Workflow(muster:plan)`, `Workflow(muster:build)` and `Workflow(muster:backlog)` to your allow rules to skip it.
:::

## Hands-off delivery: `/muster:go`

The full lifecycle, hands-off. It plans like Plan, then commits the build arguments (`muster build-args`), runs the `muster:build` workflow (each wave's tasks in parallel isolated worktrees, a reviewer with at most two fix rounds, one verifier), merges the waves with `muster merge-wave` (which re-checks every claimed commit and re-runs the planned verify commands), reports the verification result, and asks how to merge. It only stops for an unclear outcome, an escalation, or that merge decision.

```sh
/muster:go Resolve all open issues and update the README
```

You can also hand it a GitHub issue reference or a backlog:

```sh
/muster:go #42
/muster:go .muster/backlog.md
```

For a scheduled run (a Claude Code Routine, cron with `claude -p "/muster:go <outcome>"`, or a cloud scheduled task), Go asks nothing, records gaps as assumptions, and ends at a pull request instead of merging into your base branch. If a run is interrupted, `muster next --run <runId>` tells you where it stopped and `/muster:go --run <runId>` picks it up.

## Fix a bug: `/muster:diagnose`

Failure-first. Reproduce, find the root cause via systematic debugging, fix, add a regression test, verify. No symptom-patching.

```sh
/muster:diagnose Paste a failing test or stack trace here
```

## Sweep the codebase: `/muster:audit`

Breadth-first review and fix. It fans out six read-only dimension reviews in parallel (architecture, tech-debt, coverage, simplification, readability, security), consolidates a ranked ledger, then fixes everything with tests and verifies.

```sh
/muster:audit
/muster:audit src/payments
```

Prefix with `backlog` to sweep read-only instead of fixing: `/muster:audit backlog` writes the ranked ledger to `.muster/backlog.md`, one item per finding-cluster, ready for `/muster:go .muster/backlog.md` to clear later.

## Design a human-facing surface: `/muster:design`

Initialize or inspect canonical `DESIGN.md` context, then run one of 24
design workflows. Human-facing implementation carries a scope-bound digest
receipt; ordinary backend work never pays the design scan or provider cost.

```sh
/muster:design init
/muster:design polish src/App.tsx
```

## Turn a discussion into backlog items: `/muster:capture`

Had a conversation that produced findings, decisions, or an explicit "add those 5" -- but nothing has written them down yet? `/muster:capture [hint]` mines the session (or just the part `hint` scopes) for candidate backlog items, each traced back to what was actually said. Nothing is written until you approve the list; it never assembles a crew or runs anything itself.

```sh
/muster:capture
/muster:capture the three findings from the audit we just discussed
```

Approve, and the items land in `.muster/backlog.md` alongside anything `/muster:audit backlog` or an interview decomposition already wrote there, ready for `/muster:go .muster/backlog.md` to clear.

## Initialize a repository: `/muster:init`

Init learns bounded repository facts, writes `.muster/project-profile.json` plus `.muster/init-receipt.json`, and hands native instruction generation to the active harness. It never runs repository scripts, hooks, installers, or discovered commands.

```sh
/muster:init
/muster:init path/to/repo
```

Claude Code and Codex use one canonical instruction pair: `AGENTS.md` is authoritative, and `CLAUDE.md` contains exactly:

```md
# Claude Code

@AGENTS.md
```

If conflicting instruction files existed at the preparation baseline, Init leaves a HUMAN-HOLD instead of overwriting or merging them. See [The seven modes](/reference/modes#init) for the evidence and finalization states.

## Inspect the routing yourself

Because the CLI is deterministic and makes no model calls, you can run it in a terminal to see exactly how Muster would resolve work:

```sh
# What did Muster detect about this project?
npx -y @adnova-group/muster detect

# Which provider wins each role, on which model, and what would beat it?
npx -y @adnova-group/muster capabilities

# Which specialist matches a free-text task?
npx -y @adnova-group/muster match "audit this code for security vulnerabilities"

# Which pipeline routes for an outcome?
npx -y @adnova-group/muster route "draft a PRD for a referral program"
```

Next: read [Concepts](/reference/concepts) to understand the router that powers all of this.
