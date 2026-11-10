# INTENT and SPEC format

muster's PM artifacts are two markdown files. An INTENT says why a change matters and what good
looks like; a human owns it and it outlives any one change. A SPEC says exactly what one change
does and how each part is proven; agents read it, `muster spec-lint` checks it, and
`/muster:plan` builds from it. This document is the contract between the people and agents who
write them, `muster spec-lint`, and the planner, checker and verifier that consume them.

The design and its sources are in `docs/strategy/2026-11-pm-domain-design.md` (Appendices A to D).
The templates ship in the `muster-pm` builtin: `plugin/builtins/muster-pm/templates/INTENT.md`
and `plugin/builtins/muster-pm/templates/SPEC.md`.

## The artifact chain

```
STRATEGY (optional)  docs/product/STRATEGY.md        bets and OKRs an intent may serve
INTENT (durable)     docs/intent/INT-NNNN-<slug>.md  why, for whom, outcome, tradeoffs, bets
SPEC (per change)    docs/specs/<slug>/SPEC.md       requirements, criteria, evals, decisions
  -> PLAN.md         .muster/runs/<runId>/PLAN.md    every criterion covered by a task
  -> VERIFICATION.md                                 per-criterion status
```

| File | Owner | Lifetime | Holds |
|---|---|---|---|
| INTENT | a named human | durable; superseded, never deleted | Job, evidence, Outcome metrics, non-goals, constraints, tradeoff principles, bets and assumptions, decisions, open questions |
| SPEC | the change | one change; `shipped` or `superseded` at the end | scope, requirements with acceptance criteria, invariants, AI evals, decisions, execution contract, open questions, assumptions, clarifications, traceability |

One intent serves many specs. A PRD is a rendering of intent plus spec for stakeholders, not a
third source of truth.

**Lite mode.** A small change needs no intent file. The SPEC drops the `intent:` field and carries
an `## Intent` section (after Summary) with the Job line, an Outcome table with one Primary and at
least one Guardrail row, and the non-goals. Everything else is unchanged.

## INTENT

```markdown
---
id: INT-0007
title: Self-serve refunds
status: draft
owner: <the human who answers questions about this intent>
serves: docs/product/STRATEGY.md#bet-2
specs: []
updated: 2026-11-10
---
```

| Field | Required | Meaning |
|---|---|---|
| `id` | yes | `INT-NNNN`, stable and never reused. The file is `docs/intent/<id>-<slug>.md`. |
| `title` | yes | Human name of the intent. |
| `status` | yes | `draft`, `accepted`, `superseded-by INT-NNNN` or `retired`. |
| `owner` | yes | The person who answers questions about it. |
| `serves` | no | A strategy bet or OKR, as a path with an anchor. |
| `specs` | no | SPEC paths serving this intent. |
| `updated` | no | Date of the last substantive edit. |

| Section | Rule |
|---|---|
| `## Job` | One line: When <situation>, <persona> wants to <motivation>, so they can <outcome>. |
| `## Problem and evidence` | Every claim cites an evidence row (`E1`, `E2`: local labels, not IDs). An unsourced claim is tagged `[ASSUMPTION]` and appears under Bets. |
| `## Outcome` | A table with exactly one `Primary` row and at least one `Guardrail` row. No pure activity goals. Never invent a baseline: write "not yet measured". |
| `## Non-goals` | `- **NG-NN** <out of scope> — because <reason>.` |
| `## Constraints` | Hard limits only (legal, platform, compatibility, budget, deadline), not solution preferences. |
| `## Tradeoff principles` | At most 3: "When <A> conflicts with <B>, prefer <A>, because <reason>." They let an agent decide a case the spec did not anticipate. |
| `## Bets and assumptions` | A table: `ID`, `We assume`, `Risk` (value, usability, viability, feasibility, ethics), `Evidence`, `Cheapest test`, `Kill criterion`. Rows are `**A-NN**`; every row has an observable kill criterion. Name the most dangerous one. |
| `## Decisions so far` | `- **D-NN** <decision> — reversibility: reversible \| costly \| one-way — <why>.` |
| `## Open questions` | `- **OQ-NN** <question> — owner: <who> — blocks: spec \| build \| launch` |

Delete an empty optional section; never write TBD.

## SPEC

```markdown
---
spec: refunds-self-serve
intent: docs/intent/INT-0007-self-serve-refunds.md
status: draft
change: new
updated: 2026-11-10
---
```

| Field | Required | Meaning |
|---|---|---|
| `spec` | yes | The slug; the file is `docs/specs/<slug>/SPEC.md`. |
| `intent` | yes, or an inline `## Intent` | Repo-relative path to the intent (an `#anchor` is allowed). It must resolve to a file under the project root. Omit it, or write `inline`, in lite mode. |
| `status` | yes | See below. |
| `change` | no | `new` (the default), `modify` or `remove`. See "Delta specs". |
| `base` | with `modify` / `remove` | Repo-relative path of the spec this change modifies. |
| `modifies` | with `modify` / `remove` | The base spec's IDs this change modifies or removes, as a list. |
| `updated` | no | Date of the last substantive edit. |

| Status | Meaning | Gate |
|---|---|---|
| `draft` | being written | at most 3 `[NEEDS CLARIFICATION]` markers |
| `ready` | buildable | zero markers; no open question blocks build |
| `in-build` | a run is building it | same as `ready` |
| `shipped` | built and verified; Traceability filled in | same as `ready` |
| `superseded` | replaced by another spec | none |

### Sections

About 2,000 words at most. Delete a "(when needed)" section that is not needed.

| Section | Rule |
|---|---|
| `## Summary` | Three sentences: what changes, for whom, which intent outcome it moves. |
| `## Scope` | `In:` and `Out:`. Out names at least one non-goal: `NG-NN` from the intent, or a spec-specific one. |
| `## Intent` | Lite mode only (see above). |
| `## Requirements` | One `### CAT-NN <title>` heading per requirement, each with a `Why:` line and at least one acceptance criterion. |
| `## Invariants` | `- **INV-NN** The system shall continue to … — verify: <type>`: what must keep working. The plan turns each into a prohibition. |
| `## AI behavior and evals` | When a model output is part of the feature. A table of `**EV-NN**` rows: behavior, eval method, pass rule fixed before the run, case set. Guidance: `plugin/builtins/muster-pm/references/ai-evals.md`. |
| `## Decisions` | `- **D-NN** <decision> — reversibility: … — <why>`. Imported verbatim and locked into the run's CONTEXT.md. |
| `## Execution contract` | Authority on conflict (spec > intent > existing tests > code comments), what not to touch, when to stop and escalate, `[SUGGESTED]` for unrequested requirements. |
| `## Risks` (when needed) | `**RK-NN**` rows: risk, likelihood × impact, mitigation, linked IDs. |
| `## Context` (when needed) | Links only: design doc, research, code paths, ADRs. |
| `## Open questions` | `- **OQ-NN** <question> — owner — blocks: build \| launch`. Mark an answered one `resolved` and record the answer under Clarifications. |
| `## Assumptions` | Informed defaults taken instead of asking, one line each. |
| `## Clarifications` | `### Session <date>` then `- Q: … → A: …`. |
| `## Traceability` | Generated by `muster spec-trace`; do not edit. |

Template guidance lives in HTML comments; spec-lint ignores comments and fenced code blocks, so
neither an example nor a note is linted as live content.

### Acceptance criteria

```markdown
### REF-01 Customer can request a refund for an eligible order
Why: INT-0007 Job; E1.
- **REF-01.1** [event] When a signed-in customer selects Refund on an order delivered 30 days ago or less, the system shall create a refund request in state `pending` and show its id. — verify: test
```

Each criterion is one bold-led list item under its own requirement, at most 500 characters, and
carries:

1. an EARS tag, written first;
2. the word "shall";
3. exactly one `verify:` type, written last. A criterion that needs two kinds of proof is two
   criteria.

Requirements say what the system does, not how: storage, framework and endpoint choices go to
`## Decisions`. Quality words (fast, easy, intuitive, robust, scalable, seamless, user-friendly,
secure, efficient, flexible) are quantified ("within 2 s at p95") or removed.

### EARS tags

From gotalab/cc-sdd's `ears-format` (vendored verbatim as
`plugin/builtins/muster-pm/references/ears.md`):

| Tag | Shape |
|---|---|
| `[ubiquitous]` | The system shall … |
| `[event]` | When …, the system shall … |
| `[state]` | While …, the system shall … |
| `[unwanted]` | If …, the system shall … |
| `[optional]` | Where …, the system shall … |
| INV (no tag) | The system shall continue to … |

Combined conditions ("While …, when …, the system shall …") take the tag of the condition that
matters most. Keep the EARS keywords in English; write the rest in the project's language.

### Verify types

| Type | Proven by | Verifier status |
|---|---|---|
| `test` | an automated test | VERIFIED / FAILED |
| `check` | a static command that fails before the work exists | VERIFIED / FAILED |
| `eval` | an EV row's case set against its fixed pass rule | VERIFIED / FAILED |
| `judgment` | a human-verify checkpoint | NEEDS-HUMAN |
| `needs-runtime` | production data only, measured against the intent's Primary outcome metric | NEEDS-RUNTIME, never VERIFIED |

An ID in the spec that no task covers is reported by the verifier as ORPHANED.

### AI behavior and evals

One `**EV-NN**` row per behavior the model must get right. The pass rule is a number fixed before
the run (`≥190/200 exact`, `30/30 refuse`). Each case passes or fails; no generic similarity
metrics; each pipeline step is scored on its own. A feature that takes user text has refusal or
abstention and prompt-injection rows; write `Takes user text: no` in the section when it does not.
A rate with no designed sample is a `needs-runtime` criterion, not an EV row. Error analysis after
launch appends EV rows with new IDs; it never rewrites a pass rule.

**Post-launch rows.** A row added after launch takes the next free EV number, goes below the
existing rows, and starts its Behavior cell with `[post-launch YYYY-MM-DD]` (the date of the error
analysis that found the pattern); its case set says which traces the cases came from. Existing
rows and their pass rules are never edited: a stricter bar is a new row beside the old one. A
`shipped` spec takes new rows like any other; the next run plans them. spec-lint warns on a
post-launch tag without a valid date and on a post-launch row numbered below a launch row.

```markdown
| **EV-04** | [post-launch 2026-12-01] Ask for the order id instead of guessing when the message names none | 25 cases from the 2026-11 error-analysis sample | 25/25 ask | evals/refunds/missing-order.jsonl |
```

### Delta specs

A change to a feature that already has a spec (brownfield) gets its own spec that names what it
changes, in the spirit of OpenSpec's delta specs, instead of an in-place rewrite of the shipped
one:

```markdown
---
spec: refunds-partial
intent: docs/intent/INT-0007-self-serve-refunds.md
status: draft
change: modify
base: docs/specs/refunds-self-serve/SPEC.md
modifies: [REF-01, INV-01]
---
```

- `modifies` lists the base IDs the change touches. A modified requirement, invariant or EV row
  is restated in full under its base ID (a requirement with all its criteria); new behavior gets
  new IDs. Listing a requirement covers its criteria.
- `change: remove` lists the IDs it removes and states, as invariants, what must keep working
  after the removal.
- When the delta ships, the base spec is updated to match (or marked `superseded`), so the base
  stays the current truth.
- No `base` means the changed behavior has no spec yet (code-only brownfield): `modifies` then
  names this spec's own IDs for that behavior, as the lite-mode example does.

spec-lint, `delta` dimension: blocker when `base` is not one path, leaves the root or does not
resolve, when a `modifies` entry is not an ID, or when a listed ID is not defined in the base
spec; warning when `modifies` is missing or empty, when a requirement, criterion, invariant or EV
ID of the base is redefined without being listed, when a listed ID is not restated in a `modify`
delta, when a spec with no `base` lists an ID it does not define, and when `base`/`modifies`
appear on a `change: new` spec.

## ID grammar

| Kind | Pattern | Example |
|---|---|---|
| Requirement | `[A-Z][A-Z0-9]{1,11}-\d{2,3}` | `REF-01` |
| Acceptance criterion | requirement + `\.\d{1,2}` | `REF-01.2` |
| Invariant / eval / risk | `INV-` / `EV-` / `RK-` + `\d{2,3}` | `INV-01` |
| Decision / open question / non-goal / assumption | `D-` / `OQ-` / `NG-` / `A-` + `\d{2,3}` | `D-03` |
| Intent | `INT-\d{4}` | `INT-0007` |

- An ID is **defined** by a bold list-item lead (`- **REF-01.1** …`), a `### ID` heading, or a
  bold first table cell (`| **EV-01** |`, the form the EV, risk and assumption tables use).
  Everywhere else it is a reference.
- Each ID is defined once, is stable, and is never renumbered or reused.
- The reserved prefixes (INV, EV, RK, D, OQ, NG, A, INT) are never requirement categories.
- An intent defines NG, D, OQ and A IDs; requirements, invariants and evals belong in a spec.
- Evidence labels (`E1`, `E2`) are local to their intent and outside the grammar.

## Checking a spec

```
muster spec-lint docs/specs/<slug>/SPEC.md [--json] [--root <repo>]
muster spec-lint docs/intent/INT-NNNN-<slug>.md [--intent] [--json] [--root <repo>]
```

A file whose frontmatter has `spec:` is linted as a SPEC; one with an `INT-NNNN` id or file name
as an INTENT; `--intent` forces the intent rules. Output is plan-lint's CheckResult:
`{verdict: "PASS" | "ISSUES", issues: [{dimension, severity, required_property, summary}]}`.
Any issue makes the verdict `ISSUES`. The exit code is 0 with no blocker, 1 with at least one,
and 2 when the file was not evaluated (missing, unreadable or over 1 MB, bad usage). Treat any exit
other than 0 or 1 as "not evaluated", never as a pass. `--root` (default: the current directory)
anchors the intent link. spec-lint reads only the spec, its linked intent and, for a delta, its base spec; regex and
structure only, no network.

SPEC rules:

| Dimension | Blocker | Warning |
|---|---|---|
| `spec_structure` | no or invalid frontmatter; no `spec`; missing or unknown `status`; no intent link and no `## Intent`; intent path absolute, outside the root or not a file; unclosed code fence | unknown `change` |
| `id_grammar` | malformed ID; reserved prefix as a requirement category; an ID defined twice | |
| `requirements` | a requirement with no acceptance criterion; a criterion outside its own requirement; a requirement outside `## Requirements`; a reserved-kind ID heading a requirement; no requirement and no invariant | a `###` heading under Requirements that is not a requirement |
| `acceptance_criteria` | a criterion or invariant without "shall"; zero, several or an unknown `verify:` type | no or unknown EARS tag; tag that does not match its condition word; criterion over 500 characters; invariant without "shall continue to" |
| `readiness` | more than 3 `[NEEDS CLARIFICATION` markers; status `ready` (or later) with a marker, or with an open question that blocks build | an open question with no `blocks:` |
| `ai_evals` | an EV pass rule with no number or N/N | no refusal/abstention or injection row (unless `Takes user text: no`); an AI section with no EV rows; a post-launch tag without a valid date; a post-launch row numbered below a launch row |
| `requirement_language` | | implementation language in a requirement; an unquantified vague adjective in a requirement or invariant |
| `scope` | | no non-goal (`NG-NN`) anywhere in the spec |
| `outcome_link` | | a needs-runtime criterion and no filled-in Primary outcome row in the linked or inline intent |
| `spec_length` | | body over about 2,000 words (the Traceability block excluded) |
| `delta` | `base` not one path, outside the root or unresolved; a `modifies` entry that is not an ID; a listed ID not defined in the base | `modifies` missing or empty; a base ID redefined without being listed; a listed ID not restated in a `modify` delta; with no `base`, a listed ID this spec does not define; `base`/`modifies` on a `change: new` spec |

INTENT rules are mostly warnings, since an intent is a human-owned page:

| Dimension | Blocker | Warning |
|---|---|---|
| `intent_structure` | no or invalid frontmatter; no `id` | missing `title` or `owner`; unknown `status`; file name does not match the id; TBD in the text |
| `id_grammar` | `id` not `INT-NNNN`; an ID defined twice | malformed ID; a spec-only kind (requirement, invariant, eval) defined in an intent |
| `outcome` | | no `## Outcome`; not exactly one Primary row; Primary metric empty; no Guardrail row |
| `tradeoff_principles` | | more than 3 principles |
| `assumptions` | | no assumptions section; no `A-NN` rows; no Kill criterion column; a row without a kill criterion |

## Planning from a spec

The contract is `docs/plan-format.md` ("Planning from a spec"); in short:

1. `/muster:plan docs/specs/<slug>/SPEC.md` (or `…/SPEC.md#REF-02` for one requirement, or a
   backlog item carrying `{spec: <path>#REF-02}`) starts a run from the spec.
2. `muster preflight` runs spec-lint in the same call. A ready spec skips the interview. A spec
   that is not ready gets one question round on its blocking open questions and clarification
   markers; `muster spec-clarify` writes the answers back under `## Clarifications` (a dated
   session), marks each answered question resolved, and sets a draft that now passes to `ready`.
3. `muster spec-context <runId>` imports the spec's `D-NN` decisions verbatim and LOCKED into the
   run's CONTEXT.md (with the spec's path and sha256); its non-goals become Deferred Ideas.
4. The planner covers every in-scope criterion, invariant and EV ID in some task's `covers`. An
   invariant becomes a `must_haves.prohibitions` entry, an EV row an eval command, and a
   `judgment` criterion a `checkpoint:human-verify` task. plan-lint's `spec_traceability`
   dimension blocks on a missing or not-ready spec, an unknown ID and an uncovered test, check or
   eval ID.
5. The verifier adds an `## Acceptance` table with one row per ID and the status its verify type
   allows; `muster spec-trace <runId>` regenerates the spec's Traceability block and sets
   `status: shipped` once every ID is VERIFIED or explicitly accepted.
