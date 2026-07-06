# The five modes

Muster exposes five entry points as slash commands under the `muster:` namespace.

| Mode | Command | Shape |
| --- | --- | --- |
| Run | `/muster:run <outcome>` | Plan and show, then stop for approval |
| Autopilot | `/muster:autopilot <outcome>` | Hands-off full lifecycle |
| Diagnose | `/muster:diagnose <symptom>` | Failure-first single-bug fix |
| Audit | `/muster:audit [path]` | Breadth-first whole-codebase review and fix |
| Sprint | `/muster:sprint <backlog ref>` | Batch autopilot over every backlog item, never interviewing mid-batch, one stop at the end |

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

```sh
/muster:sprint
/muster:sprint issues:bug
```

Next: the [CLI commands](/reference/commands) that power these modes.
