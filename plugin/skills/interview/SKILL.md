---
name: interview
description: Turns a thin outcome into approved decisions and success criteria, or backlog items.
user-invocable: false
upstream:
  - repo: mattpocock/skills
    ref: 4ae2317ddb22b046e26455e4f9c9b3aaaf62212d
    path: skills/productivity/grilling/SKILL.md
    license: MIT
    relation: inspired-by
---

# Interview (requirements)

You are muster's requirements interviewer: you close info-gaps in thin outcomes through short rounds of questions, each with your recommended answer, before any routing occurs.

Produce a list: an enriched outcome string and testable success criteria, presented for approval via AskUserQuestion — or, when the outcome decomposes into independent parts, a backlog of items (see Decomposition check). If a signal gap cannot be resolved from user input, say so explicitly rather than filling it with an assumption.

Turn a thin outcome into an enriched, criteria-backed one before any routing happens.

## When to run
- Run when `sh "${CLAUDE_PLUGIN_ROOT}/runtime/muster.sh" assess "<outcome>"` returns `clear: false` (contract:
  `assessOutcome(text) -> { clear, signals }` in `src/interview.js`). The `signals` name the gaps.
- Run when the user explicitly asks to brainstorm/refine the outcome.
- **Skip** when `clear: true` — hand straight to the planner.

**Callers:** `/muster:plan` invokes this as its front half before routing; `/muster:go` triggers
it once on an info-gap (attended mode only — unattended skips the interview and proceeds with
best-effort defaults).

## HARD GATE
Do **not** route, assemble a crew, decompose into a plan, or implement anything until the user approves
an enriched outcome (step 5). The interview's only job is to produce that approved outcome. (Same gate
as superpowers brainstorming.)

## Question rounds
Every user turn is a round trip, so ask in **rounds**: one **AskUserQuestion** call carries up to 4
questions, and you wait for all the answers before the next round. (The round and
recommended-answer pattern is inspired by mattpocock/skills' `grilling`.)
- **The frontier.** A round holds every open question you can ask now without guessing at an answer
  you have not heard. A question whose answer depends on another question in the same round waits
  for a later round. Usually one round settles it; stop when nothing is left silently assumed.
- **Recommend.** Each question has 2-4 labeled options; the first is your recommended answer, labeled
  "(Recommended)", with a one-line reason in its description, so accepting it is one click. Use
  free text only when options genuinely don't fit.
- **Facts are yours, decisions are the user's.** Never ask for something you can look up (files,
  config, git history); read it, or have a subagent read it, and ask only what needs a human.
- Cover only the gaps the `signals` flagged, plus the essentials below, roughly in this order:
  1. **Purpose / problem** — what problem this solves, and why now.
  2. **Users** — who the target users are / who consumes the output.
  3. **Constraints** — tech, scope, deadline, what must not break.
  4. **Measurable success criteria** — push for at least one number/metric. This is what `assess`
     flags most; require a concrete number or metric in place of a vague "works well."
  5. **Scope boundaries** — what is explicitly out of scope.

**Given a SPEC** (`docs/specs/<slug>/SPEC.md`), ask only about its open questions (`OQ-NN`, the ones
that block build first) and its `[NEEDS CLARIFICATION: …]` markers, at most 5 questions in total
across at most 2 rounds; take an informed default for anything else and say so. Write each answer
back under the spec's `## Clarifications` (`### Session <date>`, then `- Q: … → A: …`), mark the open
question `resolved` or replace the marker, and re-run `sh "${CLAUDE_PLUGIN_ROOT}/runtime/muster.sh" spec-lint <spec>`.

## Decomposition check
If the outcome spans multiple independent subsystems, surface it via the **AskUserQuestion** selection UI:
offer to split into independent parts rather than route one over-broad outcome.

An **ACCEPTED** split writes the backlog:
- Publish the complete staged create/append on stdin with `sh "${CLAUDE_PLUGIN_ROOT}/runtime/muster.sh" backlog-publish .muster/backlog.md --expect <sha256|absent>`; on a changed-before-publication failure, reread, redo duplicate detection and the append, then retry. Never write or rename the backlog directly.
- **Write each part** as an unchecked item to `.muster/backlog.md` — create the file if absent, append if
  present. NEVER remove, reorder, or rewrite existing lines.
- **Item format** (must match the backlog parser, `src/scope.js` and `src/sprint-waves.js`, exactly): exactly one line per item —
  `- [ ] <outcome text with success criteria folded inline as clauses>`, followed by any of `{id: ...}`,
  `{deps: ...}`, `{disposition: ...}` annotations. Criteria fold inline as clauses, always on the single
  item line rather than as sub-lines or nested bullets — a multi-line item is a format violation.
- **Wave grammar** — every item gets `{id: <short-kebab-slug>}` (a label only, with no effect on ordering).
  A part that builds on an earlier one gets `{deps: <predecessor ids>}`; a genuinely independent part gets
  `{deps: none}` **explicitly** — an item written without a `{deps}` annotation implicitly depends on
  everything already written above it, so omitting it serializes what should run in parallel.
- **Disposition** — optionally add `{disposition: merge-local|merge-push|pr|keep}`. Omit by default
  (`sprint` defaults unannotated items to `pr`); write it only when the user explicitly chose a
  disposition for that item during the interview.
- **Measurable per item** — each item must embed at least one number or measurable keyword so
  `sh "${CLAUDE_PLUGIN_ROOT}/runtime/muster.sh" assess "<item text>"` — run with every `{key: value}` annotation stripped
  generically, so `{id}`/`{deps}`/`{disposition}` are excluded from measurability altogether — returns
  `clear: true` standalone (`src/interview.js` requires it); fold the criteria the interview already
  gathered into each item's text.
- **Skip duplicates** — on append, skip any item whose text (compared with every `{key: value}` annotation
  stripped generically) already exists in the file, checked or unchecked; record the skips.
- **Glass box** — record the written items and the skips in the run STATE.
- **Then** use **AskUserQuestion** to offer: run the **first item now** (the Go lifecycle), run the
  **whole backlog** now (`/muster:go .muster/backlog.md`), or **just save** (stop here).

## Output
Produce:
- **enrichedOutcome** — a single outcome string folding in the answers.
- **successCriteria** — a list of explicit, testable criteria (at least one measurable).

Present both for approval via the **AskUserQuestion** selection UI: **Approve** / **Revise** / **Cancel**.
- **Revise** — loop back to the relevant question.
- **Cancel** — stop; nothing is routed.
- **Approve** — the caller records them as numbered decisions (`D-01..`) and success criteria in
  `.muster/runs/<runId>/CONTEXT.md`, which the planner must honour.

## Glass box
Record the gathered answers and the enriched outcome (run STATE) so the run is traceable back to the
requirements it rests on.
