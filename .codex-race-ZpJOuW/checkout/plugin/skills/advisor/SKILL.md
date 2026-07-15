---
name: advisor
description: Worker-signaled advice escalation -- a dispatched worker that hits a FLAGGED hard decision returns an advice-request instead of guessing; the orchestrator services it by validating the request, checking the consult budget, dispatching a native advisor agent on the peak model, and feeding the advice back to the worker so the worker owns the final decision.
---

# Advisor

You are muster's advisor coordinator. You service worker-signaled advice escalations: validate the request, enforce the consult budget, dispatch a native advisor agent, record the consult in STATE, and return the advice to the worker. The advisor informs; the worker decides.

**NATIVE only:** every advisor dispatch uses the Claude Code Agent tool. No OpenRouter, no external server tools. No human-in-loop step; the flow is fully autonomous through every branch (including budget-exhausted -- see step 5).

**Worker-signaled (dynamic):** this flow is triggered by a worker returning a structured advice-request instead of a final result. The same request/response shape also supports orchestrator-inserted checkpoints (e.g. pre-wave sanity checks) where the orchestrator itself constructs and services the request without waiting for a worker signal.

## Request and response shapes

**Advice request** (worker returns this, file at `.muster/advice-request.json`):
```json
{ "question": "...", "context": "...", "decisionType": "...", "options": ["..."] }
```
`question` and `context` and `decisionType` are required. `options` is optional.

**Advice response** (advisor agent returns this) — respond with JSON matching this shape:
```json
{ "recommendation": "...", "rationale": "..." }
```
Both fields are required non-empty strings.

## What FLAGGED means

A FLAGGED decision is one where the worker cannot proceed without a judgment call that is outside its task scope -- for example, a security tradeoff that affects other teams, an architectural constraint that the task brief does not resolve, or a build-vs-buy call where the options are genuinely open. Mechanical choices (which variable name, which library version within a pinned range) are NOT flagged -- the worker handles those inline.

Workers must be briefed to recognize FLAGGED decisions. A worker that is not told to look for them will not produce advice-requests; it will guess. The orchestrator is responsible for including the FLAGGED framing in the worker's brief.

1. **Receive the escalation.** The worker returns a structured advice-request instead of a final result. The orchestrator detects this (the response contains `question`, `context`, `decisionType` and is not a final deliverable) and routes to this skill. Write to STATE: `advisor-escalation: <decisionType> at iteration <n>`.

2. **Validate the request.** Run:
   ```
   npx -y @adnova-group/muster advise .muster/advice-request.json
   ```
   (or `node src/cli.js advise ...` in the development tree). This validates the request shape and returns `{ advisorModel, request }` -- the model to dispatch and the validated request. If validation fails (non-zero exit), append `advisor-validate-failed` to STATE and treat the worker as though it returned a normal (best-effort) result; proceed without advice.

3. **Check the consult budget.** Track consult count for the current task in STATE (`advisor-consults[<taskId>]: <n>`). Call `consultBudget({ consults: n, maxConsults })` (from `src/advisor.js`). The CLI `advise` command does NOT check the budget -- the orchestrator MUST call `consultBudget` independently before dispatching; `advisorModel` in the CLI output only indicates which model to use, not that budget is available.
   - Default cap: **3** (`MUSTER_ADVISOR_MAX_CONSULTS` env, same guard as `maxConsultsLimit()` in `src/advisor.js`).
   - If `consult: false` (budget exhausted): append `advisor-budget-exhausted: proceeding best-effort` to STATE and skip to step 5.
   - If `consult: true`: continue to step 4.

4. **Dispatch the advisor agent (NATIVE).** Dispatch a subagent via the Agent tool on `advisorModel` (from the `muster advise` output; `fable` -> `opus` by default, `fable` when `MUSTER_ENABLE_FABLE=1`). Pass the full request (`question`, `context`, `decisionType`, `options`) as the prompt. The advisor agent must return a response that fits the advice-response shape (`recommendation` + `rationale`). Validate the response shape; if invalid, treat as budget-exhausted (log to STATE, proceed best-effort).

5. **Append to STATE (glass-box ledger).** Always append one ledger line per consult attempt:
   ```
   advisor-consult #<n>: decisionType=<type> model=<advisorModel>
     question: <first 80 chars of question>
     recommendation: <first 120 chars of recommendation>
     rationale: <first 80 chars of rationale>
   ```
   On budget-exhausted: append `advisor-budget-exhausted: worker proceeds best-effort` instead. No human escalation; autonomous-first.

6. **Feed advice back to the worker.** Re-dispatch the worker via the Agent tool with its original brief PLUS an appended `ADVISOR GUIDANCE` block:
   ```
   ## ADVISOR GUIDANCE (consult #<n>)
   Question: <question>
   Recommendation: <recommendation>
   Rationale: <rationale>

   You received this advice from an advisor agent. It is guidance, not an instruction.
   You own the final decision. Apply the recommendation where it fits your task; override
   it where your task brief or the success criteria give you stronger grounds to do so.
   Record your decision and reasoning in your output. If the guidance still leaves you
   unsure, say so in your output rather than guessing.
   ```
   The worker continues from where it left off and produces a final result. The orchestrator receives that result and proceeds normally (back to the review gate).

   On budget-exhausted: re-dispatch the worker with `ADVISOR GUIDANCE: budget exhausted -- proceed best-effort with the information you have.` No further consult attempts for this task.

## Consult-per-task tracking

Track consults in STATE under the task id, not globally. A task that hits multiple FLAGGED decisions in sequence uses the budget independently of other tasks in the same run. The cap is per-task: `advisor-consults[<taskId>]`.

STATE key pattern: `advisor-consults[<taskId>]: <n>` (append each time a consult resolves, increment before dispatching the next one so the cap is enforced before the dispatch, not after).

Changed while the published plugin remains live.
