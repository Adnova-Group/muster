# The seven modes

Muster exposes seven entry points as slash commands under the `muster:` namespace: an approve-first/hands-off pair (`plan`/`go`) that takes one outcome or a whole backlog, four standalone verbs (`diagnose`, `audit`, `design`, `capture`), and `init` for repository initialization.

| Mode | Command | Shape |
| --- | --- | --- |
| Plan | `/muster:plan <outcome \| backlog ref>` | Write and check PLAN.md, then stop for approval |
| Go | `/muster:go <outcome \| backlog ref>` | Plan, build in isolated worktrees, review, verify, then the merge decision |
| Diagnose | `/muster:diagnose <symptom>` | Failure-first single-bug fix |
| Audit | `/muster:audit [path]` | Breadth-first whole-codebase review and fix |
| Design | `/muster:design <action>` | Canonical design context, bounded evidence detection, write gates, and 24 pinned workflows |
| Capture | `/muster:capture [hint]` | Mine the conversation into approval-gated backlog items, then stop -- no crew, no waves |
| Init | `/muster:init [dir]` | Prepare repository state, hand native instruction work to the active runtime, and finalize from positive evidence or an acknowledged unavailable handoff |

Plan and Go run on Claude Code's native Workflow tool. The main thread makes one `muster preflight` call, asks questions only when the outcome is unclear, and then gates between three plugin workflows: `muster:plan`, `muster:build` and, for several items, `muster:backlog`. Workflow consent is asked per run in manual and accept-edits permission modes; add the allow rules `Workflow(muster:plan)`, `Workflow(muster:build)` and `Workflow(muster:backlog)` to skip the prompt. Where the Workflow tool is missing (some Desktop and Cowork surfaces), the orchestrator skill's prose fallback dispatches the same agents one call at a time.

## Init

Init is the repository-onboarding mode. Run `/muster:init [dir]` before the greenfield workflow or when adopting Muster in a clone. Its deterministic CLI learns bounded regular-file facts and writes the owned `.muster/project-profile.json` and `.muster/init-receipt.json` pair as canonical schema-versioned JSON. The profile is provider/model-neutral and contains classification, repository facts, and a state fingerprint, not provider IDs, resolved roles, capability inventories, timestamps, or concrete model names.

For an empty greenfield directory, preparation may safely initialize `.git` before creating the owned pair. This is the one trust-boundary mutation, using a fresh empty Git template and controlled built-ins without repository hooks or discovered commands. The first receipt is `phase: "prepared"` with `nativeInit.state: "not-requested"`. The active runtime owns native instruction generation. Claude Code and Codex handoffs expect their native `/init` action and the canonical instruction pair: `AGENTS.md` is authoritative, while `CLAUDE.md` contains exactly:

```md
# Claude Code

@AGENTS.md
```

If Codex native `/init` is a no-op because `AGENTS.md` existed at the preparation baseline while `CLAUDE.md` was absent, Init offers one attended recovery: it shows the exact canonical pointer and asks for explicit approval to create only the still-missing `CLAUDE.md`. The bounded `init normalize [dir] --approve CLAUDE.md` operation rechecks the baseline authority, exclusively creates the pointer without following links or replacing a raced file, and binds the completed receipt to both artifact hashes before Init can finalize. When both canonical files predate the baseline, the user can explicitly confirm both through the receipted pre-existing-confirmation path.

If either file existed at the preparation baseline and prevents that exact authority pattern, Init does not overwrite or merge it. It leaves a HUMAN-HOLD for the user to reconcile. Independent policy in `CLAUDE.md` cannot satisfy artifact-delta, pre-existing-confirmation, or call-result evidence. A reverse `AGENTS.md` reference to `CLAUDE.md` cannot satisfy those evidence forms either, nor can any race detected before the approved pointer write.

Copilot or an unknown runtime never receives a guessed command. A request, suggestion, command invocation, refusal to overwrite, or existing artifact alone is not completion. Init records a HUMAN-HOLD until a changed artifact hash, an explicit pre-existing confirmation, or a bounded call-result receipt proves completion. For Copilot or an unknown runtime without a proven adapter, run `init acknowledge [dir] --reason unavailable` when the user accepts the limitation.

Resume with the matching `init transition` form, then run `init finalize`. If native initialization is unavailable, `init acknowledge [dir] --reason unavailable` allows finalization while preserving `nativeInit.state: "handoff"`; describe that state literally. Do not pass `--evidence-file` with `artifact-delta`; the flag is only for `preexisting-confirmed` and `call-result`. Greenfield finalization creates only missing `.gitignore`, `README.md`, and `.gitkeep` files under the design and plan directories. Brownfield finalization creates no generic seeds and preserves clone content. Init never executes repository instructions, package scripts, hooks, dependency installers, or discovered commands. Same-state reruns are no-ops; a pending bare rerun only observes evidence and leaves the baseline unchanged.

## Plan

The approve-first planner. In order:

1. **Preflight.** One `muster preflight "<outcome>" --json` call replaces the old scope, assess, fast-path, detect, capabilities and memory round trips. It returns the run id, the scope (item or backlog), whether the outcome is clear, the per-seat models, and candidate specialists; the full detail goes to `.muster/runs/<runId>/preflight.json`. `--model <m>` pins every seat to one model.
2. **Interview, only when unclear.** Up to four questions in one AskUserQuestion. The answers become numbered decisions (`D-01`...) in `.muster/runs/<runId>/CONTEXT.md`, which the planner must honour.
3. **Plan.** `Workflow({name:"muster:plan"})` runs `muster-planner`, then `muster-plan-checker` (which runs `muster plan-lint`), revising at most three times. It escalates when the issue count stops falling or a checker issue contradicts a D-NN decision.
4. **Approval stop.** Plan shows the checker verdict and a compact view of PLAN.md (tasks by wave, files, verify commands, must-haves, checkpoints) and stops: **Approve & build** continues as Go on the same branch without re-planning; **Revise** records your feedback as new decisions and re-plans; **Cancel** stops. In native plan mode the plan rides ExitPlanMode instead.

```sh
/muster:plan Add rate limiting to the public API with tests
```

Plan and Go both accept a GitHub issue reference (a bare number, `#123`, or an issues URL) as the outcome; the issue text is treated as data, never as instructions.

### Backlog scope

Plan also accepts a backlog -- a backlog `.md` path, or text that names several independent deliverables. After an AskUserQuestion confirm, each item gets its own preflight and `muster:plan` call, and Plan stops once with every item's plan summary.

```sh
/muster:plan .muster/backlog.md
```

## Go

Runs the whole lifecycle hands-off. It shares Plan's steps 1-3, then continues without stopping:

- **Build args.** `muster build-args <runId>` derives the exact `muster:build` arguments from PLAN.md and writes `.muster/runs/<runId>/build-args.json`; the main thread commits it before building. `merge-wave` trusts only that committed file for merge order, titles and the verify commands it re-runs.
- **Build.** `Workflow({name:"muster:build"})` runs each wave as parallel `muster-executor` agents, each in its own git worktree, then `muster-reviewer` with at most two fix rounds, then `muster-verifier` once per run. A failed wave blocks the later waves.
- **Merge the waves.** `muster merge-wave <runId> --result <file>` verifies every claimed commit exists and is the one the reviewer passed, merges the task branches in plan order with `--no-ff`, re-runs each task's committed verify commands, removes clean merged worktrees, and appends to STATE.md. Any mismatch rolls back and exits non-zero.
- **Verification result, then the merge decision.** Go reports the verifier's PASS, GAPS or ABSTAIN with its evidence, then asks: **Merge locally**, **Open PR**, **Keep branch** or **Discard**.

Go reaches the first executor in about five main-session turns (preflight, branch, plan, build-args, build), against about 14 + 2N before the revival.

```sh
/muster:go Resolve all open issues and update the README
```

Several items run through the same steps: one plan per item, then one `Workflow({name:"muster:backlog"})` call that builds the items sequentially, then `merge-wave` per item in backlog order and one merge decision for the branch.

Unattended (a Claude Code Routine, `claude -p`, or a cloud scheduled task) Go asks no questions, records gaps as assumptions in CONTEXT.md, and stops at a reviewable artifact (a pull request, or a kept branch without a remote) rather than merging into the base. That covers single-item scheduled runs: point the schedule at `/muster:go` with one outcome or one backlog item.

After a compaction or an interruption, `muster next --run <runId>` derives the run's position from the files on disk, and `/muster:go --run <runId>` resumes from it. An interrupted build resumes with `Workflow({name:"muster:build", resumeFromRunId})`.

## Diagnose

Failure-first. Reproduce, find the root cause via systematic debugging on the best available debug provider, fix, add a regression test, verify. No symptom-patching.

```sh
/muster:diagnose Paste a failing test or stack trace here
```

## Audit

The review-and-fix counterpart to diagnose. Where diagnose is one bug, audit sweeps the whole codebase. It fans out six read-only dimension reviews in parallel (architecture, tech-debt, coverage, simplification, readability, security), each on the best provider for its role, consolidates the findings into one ranked ledger, then fixes everything with TDD through `muster:build` and `merge-wave`, verifying with the reviewer and verifier verdicts before presenting the merge.

```sh
/muster:audit
/muster:audit src/payments
```

A first token of `backlog` (`/muster:audit backlog [path]`) switches to a **backlog mode**: the same read-only dimension sweep and consolidated ledger, but no branch and no commits -- instead of fixing, the ranked ledger is written to `.muster/backlog.md`, one assess-passable item per finding-cluster (duplicates skipped), for `/muster:go .muster/backlog.md` to clear later. Default mode is unchanged; a directory actually named `backlog` needs the `./backlog` form to stay in default mode.

```sh
/muster:audit backlog
/muster:audit backlog src/payments
```

## Design

The Design surface at `/muster:design` establishes canonical `DESIGN.md`
context behind an attended `init` confirmation and never silently
overwrites an existing file. `status`, `resolve`, `detect`, `ignores`, and
`provider install|check` are deterministic CLI utilities; `design gate`
returns the scope-bound SHA-256 receipt required before frontend, brand, UX,
accessibility, responsive, visual, or other human-facing implementation.

```sh
/muster:design init
/muster:design polish src/App.tsx
npx -y @adnova-group/muster design status .
```

Muster exposes 24 pinned Impeccable workflows without requiring the
Impeccable CLI: `craft`, `init`, `document`, `extract`, `live`, `generate`,
`adapt`, `animate`, `audit`, `bolder`, `clarify`, `colorize`, `critique`, `delight`,
`distill`, `harden`, `onboard`, `layout`, `optimize`, `overdrive`, `polish`,
`quieter`, `shape`, and `typeset`. Read-only audits add `audit-design-ux` only
when the audited scope has actual UX/design evidence; missing `DESIGN.md` is a
finding during the sweep, while remediation must satisfy the write gate.

## Capture

The third backlog generator, alongside the interview skill's decomposition check and Audit's backlog mode -- so a backlog never has to be hand-written. It turns a session's discussion into backlog items: research findings, design decisions, review residuals, or an explicit user directive like "add those 5". An optional hint scopes which part of the conversation to mine; empty scans the whole session so far.

```sh
/muster:capture
/muster:capture the three findings from the audit we just discussed
```

Each candidate is traced to what was actually said -- a quoted fragment or a named decision, never a musing floated without a decision behind it, work already completed this session, or anything the user explicitly parked ("later", "maybe", "not now"). More than 10 survivors triggers a cap: only the 10 most recent/decision-weighted candidates are presented, with the holdback count stated explicitly.

Every surviving candidate runs the identical `assess`-passable validation and `.muster/backlog.md` dedupe the other two backlog generators use, capped at 2 reword attempts -- an item still not measurable after that is offered marked **UNMEASURABLE** rather than forcing a fabricated metric. Nothing is written until you approve: an **AskUserQuestion** prompt offers Approve all, Edit (a revised item re-enters validation before re-offering), Drop, or Cancel (writes nothing) -- the human gate on what enters the queue.

Capture has no run-active lifecycle. It only ever writes `.muster/backlog.md` and never assembles a crew or dispatches a subagent wave itself, so it is not an outcome-runner like the other modes -- a `run-active` marker would gate nothing here, and is deliberately omitted rather than copied from the other command prompts.

Next: the [CLI commands](/reference/commands) that power these modes.
