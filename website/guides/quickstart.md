# Quickstart

Muster turns an outcome into finished work. You give it a goal in plain language; it picks the right tools for each piece and drives toward your success criteria, showing its reasoning the whole way.

Pick the mode that matches what you want.

## Plan and review: `/muster:plan`

The approve-first router. It detects whether the invocation is one outcome or a backlog, confirming via AskUserQuestion (stating the signals verbatim) whenever it isn't a clear single item, announces the artifact it's about to produce, then -- for a single outcome -- assembles the crew and shows the glass-box manifest plus a plan, and **stops for your approval**. It plans and shows; selecting Approve & run chains into `/muster:go` in-session, while Adjust and Cancel stay plan-only.

```sh
/muster:plan Add rate limiting to the public API with tests
```

If the outcome is thin, Muster runs a deterministic gap-check (`muster assess`) and, if needed, an interview that asks one question at a time behind an approval gate before any crew is assembled.

Plan also takes a backlog ref (`/muster:plan .muster/backlog.md`, `issues:<label>`, or `linear:<key>`) and, once scope confirms, delegates to `/muster:plan-backlog` to plan the whole batch first: every item is routed up front into one batch plan -- per-item crews, run order, cross-item conflict flags -- and Approve & clear chains into the go-backlog clear; nothing executes before that approval.

`/muster:run` still works: a one-line heads-up, then identical behavior under the new name. Deprecated as of 2026-07-17, retiring in muster 0.7.0.

## Hands-off delivery: `/muster:go`

The full lifecycle, hands-off. It shares Plan's scope detection and confirm, then -- for a single outcome -- branches, routes, runs waves (parallel fan-out, tournaments, an adversarial review gate), commits per wave, then presents the merge decision. It only stops for the scope confirmation, that decision, or an escalation.

```sh
/muster:go Resolve all open issues and update the README
```

You can also hand it a GitHub issue reference as the outcome:

```sh
/muster:go #42
```

`/muster:autopilot` still works: a one-line heads-up, then identical behavior under the new name. Deprecated as of 2026-07-17, retiring in muster 0.7.0.

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

Prefix with `backlog` to sweep read-only instead of fixing: `/muster:audit backlog` writes the ranked ledger to `.muster/backlog.md`, one item per finding-cluster, ready for `/muster:go-backlog` to clear later.

## Plan a whole backlog: `/muster:plan-backlog`

The approve-first batch planner -- reached directly, or through `/muster:plan`'s confirmed-backlog delegation. It routes every item in a backlog up front into one batch plan (per-item crews, run order, cross-item conflict flags) and stops for approval before anything runs.

```sh
/muster:plan-backlog
/muster:plan-backlog issues:bug
```

Given a raw intent instead of an existing backlog ref, it first decomposes the intent into backlog items behind a capture-style approval gate, then plans the freshly written backlog. Approve & clear chains into `/muster:go-backlog`.

## Clear a backlog: `/muster:go-backlog`

The batch counterpart to Go. It runs the full Go lifecycle sequentially over every item in a backlog (`.muster/backlog.md` by default), ticking each one off as it completes. An escalated item never aborts the batch -- it stays unchecked and go-backlog moves on. There is exactly one attended stop, at the end, for the batch report -- headlined "cleared N, escalated M."

```sh
/muster:go-backlog
/muster:go-backlog issues:bug
```

A backlog item annotated with `{id}`/`{deps}` (the shape `/muster:audit backlog` and an accepted interview decomposition both emit by default) switches go-backlog into **wave mode**: independent items in a wave dispatch as parallel worktree-isolated runners, capped by `MUSTER_SPRINT_PARALLEL` (hard ceiling 8), while items disposed to merge locally or push serialize at the wave barrier. Go-backlog also re-resolves after each item: as each disposition executes, it re-reads the backlog file, so items added mid-batch join the run instead of waiting for the next invocation.

`/muster:sprint` still works: a one-line heads-up, then identical behavior under the new name. Deprecated as of 2026-07-17, retiring in muster 0.7.0.

## Schedule one cycle at a time: `/muster:runner`

The unattended counterpart to Go-backlog, meant to be fired repeatedly by a Claude Code Routine or cron rather than run once over a whole backlog: each cycle resumes an answered blocked item or claims exactly one available item, drives it through the full Go lifecycle force-coerced to a `pr` disposition, leaves a receipt, and stops.

```sh
/muster:runner
/muster:runner issues:agent:todo
```

Runner and Go-backlog share a claim/receipt/ledger discipline (the **coordination** skill), so a scheduled runner can safely work the same backlog or `issues:<label>` alongside an attended go-backlog clear or a human.

## Turn a discussion into backlog items: `/muster:capture`

Had a conversation that produced findings, decisions, or an explicit "add those 5" -- but nothing has written them down yet? `/muster:capture [hint]` mines the session (or just the part `hint` scopes) for candidate backlog items, each traced back to what was actually said. Nothing is written until you approve the list; it never assembles a crew or runs anything itself.

```sh
/muster:capture
/muster:capture the three findings from the audit we just discussed
```

Approve, and the items land in `.muster/backlog.md` alongside anything `/muster:audit backlog` or an interview decomposition already wrote there, ready for `/muster:go-backlog` to clear.

## Inspect the routing yourself

Because the CLI is deterministic and makes no model calls, you can run it in a terminal to see exactly how Muster would resolve work:

```sh
# What did Muster detect about this project?
npx @adnova-group/muster detect

# Which provider wins each role, on which model, and what would beat it?
npx @adnova-group/muster capabilities

# Which specialist matches a free-text task?
npx @adnova-group/muster match "audit this code for security vulnerabilities"

# Which pipeline routes for an outcome?
npx @adnova-group/muster route "draft a PRD for a referral program"
```

Next: read [Concepts](/reference/concepts) to understand the router that powers all of this.
