---
id: INT-0042
title: Faster onboarding
status: in progress
owner: <the human who answers questions about this intent>
updated: 2026-11-10
---

<!-- A bad intent: two primaries, no guardrail, four tradeoff principles, an assumption without a
kill criterion, a malformed ID, a requirement defined in an intent and TBD. Warnings only; it
lints with --intent or by its INT-NNNN id. -->

# Faster onboarding

## Job
When a new team signs up, the admin wants to invite everyone in one step, so they can start the same day.

## Outcome
| Kind | Metric | Baseline | Target | Window | Measured by |
|---|---|---|---|---|---|
| Primary | Teams active on day 1 | 31% | 50% | 30 days | product analytics |
| Primary | Invites sent per admin | 3 | 8 | 30 days | product analytics |

## Non-goals
- **NG-1** SSO setup during onboarding — because it needs IT.

## Requirements
- **ONB-01** The system shall send invites in bulk.

## Tradeoff principles
- When speed conflicts with completeness, prefer speed.
- When admins conflict with members, prefer admins.
- When mobile conflicts with desktop, prefer desktop.
- When cost conflicts with quality, prefer quality.

## Bets and assumptions
| ID | We assume | Risk | Evidence | Cheapest test | Kill criterion |
|---|---|---|---|---|---|
| **A-01** | Admins know their team's emails | usability | none | a survey | TBD |

## Open questions
- **OQ-01** Who owns onboarding emails? — owner: growth — blocks: spec
