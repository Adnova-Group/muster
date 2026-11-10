---
id: INT-0007
title: Self-serve refunds
status: accepted
owner: Dana Ruiz (support lead)
specs: [docs/specs/refunds-self-serve/SPEC.md]
updated: 2026-11-10
---

# Self-serve refunds

## Job
When an order arrives damaged or late, a customer wants to get their money back without waiting on support, so they can reorder or move on the same day.

## Problem and evidence
- E1: 38% of support tickets in October were refund requests for delivered orders (helpdesk export 2026-11-01).
- E2: Median time to a refund decision is 2.4 days (helpdesk SLA report, October).

## Outcome
| Kind | Metric | Baseline | Target | Window | Measured by |
|---|---|---|---|---|---|
| Primary | Refund tickets per 1,000 orders | 41 | 15 | 60 days after launch | helpdesk export, tag=refund |
| Guardrail | Refund fraud rate | 0.4% | no worse than 0.5% | 60 days after launch | payments risk dashboard |

## Non-goals
- **NG-01** Partial refunds by customers — because support keeps that judgment.

## Constraints
- Refunds settle through the existing payments provider contract — source: finance.

## Tradeoff principles
- When speed of refund conflicts with fraud checks, prefer the fraud check, because one chargeback costs more than a day's delay.
- When a policy edge case is unclear, prefer routing to support over refusing, because a wrong refusal loses the customer.

## Bets and assumptions
| ID | We assume | Risk | Evidence | Cheapest test | Kill criterion |
|---|---|---|---|---|---|
| **A-01** | Customers will use a self-serve button instead of writing in | value | E1 | Button behind a flag for 5% of orders for one week | Fewer than 20% of eligible refunds go through the button |

**Most dangerous: A-01 — because the outcome depends on adoption, not on the button working.**

## Decisions so far
- **D-01** Refunds stay limited to delivered orders — reversibility: reversible — undelivered orders already cancel.

## Open questions
- **OQ-01** Do marketplace sellers need to approve refunds? — owner: Dana Ruiz — blocks: launch
