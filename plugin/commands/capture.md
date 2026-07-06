---
name: capture
description: "Conversation-to-backlog generator — the third and final backlog generator, alongside the interview skill's decomposition check and audit's backlog mode, so hand-written backlog items are never needed. Turns a session's discussion (research findings, design decisions, review residuals, explicit user directives like 'add those 5') into backlog items via the identical extract/validate/dedupe/write machinery, gated by human approval before anything is written. Usage: /muster:capture [hint] — hint optionally scopes which part of the conversation to mine; empty = the whole session so far."
---

You are muster's conversation-to-backlog generator: you turn a session's discussion into backlog items nobody has to hand-write, each one traced to what was actually said.

Respond with the candidate list (glass-box, each item quote/decision-traced), the AskUserQuestion approval prompt, then the written/skipped report.

<hint>$ARGUMENTS</hint>

Run this whenever a discussion has produced actionable outcomes that belong on the backlog and nothing has captured them yet — research findings, design decisions, review residuals, an explicit user directive such as "add those 5". `$ARGUMENTS` optionally narrows which part of the conversation to mine; empty scans the whole session so far.

**Run-active lifecycle:** none. Capture only ever writes `.muster/backlog.md`, and the `PreToolUse` hook's decision order already treats writes under `.muster/` as always-allowed bookkeeping regardless of any `run-active`/`wave-active` marker; capture also never dispatches a subagent wave itself. A `run-active` marker here would gate nothing — it was boilerplate copied from the other commands and is deliberately omitted.

This reuses the interview skill's Decomposition check machinery **by reference** — same item format, wave grammar, measurability, and dedupe rules `plugin/skills/interview/SKILL.md` defines for backlog writes. Read it first if unfamiliar; do not re-derive a divergent format here. Drive:

1. **Extract** — scan the conversation (scoped by `$ARGUMENTS` if given) for candidate items: each a one-line outcome with its measurable folded in (a finding, a decision, a residual, a directive). Trace each to what was actually discussed — a quoted fragment or a named decision — recorded alongside the item (glass box); an item that can't be traced to something said in the conversation is not a candidate.
   **Exclusions** — never capture:
   - a musing or opinion floated without an actual decision behind it
   - work already completed this session (it shipped — it does not belong on the backlog)
   - an item already on the backlog (step 3's dedupe enforces this mechanically; excluded at extraction too, as intent)
   - an outcome already actioned or superseded later in the same discussion (the latest call wins, not the interim one)
   - anything the user explicitly parked ("later", "maybe", "not now")

   **Cap** — if more than 10 candidates survive the exclusions above, present only the 10 most recent/decision-weighted candidates and state how many were held back (e.g. "4 additional candidates held back past the cap of 10").
2. **Validate** — for every candidate, apply the interview skill's shared rules exactly:
   - **assess-passable** — `npx -y @adnova-group/muster assess "<item text>"` (every `{key: value}` annotation stripped generically first) returns `clear: true`; fold in criteria until it does, capped at 2 reword attempts. If the item still isn't `clear: true` after 2 attempts, present it in step 4's offer list marked **UNMEASURABLE** with its assess signals attached, for the human to fix or drop — never fabricate a metric to force `clear: true`.
   - **`{id: <short-kebab-slug>}`** on every item — a label only, never affecting ordering.
   - **explicit `{deps: none}`** for a genuinely independent item, or **`{deps: <predecessor ids>}`** for one that builds on another item extracted in this same batch — an item written without a `{deps}` annotation implicitly depends on everything already above it in the file, so never omit it.
   - **no `{disposition}`** annotation unless the user explicitly declared one for that item during the conversation (`sprint` defaults unannotated items to `pr`).
3. **Dedupe** — read `.muster/backlog.md` if it exists; skip any candidate whose text (every `{key: value}` annotation stripped generically) already matches an existing line's text, checked or unchecked. Track skips for the report.
4. **Present** — before writing anything, show the surviving candidate list via the **AskUserQuestion** selection UI: **Approve all** / **Edit** (revise or drop specific items; an edited item re-enters step 2 — assess-passable + dedupe — before it is re-offered) / **Drop <named items>** / **Cancel (capture nothing)** — the last exits without writing anything to the backlog. Nothing is written until the user approves — this is the human gate on what enters the queue.
5. **Write** — create `.muster/backlog.md` if absent, else append below the existing content; NEVER remove, reorder, or rewrite existing lines. One line per approved item: `- [ ] <item text>` followed by its `{id}`/`{deps}`/(optional) `{disposition}` annotations — exactly the format `/muster:sprint` parses. Record the written items and the skips in the run STATE (glass box).
6. **Offer** — via **AskUserQuestion**: run the **first item now** (the autopilot lifecycle), run the **whole backlog** now (`/muster:sprint`), or **just save** (stop here).

## Glass box
Record, per item: the source (quote fragment or decision reference), the `assess` result (or `UNMEASURABLE` if the reword cap was hit), and whether it was written or skipped as a duplicate — so the backlog always traces back to the conversation it came from.
