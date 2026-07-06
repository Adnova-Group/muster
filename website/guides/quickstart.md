# Quickstart

Muster turns an outcome into finished work. You give it a goal in plain language; it picks the right tools for each piece and drives toward your success criteria, showing its reasoning the whole way.

Pick the mode that matches what you want.

## Plan and review: `/muster:run`

The interactive router. It detects context, assembles the crew, and shows the glass-box manifest plus a plan, then **stops for your approval**. It plans and shows; selecting Approve & run chains into autopilot in-session, while Adjust and Cancel stay plan-only.

```sh
/muster:run Add rate limiting to the public API with tests
```

If the outcome is thin, Muster runs a deterministic gap-check (`muster assess`) and, if needed, an interview that asks one question at a time behind an approval gate before any crew is assembled.

## Hands-off delivery: `/muster:autopilot`

The full lifecycle, hands-off. It branches, routes, runs waves (parallel fan-out, tournaments, an adversarial review gate), commits per wave, then presents the merge decision. It only stops for that decision or an escalation.

```sh
/muster:autopilot Resolve all open issues and update the README
```

You can also hand it a GitHub issue reference as the outcome:

```sh
/muster:autopilot #42
```

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

Prefix with `backlog` to sweep read-only instead of fixing: `/muster:audit backlog` writes the ranked ledger to `.muster/backlog.md`, one item per finding-cluster, ready for `/muster:sprint` to run later.

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
