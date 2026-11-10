---
spec: reply-drafts
status: ready
change: new
updated: 2026-11-10
---

# Spec: Suggested replies for support agents

## Summary
Support agents get a suggested first reply drafted from the customer's message. Agents edit and
send it themselves.

## Intent
Job: When a new ticket arrives, a support agent wants a sensible first draft, so they can answer in minutes instead of writing from scratch.

| Kind | Metric | Baseline | Target | Window | Measured by |
|---|---|---|---|---|---|
| Primary | Median first-reply time | 47 min | 15 min | 30 days after launch | helpdesk SLA report |
| Guardrail | Reopened tickets per 100 | 6 | no worse than 6 | 30 days after launch | helpdesk export |

- **NG-01** Sending replies without an agent — because every reply keeps a human sender.

## Requirements

### RPL-01 Agent sees a draft reply for a new ticket
Why: Intent Job.
- **RPL-01.1** [event] When an agent opens a new email ticket, the system shall show a suggested reply within [NEEDS CLARIFICATION: how many seconds?]. — verify: test
- **RPL-01.2** [unwanted] If the draft generation fails, the system shall show the empty reply box.
- **RPL-01.3** [ubiquitous] The system shall send nothing until the agent selects Send. — verify: test

## Open questions
- **OQ-01** Which ticket queues get drafts first? — owner: support lead — blocks: launch
