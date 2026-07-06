# The seven modes

Muster exposes seven entry points as slash commands under the `muster:` namespace.

| Mode | Command | Shape |
| --- | --- | --- |
| Run | `/muster:run <outcome>` | Plan and show, then stop for approval |
| Autopilot | `/muster:autopilot <outcome>` | Hands-off full lifecycle |
| Diagnose | `/muster:diagnose <symptom>` | Failure-first single-bug fix |
| Audit | `/muster:audit [path]` | Breadth-first whole-codebase review and fix |
| Sprint | `/muster:sprint <backlog ref>` | Batch autopilot over every backlog item, never interviewing mid-batch, one stop at the end |
| Runner | `/muster:runner [source]` | Unattended one-cycle work-picker: resume or claim exactly one item, run it, leave a receipt, stop |
| Capture | `/muster:capture [hint]` | Mine the conversation into approval-gated backlog items, then stop -- no crew, no waves |

## Run

The interactive router. Its front half is an assess-then-interview step: `muster assess` does a deterministic gap-check on the outcome (too short, no success criteria, vague), and if the outcome is not clear, the interview skill runs an interactive requirements interview, one question at a time, behind an approval gate.

Then it detects, routes, and shows the glass-box crew manifest plus the plan, and **stops**. Run plans and shows; selecting Approve & run chains into autopilot in-session, while Adjust and Cancel stay plan-only.

```sh
/muster:run Add rate limiting to the public API with tests
```

Run and Autopilot both accept a GitHub issue reference (a bare number, `#123`, or an issues URL) as the outcome.

## Autopilot

Runs the whole lifecycle hands-off: branch, detect, route, run waves (parallel fan-out, tournaments, an adversarial review gate), commit per wave, then present the merge decision. It only stops for that merge decision or for an escalation.

Tournaments synthesize rather than only pick one winner. The judge maps consensus, contradictions, partial coverage, and blind spots across candidates. `muster fuse` then either grafts the best of the top-K via a synthesizer (mode `fuse`) or falls back to the single best candidate (winner-take-all) when candidates already agree or only one passes.

```sh
/muster:autopilot Resolve all open issues and update the README
```

It triggers the interview only on an actual information gap. In unattended (Routine) mode it records the gap to the run report instead of blocking, and stops at a reviewable artifact (a pull request) rather than auto-merging.

## Diagnose

Failure-first. Reproduce, find the root cause via systematic debugging on the best available debug provider, fix, add a regression test, verify. No symptom-patching.

```sh
/muster:diagnose Paste a failing test or stack trace here
```

## Audit

The review-and-fix counterpart to diagnose. Where diagnose is one bug, audit sweeps the whole codebase. It fans out six read-only dimension reviews in parallel (architecture, tech-debt, coverage, simplification, readability, security), each on the best provider for its role, consolidates the findings into one ranked ledger, then fixes everything with TDD and verifies through the review gate before presenting the merge.

```sh
/muster:audit
/muster:audit src/payments
```

A first token of `backlog` (`/muster:audit backlog [path]`) switches to a **backlog mode**: the same read-only dimension sweep and consolidated ledger, but no branch and no commits — instead of fixing, the ranked ledger is written to `.muster/backlog.md`, one assess-passable item per finding-cluster (duplicates skipped), for `/muster:sprint` to run later. Default mode is unchanged; a directory actually named `backlog` needs the `./backlog` form to stay in default mode.

```sh
/muster:audit backlog
/muster:audit backlog src/payments
```

## Sprint

The batch counterpart to autopilot. It resolves a backlog — `.muster/backlog.md`'s unchecked `- [ ]` items, each optionally carrying a `{disposition: ...}` annotation, or `issues:<label>` resolved via `gh issue list` — then runs the full autopilot lifecycle sequentially over every item, ticking each off as it completes. The backlog is usually generated rather than hand-written: an accepted interview decomposition writes one item per part, and `/muster:audit backlog` writes one item per finding — both match sprint's parser format exactly.

Per item, the declared disposition executes directly, without the merge-decision prompt: `ask` or an absent annotation coerces to `pr`, and in unattended mode `merge-local`/`merge-push` downgrade to `pr`. An escalated item never aborts the batch — it stays unchecked with an `{escalated}` annotation and the sprint moves on to the next item. A per-item outcome that `muster assess` would normally send to interview never triggers one inside a sprint, even in an attended session — it proceeds with autopilot's Unattended (Routine) best-effort defaults, and the gap is recorded in STATE and the batch report instead; interviews belong at backlog-authoring time, not mid-batch. Sprint stops exactly once, attended, at the end: a batch report covering every item.

An item can also carry `{id: token}` and `{deps: a,b}` annotations (or `{deps: none}`) instead of a plain description — an item without `{deps}` implicitly depends on every item above it in the file, so `{deps: none}` is how an item declares independence; `muster sprint-waves` computes the dependency-ordered waves. Any annotated item switches the batch to **wave mode**: waves replace the flat sequential queue, and within a wave `pr`/`keep` items dispatch as parallel item-runner subagents, each in its own git worktree, capped at `MUSTER_SPRINT_PARALLEL` concurrent runners (default 3, hard ceiling 8, higher values clamp, `0` invalid) — `merge-local`/`merge-push` items then run sequentially at the wave barrier in the main tree, and the next wave forks off the post-barrier base. A dependent of an unmerged predecessor forks that predecessor's branch tip and stacks its PR on top (`--base <predecessor-branch>`), merging bottom-up; an escalated predecessor escalates its dependents too, never forking a partial tip. Wave mode only triggers off a file backlog — `issues:<label>` backlogs have no annotation grammar and always run the sequential queue — and a harness that cannot dispatch parallel subagents falls back to running the same waves sequentially in the main tree.

After each item's disposition executes, sprint's **drain mode** re-resolves the backlog file instead of working from a fixed snapshot: newly added unchecked items join the running batch, and a just-completed item (now checked) immediately satisfies any `{deps}` reference to it, so a dependent added mid-sprint isn't blocked on a stale reference. Escalated or already-claimed items are never re-admitted. When a backlog or `issues:<label>` may be worked by more than one runner at once, sprint loads the **coordination** skill: CLAIM an item before touching it, leave a RECEIPT (DONE/BLOCKED/FAILED) on every state change, scan BLOCKED items for an answer before claiming new work, and keep one LEDGER heartbeat per runner — safe alongside other sprints, `/muster:runner` instances, and humans on the same backlog.

```sh
/muster:sprint
/muster:sprint issues:bug
```

## Runner

The unattended, single-cycle counterpart to Sprint's batch drain — meant to be fired repeatedly by a Claude Code Routine or cron, not looped internally. Each invocation: resolve the source, resume an answered BLOCKED item ahead of claiming anything new, or claim exactly ONE available item; drive it through the full autopilot lifecycle with the merge disposition force-coerced to `pr` (a scheduled runner never touches the base branch unattended); leave a receipt; stop. The schedule provides the loop, not the verb.

```sh
/muster:runner
/muster:runner issues:agent:todo
```

Runner shares the same **coordination** skill as Sprint, so it composes safely with a running sprint, other scheduled runners, and humans working the same backlog or `issues:<label>` — the claim lock (Binding A's comment-race window, Binding B's claim-then-verify) is what makes concurrent firing safe. On escalation, Runner posts a `FAILED` receipt and marks the item escalated so the next cycle's claim step skips it; a 2-failure retry cap bounds reclaim loops before an item redirects to blocked rather than being retried forever.

## Capture

The third backlog generator, alongside the interview skill's decomposition check and Audit's backlog mode — so a sprint backlog never has to be hand-written. It turns a session's discussion into backlog items: research findings, design decisions, review residuals, or an explicit user directive like "add those 5". An optional hint scopes which part of the conversation to mine; empty scans the whole session so far.

```sh
/muster:capture
/muster:capture the three findings from the audit we just discussed
```

Each candidate is traced to what was actually said — a quoted fragment or a named decision, never a musing floated without a decision behind it, work already completed this session, or anything the user explicitly parked ("later", "maybe", "not now"). More than 10 survivors triggers a cap: only the 10 most recent/decision-weighted candidates are presented, with the holdback count stated explicitly.

Every surviving candidate runs the identical `assess`-passable validation and `.muster/backlog.md` dedupe the other two backlog generators use, capped at 2 reword attempts — an item still not measurable after that is offered marked **UNMEASURABLE** rather than forcing a fabricated metric. Nothing is written until you approve: an **AskUserQuestion** prompt offers Approve all, Edit (a revised item re-enters validation before re-offering), Drop, or Cancel (writes nothing) — the human gate on what enters the queue.

Capture has no run-active lifecycle. It only ever writes `.muster/backlog.md` and never assembles a crew or dispatches a subagent wave itself, so it is not an outcome-runner the way the other six modes are — a `run-active` marker would gate nothing here, and is deliberately omitted rather than copied from the other command prompts.

Next: the [CLI commands](/reference/commands) that power these modes.
