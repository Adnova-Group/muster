# Muster — Interview mode (requirements front-half)

- Status: shipped (documenting as-built)
- Date: 2026-06-08
- Builds on: slices 1–6 (router, fan-out/review, native built-ins, autopilot/greenfield, domain
  pipelines, diagnose)

## 1. The problem

Thin outcomes route badly. A one-line "fix it" or "make the dashboard better" reaches the router with
nothing to anchor `successCriteria` to, so the crew is assembled against guesses and the plan drifts.
The router's iron rule is outcome-anchored ("derive explicit, testable `successCriteria`; if you cannot,
ask"), but by the time the router runs, detect/capabilities have already been spent on an
underspecified ask. Interview mode adds a deterministic gap-check **before** routing and an interactive
enrichment step that turns a thin outcome into a criteria-backed one the router can actually run.

## 2. What interview mode adds

- A deterministic pre-route filter — `assessOutcome(text)` in `src/interview.js` — that flags when an
  outcome is too thin to plan against. Cheap, conservative, model-independent.
- An **interview skill** (`plugin/skills/interview/SKILL.md`) — one question at a time via the
  **AskUserQuestion** selection UI, behind a hard approval gate, emitting an enriched outcome +
  `successCriteria`.
- Wiring as the **front half of `/muster:run`** (and the attended path of `/muster:autopilot`): assess →
  interview-if-thin → route.

## 3. `assessOutcome(text) -> { clear, signals }` (deterministic gap-check)

Pure heuristic, unit-tested. Conservative by design — over-flagging wastes a question, under-flagging
routes garbage, so signals only fire on clear evidence of underspecification. The model makes the final
call; this is just the pre-filter that keeps a one-line ask from being routed as if it were a spec.

- **empty** — input is not a non-empty string. Returns `{ clear: false, signals: ["empty"] }`.
- **too-short** — fewer than 6 *meaningful* words (stopwords `a/an/the/to/of/and/or/for/it/this/that`
  stripped before counting).
- **no-success-criteria** — no measurable-criteria keyword present (`metric`, `measure`, `success`,
  `criteria`, `kpi`, `target`, `goal`, `increase`, `decrease`, `reduce`, `improve`, `conversion`,
  `rate`, `latency`, `throughput`, `by <digit>`). A digit also clears it.
- **vague-only** — fires only when an outcome is *also* too-short AND criteria-less AND opens with a
  bare imperative verb (`make/do/build/fix/improve/help/handle/update/change`) AND has no concrete
  token. A concrete token — a quoted span, a mid-word capital (e.g. `camelCase`), a proper noun, or a
  digit — rescues it. This conjunction keeps false positives off well-formed short outcomes.

`clear` is `signals.length === 0`. The `signals` array names exactly which gaps the interview must close,
so the interview only asks about real gaps.

## 4. The interview skill (flow)

Front half of `/muster:run`; triggered only on an info-gap. Its only job is to produce an approved
enriched outcome — nothing routes until then.

- **When to run.** Run when `assessOutcome` returns `clear: false` (the `signals` name the gaps), or when
  the user explicitly asks to brainstorm/refine. **Skip** on `clear: true` — hand straight to the router.
- **HARD GATE.** Do not route, assemble a crew, decompose into a plan, or implement anything until the
  user approves the enriched outcome. Same gate as superpowers brainstorming.
- **One question at a time.** Ask via the **AskUserQuestion** selection UI (2–4 labeled options;
  multiple-choice wherever the answer space is enumerable; free-text only when options genuinely don't
  fit). Never batch. Cover only the flagged gaps plus the essentials, roughly in order: purpose/problem
  → users → constraints → measurable success criteria (push for at least one number/metric; this is what
  `assess` flags most — do not accept "works well") → scope boundaries.
- **Decomposition check.** If the outcome spans multiple independent subsystems, offer (via
  AskUserQuestion) to split into separate runs rather than route one over-broad outcome.
- **Output.** `enrichedOutcome` (single string folding in the answers) + `successCriteria` (explicit,
  testable list, at least one measurable). Present both for approval via AskUserQuestion:
  **Approve** / **Revise** (loop back to the relevant question) / **Cancel** (stop; nothing routed).
- **Glass box.** Gathered answers + the enriched outcome are recorded in run STATE so the run traces back
  to the requirements it rests on.

## 5. Use in `/muster:run` (front half before routing)

Step 1 of `/muster:run` runs `npx muster assess "$ARGUMENTS"` → `{ clear, signals }`. On `clear: false`
it invokes the interview skill before detect/route; the approved enriched outcome **replaces
`$ARGUMENTS`** for the rest of the flow (it feeds detect/capabilities/router and is written, with
`successCriteria`, into `.muster/manifest.json`). On `clear: true` the interview is skipped and the flow
proceeds straight to detect → capabilities → router.

## 6. Use in `/muster:autopilot` (gap-gated by attendance)

Autopilot's step 3 closes the info-gap first, but its behavior splits on whether a human is present:

- **Attended.** On `assess` → `clear: false`, trigger the interview skill **once** to enrich the outcome
  and gather `successCriteria`, then continue hands-off with the approved enriched outcome.
- **Unattended (Routine).** No human to interview, so the gap-check must **not** block. On `clear: false`,
  do **not** trigger the interview — **record the gap (the `signals`) to the run report in STATE** and
  proceed with best-effort defaults. Autonomy still stops at the reviewable artifact (the PR), where the
  human can close the gap.

## 7. Glass-box / DNA fidelity

Outcome-anchored: the interview exists to give the router a real anchor instead of a guess. The
deterministic `assess` keeps the decision-to-interview out of the model's hands (code answers what code
can answer); the model only runs the interview itself, where judgment is needed. The gathered answers,
the enriched outcome, and — in unattended mode — any unclosed gap are all recorded in STATE.

## 8. Open questions

1. Should `assess` signal weights be tunable per-domain (a PM outcome's "criteria" vocabulary differs
   from a software one)? Current keyword set is software-leaning.
2. Unattended best-effort defaults: today the gap is recorded and the run proceeds; a future option could
   downgrade to a draft/Recommendations-only artifact when `signals` include `vague-only`.

## Change log

### 2026-06-08 — Document interview mode as-built
- **What changed:** First design record for interview mode (shipped earlier): deterministic
  `assessOutcome(text) -> { clear, signals }` gap-check (empty / too-short / no-success-criteria /
  vague-only); an interview skill that asks one question at a time via AskUserQuestion behind a hard
  approval gate and emits an enriched outcome + `successCriteria`; wired as the front half of
  `/muster:run` and the attended path of `/muster:autopilot`, with unattended autopilot recording the
  gap to STATE instead of interviewing.
- **Why:** thin outcomes route badly — assess + interview give the router a real, criteria-backed anchor
  before any detect/route work is spent.
