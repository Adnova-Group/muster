---
name: advisor
description: Worker-signaled advice escalation -- a dispatched worker that hits a FLAGGED hard decision returns an advice-request instead of guessing; the orchestrator services it by validating the request, checking the consult budget, dispatching a native advisor agent on the peak model, and feeding the advice back to the worker so the worker owns the final decision.
---

# Advisor

You are muster's advisor coordinator: validate the request, enforce the consult budget, dispatch a native advisor agent, record the consult in STATE, and return the advice to the worker. The advisor informs; the worker decides.

**NATIVE only:** every dispatch uses the Claude Code Agent tool — no external server tools, no human-in-loop step; fully autonomous through every branch, including budget-exhausted (step 5).

**Worker-signaled (dynamic):** triggered by a worker returning a structured advice-request instead of a final result. The same shape also supports an orchestrator-inserted checkpoint that services the request directly, without a worker signal.

## Request and response shapes

<!-- muster-return-template:start -->
**Advice request** (worker returns this, file at `.muster/advice-request.json`):
```json
{ "question": "...", "context": "...", "decisionType": "...", "options": ["..."] }
```
`question`/`context`/`decisionType` are required; `options` is optional.

**Advice response** (advisor agent returns this) — respond with JSON matching this shape:
```json
{ "recommendation": "...", "rationale": "..." }
```
Both fields are required non-empty strings.
<!-- muster-return-template:end -->

## What FLAGGED means

A FLAGGED decision needs a judgment call outside the worker's scope — a cross-team security tradeoff,
an unresolved architectural constraint, an open build-vs-buy call. Mechanical choices (a variable
name, a pinned-range library version) are NOT flagged. The brief must frame FLAGGED decisions, or a
worker guesses instead of escalating.

1. **Receive the escalation.** The response carries `question`/`context`/`decisionType`, not a
   deliverable. Write `advisor-escalation: <decisionType> at iteration <n>` to STATE.
2. **Validate the request.** Run `$MUSTER_CLI advise .muster/advice-request.json` → `{ advisorModel,
   request }`. On failure (non-zero exit), append `advisor-validate-failed` to STATE, proceed
   best-effort, no advice.
3. **Check the consult budget.** Track consults per task in STATE (`advisor-consults[<taskId>]: <n>`);
   call `consultBudget({ consults: n, maxConsults })` (`src/advisor.js`) — the CLI does NOT check
   budget, the orchestrator MUST. Default cap **3** (`MUSTER_ADVISOR_MAX_CONSULTS` env). Exhausted
   (`consult: false`) → append `advisor-budget-exhausted: proceeding best-effort`, skip to step 5.
4. **Dispatch the advisor agent (NATIVE).** Via the Agent tool on `advisorModel` (`fable` -> `opus`
   default), the full request as the prompt; an invalid response counts as budget-exhausted.
5. **Append to STATE.** One glass-box line per attempt: `advisor-consult #<n>: decisionType=<type>
   model=<advisorModel>` plus truncated question/recommendation/rationale; exhausted appends
   `advisor-budget-exhausted: worker proceeds best-effort` instead.
6. **Feed advice back to the worker.** Re-dispatch via the Agent tool with the original brief plus an
   `ADVISOR GUIDANCE` block (question/recommendation/rationale) — guidance the worker may override on
   stronger grounds, or say so if still unsure rather than guess. It continues and produces a final
   result; the orchestrator proceeds to the review gate. Exhausted: guidance reads "budget exhausted --
   proceed best-effort," no further consult attempts.

## Consult-per-task tracking

Consults track per task id, not globally: `advisor-consults[<taskId>]: <n>`, incremented before the
next dispatch so the cap is enforced before dispatch, not after.
