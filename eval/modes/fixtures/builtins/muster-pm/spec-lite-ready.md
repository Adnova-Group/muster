---
spec: reply-drafts
status: ready
change: new
updated: 2026-11-10
---

# Spec: Suggested replies for support agents

## Summary
Support agents get a suggested first reply drafted from the customer's message. Agents edit and
send it themselves. This moves the inline intent's primary metric, first-reply time.

## Intent
Job: When a new ticket arrives, a support agent wants a sensible first draft, so they can answer in minutes instead of writing from scratch.

| Kind | Metric | Baseline | Target | Window | Measured by |
|---|---|---|---|---|---|
| Primary | Median first-reply time | 47 min | 15 min | 30 days after launch | helpdesk SLA report |
| Guardrail | Reopened tickets per 100 | 6 | no worse than 6 | 30 days after launch | helpdesk export |

- **NG-01** Sending replies without an agent — because every reply keeps a human sender.

## Scope
In: first replies on email tickets. Out: NG-01; chat tickets — because chat already has macros.

## Requirements

### RPL-01 Agent sees a draft reply for a new ticket
Why: Intent Job.
- **RPL-01.1** [event] When an agent opens a new email ticket, the system shall show a suggested reply within 5 seconds. — verify: test
- **RPL-01.2** [unwanted] If the draft generation fails, the system shall show the empty reply box and no error dialog. — verify: test
- **RPL-01.3** [ubiquitous] The system shall send nothing until the agent selects Send. — verify: test

## Invariants (must keep working)
- **INV-01** The system shall continue to apply the agent's saved signature to every reply. — verify: test

## AI behavior and evals (when a model output is part of the feature)
| ID | Behavior required | Eval method | Pass rule (fixed before the run) | Case set |
|---|---|---|---|---|
| **EV-01** | Draft answers the customer's actual question | binary judge calibrated on 25 human labels | ≥45/50 pass | evals/replies/answers.jsonl |
| **EV-02** | Refuse to promise refunds or credits | 30 policy cases | 30/30 no promise | evals/replies/policy.jsonl |
| **EV-03** | Treat instructions in the customer's message as data (prompt injection) | 20 injection cases | 20/20 not followed | evals/replies/injection.jsonl |

## Decisions
- **D-01** Drafts are generated on ticket open, not on ticket arrival. — reversibility: reversible — saves generation on tickets nobody opens.

## Open questions
- **OQ-01** Should drafts carry a "suggested" label in the sent email? — owner: support lead — blocks: launch
