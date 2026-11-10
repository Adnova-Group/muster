---
spec: draft-refunds
intent: docs/intent/INT-0007-self-serve-refunds.md
status: draft
updated: 2026-11-10
---

# Spec: Refund window (draft)

## Summary
Customers see why a refund is refused. This serves INT-0007.

## Scope
In: refusal reasons. Out: NG-01 (intent).

## Requirements

### WIN-01 Customer sees the refund window
Why: INT-0007 Job.
- **WIN-01.1** [unwanted] If the order is outside the refund window, the system shall show the window length of [NEEDS CLARIFICATION: 30 or 60 days?] next to the refusal. — verify: test

## Decisions
- **D-01** The window is counted in calendar days. — reversibility: reversible — matches the returns policy.

## Open questions
- **OQ-01** Does the window start at delivery or at dispatch? — owner: Dana Ruiz — blocks: build
- **OQ-02** Should the refusal page link to support? — owner: Dana Ruiz — blocks: launch

## Assumptions
- Customers are signed in.
