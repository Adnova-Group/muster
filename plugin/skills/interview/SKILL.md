---
name: interview
description: Interactive requirements interview — one question at a time via the AskUserQuestion selection UI — that turns a thin outcome into an enriched, criteria-backed outcome the router can run.
---

# Interview (requirements)

Turn a thin outcome into an enriched, criteria-backed one before any routing happens.

## When to run
- Run when `npx -y @adnova-group/muster assess "<outcome>"` returns `clear: false` (contract:
  `assessOutcome(text) -> { clear, signals }` in `src/interview.js`). The `signals` name the gaps.
- Run when the user explicitly asks to brainstorm/refine the outcome.
- **Skip** when `clear: true` — hand straight to the router.

**Callers:** `/muster:run` invokes this as its front half before routing; `/muster:autopilot` triggers
it once on an info-gap (attended mode only — unattended skips the interview and proceeds with
best-effort defaults).

## HARD GATE
Do **not** route, assemble a crew, decompose into a plan, or implement anything until the user approves
an enriched outcome (step 5). The interview's only job is to produce that approved outcome. (Same gate
as superpowers brainstorming.)

## One question at a time
- Ask via the **AskUserQuestion** selection UI: 2-4 labeled options, multiple-choice wherever the answer
  space is enumerable. Free-text only when options genuinely don't fit.
- **Never batch questions.** One question, wait for the answer, then the next.
- Cover only the gaps the `signals` flagged, plus the essentials below, roughly in this order:
  1. **Purpose / problem** — what problem this solves, and why now.
  2. **Users** — who the target users are / who consumes the output.
  3. **Constraints** — tech, scope, deadline, what must not break.
  4. **Measurable success criteria** — push for at least one number/metric. This is what `assess`
     flags most; do not accept a vague "works well."
  5. **Scope boundaries** — what is explicitly out of scope.

## Decomposition check
If the outcome spans multiple independent subsystems, surface it and offer — via the **AskUserQuestion**
selection UI — to split into separate runs rather than route one over-broad outcome.

## Output
Produce:
- **enrichedOutcome** — a single outcome string folding in the answers.
- **successCriteria** — a list of explicit, testable criteria (at least one measurable).

Present both for approval via the **AskUserQuestion** selection UI: **Approve** / **Revise** / **Cancel**.
- **Revise** — loop back to the relevant question.
- **Cancel** — stop; nothing is routed.
- **Approve** — these feed the router; the caller writes `outcome` + `successCriteria` into
  `.muster/manifest.json`.

## Glass box
Record the gathered answers and the enriched outcome (run STATE) so the run is traceable back to the
requirements it rests on.
