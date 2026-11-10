---
id: INT-0007                     # stable, never reused; the file is docs/intent/INT-0007-<slug>.md
title: Self-serve refunds
status: draft                    # draft | accepted | superseded-by INT-NNNN | retired
owner: <the human who answers questions about this intent>
serves: docs/product/STRATEGY.md#bet-2     # optional bet or OKR; delete when none
specs: []                        # SPEC paths that serve this intent, kept current by whoever writes them
updated: 2026-11-10
---

<!-- prompt-lint-disable ANTH-ROLE-001, ANTH-FMT-001, GUARD-IDK-001: a document template to copy and fill, not an instruction prompt; the guidance comments are for its author. -->

<!-- One page. The why and what good looks like, owned by a human, read by agents.
Delete an empty optional section; never write TBD. IDs are defined as bold list leads or a bold
first table cell (NG-NN, D-NN, OQ-NN, A-NN). `muster spec-lint <this file>` checks it. -->

# Self-serve refunds

## Job
When <situation>, <persona> wants to <motivation>, so they can <outcome>.

## Problem and evidence
<!-- Who is affected, how often, what it costs them today. Every claim cites an evidence row;
an unsourced claim is tagged [ASSUMPTION] and appears under Bets and assumptions. -->
- E1: <fact> (<link | file+locator | "interviews 2026-10-03, n=6">)

## Outcome
| Kind | Metric | Baseline | Target | Window | Measured by |
|---|---|---|---|---|---|
| Primary | <one metric> | <value, or "not yet measured"> | <value> | <window> | <tool, query> |
| Guardrail | <what must not regress> | <value> | no worse than <value> | <window> | <tool, query> |

<!-- Exactly one Primary. At least one Guardrail. No pure activity goals ("ship X", "send N
emails"). Never invent a baseline: write "not yet measured". -->

## Non-goals
- **NG-01** <out of scope> — because <reason>.

## Constraints
<!-- Hard limits only: legal, platform, compatibility, budget, deadline. Not solution preferences. -->
- <constraint> — source: <who or what imposes it>.

## Tradeoff principles
<!-- At most 3. What an agent prefers when the spec did not anticipate a case. -->
- When <A> conflicts with <B>, prefer <A>, because <reason>.

## Bets and assumptions
| ID | We assume | Risk | Evidence | Cheapest test | Kill criterion |
|---|---|---|---|---|---|
| **A-01** | <belief the outcome depends on> | value | E1 | <what we can run this week> | <observable stop signal> |

**Most dangerous: A-01 — because <why it would sink the outcome>.**

<!-- Risk is one of value | usability | viability | feasibility | ethics. A kill criterion is
observable ("fewer than 5 of 40 eligible customers try it in 2 weeks"), never "if it fails". -->

## Decisions so far
- **D-01** <decision> — reversibility: reversible | costly | one-way — <why>.

## Open questions
- **OQ-01** <question> — owner: <who> — blocks: spec | build | launch
