# PM domain for AI-native teams: assessment and design (2026-11-10)

Read-only study on `revival/stage-3`. The sources were verified with `gh api` on 2026-11-10. Working
notes: `research-specs.md` and `research-pm-skills.md` from the PM research track.

## Assessment

| Area | Score | Why |
|---|---|---|
| Build chain | 8/10 | CONTEXT.md decisions, PLAN.md verify/`fails_when`, plan-lint and the honest verifier are stricter at execution than spec-kit, OpenSpec or PRP |
| PM authoring | 4/10 | Pipelines are one-line phases with no templates, ID scheme, acceptance-criteria grammar or evals |
| PM artifact → plan link | 1/10 | No pipeline feeds `/muster:plan`; PLAN.md dropped gsd's `requirements:`, so nothing traces AC → task → verify |
| Prioritization | 9/10 | `src/prioritize.js`: code does the math, the model supplies the factors |
| Context cost | 7/10 | intent-* skills are 12–52 KB each when opened |

Defects:
- **Unreachable pipelines:** the domain-router was deleted and nothing calls `muster pipeline`.
- **Stale references:** prd/roadmap/business-case still say "reuse review-gate".
- **prd-pipeline skill:** documents 5 phases against the YAML's 7.
- **`ai-implementation-spec`** is really a design doc.
- **`ai-test-plan`** is human QA, not evals.
- **The interview** asks one question at a time, which breaks the round-trip rule.
- **ghaida/intent** is a UX design system, not intent documentation.

## Sources

| Source | License | Take |
|---|---|---|
| github/spec-kit (149k) | MIT | Spec template, ≤3 `[NEEDS CLARIFICATION]`, clarify (≤5 Qs), read-only analyze |
| gotalab/cc-sdd (3.8k, open Kiro) | MIT | 5 EARS patterns; every requirement ID must appear in a task |
| open-gsd/gsd-core | MIT | `CAT-NN` IDs; checker requirement coverage; verifier ORPHANED |
| Fission-AI/OpenSpec (74k) | MIT | Each task states how to verify; delta specs (later) |
| Wirasm/prp | MIT | Gate / Command / Proves table; preserved invariants |
| mattpocock/skills | MIT | `to-tickets`, `grilling` |
| phuryn/pm-skills (27.8k) | MIT | strategy-red-team, pre-mortem, assumptions, outcome-roadmap, OKRs, OST |
| phuryn/product-engineering | MIT | intended-vs-implemented |
| product-on-purpose/pm-skills | Apache-2.0 | AI behavior/eval table, agent execution contract |
| anthropics/knowledge-work-plugins | Apache-2.0 | write-spec, synthesize-research (heavy) |
| openai define-goal | Apache-2.0 (file) | Goal-shaping rules |
| Kiro docs, BMAD (trademark), deanpeters (NC), cdeust (proprietary), Pimzino (GPL), doc-coauthoring (no license), Lenny/Reforge | — | Ideas only |

How evals are reconciled across Anthropic, OpenAI and Hamel Husain:
- binary pass rules are fixed up front for known behaviors (policy, refusal, injection);
- a slot is kept for evals discovered through error analysis;
- no similarity metrics;
- no rate claims without a designed sample.

## Artifact chain

```
STRATEGY (optional)  docs/product/STRATEGY.md        <- okrs / roadmap pipelines
INTENT (durable)     docs/intent/INT-NNNN-<slug>.md  <- /muster:pm intent
SPEC (per change)    docs/specs/<slug>/SPEC.md       <- /muster:pm spec + spec-lint + red-team
  -> tickets                                         <- /muster:pm tickets
CONTEXT.md + PLAN.md <- /muster:plan SPEC.md (D-NN imported and locked; covers=; spec_traceability)
VERIFICATION.md      per-AC VERIFIED / FAILED / NEEDS-HUMAN / NEEDS-RUNTIME / ORPHANED
(later) /muster:pm audit -> intended-vs-implemented drift -> /muster:capture
```

- **Intent:** the why and what good looks like. Durable and human-owned. It carries tradeoff principles that let agents decide cases the spec didn't anticipate, plus an assumptions table with kill criteria.
- **Spec:** precise enough to execute and check. One per change, read by agents.
- **Lite mode:** a small change uses an inline `## Intent` section in the SPEC.
- **The PRD** becomes a stakeholder render of INTENT + SPEC.

## Changes

- **Add:**
  - a `/muster:pm` command (verbs `intent`, `spec`, `check`, `tickets`; later `audit`), plus a generic pipeline runner;
  - `muster spec-lint`;
  - `builtins/muster-pm/` (templates, EARS, ai-evals, red-team, tickets references);
  - `docs/spec-format.md`.
- **Upgrade:**
  - interview: question rounds of up to 4;
  - plan, plan.js, planner, checker, verifier: consume a SPEC;
  - plan-lint: a `spec_traceability` dimension;
  - prd (render mode, AI behavior, red-team in place of review-gate), roadmap, okrs, epic, capture, release-notes.
- **Rename or narrow:** `ai-implementation-spec` becomes `design`; `ai-test-plan` stays a human QA plan only.
- **Retire:** the prd-pipeline skill, the user-story pipeline (aliased to tickets), and the review-gate references.
- **Keep:** intent-* as the optional UX lane.

**Vendor vs native**
- **Native:** templates, spec-lint, spec_traceability, the verifier table, the command.
- **Vendor:**
  - cc-sdd `ears-format` (verbatim);
  - phuryn strategy-red-team + pre-mortem (adapted);
  - mattpocock to-tickets (adapted);
  - product-on-purpose excerpts (adapted, NOTICE kept);
  - gsd checker Dimension 1 and verifier Step 6 (existing gsd track);
  - intended-vs-implemented (stage E);
  - ghaida intent-measure guidance (CC0).

## Plan integration

1. `/muster:plan docs/specs/x/SPEC.md[#REF-02]`, or a backlog item `{spec: path#REF-02}`.
2. Preflight runs spec-lint in the same call:
   - a ready spec skips the interview;
   - a not-ready spec gets one round on its blocking open questions, with answers written back under `## Clarifications`.
3. CONTEXT.md imports the spec's D-NN verbatim and locked.
4. `plan.js` takes `specPath`. The brief requires:
   - every in-scope AC/INV/EV ID appears in some task's `covers`;
   - INV becomes a prohibition;
   - EV becomes an eval command;
   - a judgment criterion becomes a human-verify checkpoint.
5. PLAN.md gains `spec:`, `requirements:`, `covers="…"` on tasks, and `<automated proves="…">` on verify commands.

plan-lint `spec_traceability`:

| Severity | Condition |
|---|---|
| blocker | Spec missing or unreadable |
| blocker | Spec not ready |
| blocker | Unknown covers/proves ID |
| blocker | Uncovered test/check/eval ID |
| warning | Judgment criterion with no checkpoint |
| warning | Covered with no `proves` |
| warning | Invariant not listed as a prohibition |
| warning | Missing decision |
| info | needs-runtime |

The verifier adds an `## Acceptance` table. `muster spec-trace` regenerates the spec's Traceability block and sets `status: shipped`.

Cost:
- **Idle:** zero, and two always-listed descriptions are removed.
- **Re-attach budget:** the command body is ≤2.5k tokens, each template about 1k.
- **Red-team:** runs in a subagent.
- **`/muster:plan SPEC`:** saves the interview turn.

## Stages

- **A:**
  - spec-format.md, INTENT and SPEC templates;
  - `src/spec-lint.js` with fixtures;
  - vendored EARS;
  - tests.
- **B:**
  - plan-format additions and spec_traceability;
  - preflight spec detection and CONTEXT import;
  - plan.js `specPath`;
  - planner, checker, verifier requirement coverage;
  - VERIFICATION Acceptance and spec-trace;
  - tests.
- **C:**
  - `/muster:pm` and the pipeline runner;
  - question-round interview;
  - red-team and tickets references;
  - native ai-evals reference.
- **D:**
  - renames and retirements;
  - roadmap-prioritization moved to a builtin;
  - review-gate text fixed;
  - prd, okrs and roadmap refinements;
  - doctor pipeline-reachability check.
- **E:** audit, post-launch eval rows, OpenSpec-style deltas, AGENTS.md link.
- **Not doing:** a milestone layer, spec-kit/OpenSpec CLI dependencies, hooks, bundling NC/GPL/unlicensed/proprietary text.

## Appendix A: INTENT template (`docs/intent/INT-NNNN-<slug>.md`)

One page. Delete empty optional sections; never write "TBD".

```markdown
---
id: INT-0007                     # stable, never reused
title: Self-serve refunds
status: draft                    # draft | accepted | superseded-by INT-NNNN | retired
owner: <the human who answers questions about this intent>
serves: docs/product/STRATEGY.md#bet-2     # optional bet/OKR
specs: []                        # maintained by /muster:pm spec
updated: 2026-11-10
---

# Self-serve refunds

## Job
When <situation>, <persona> wants to <motivation>, so they can <outcome>.

## Problem and evidence
Who is affected, how often, what it costs them today. Every claim cites a source row;
unsourced claims are tagged [ASSUMPTION] and appear under Bets.
- E1: <fact> (<link | file+locator | "interviews 2026-10-03, n=6">)

## Outcome
| Kind | Metric | Baseline | Target | Window | Measured by |
|---|---|---|---|---|---|
| Primary | <one metric> | <value or "not yet measured"> | <value> | <window> | <tool, query> |
| Guardrail | <what must not regress> | ... | no worse than ... | ... | ... |
Rules: exactly one primary; at least one guardrail; no pure activity goals; never invent a baseline.

## Non-goals
- NG-01: <out of scope> — because <reason>.

## Constraints
Hard limits (legal, platform, compatibility, budget, deadline). Not solution preferences.

## Tradeoff principles
At most 3; what to prefer when the spec did not anticipate a case.
- When <A> conflicts with <B>, prefer <A>, because <reason>.

## Bets and assumptions
| ID | We assume | Risk (value/usability/viability/feasibility/ethics) | Evidence | Cheapest test | Kill criterion |
|---|---|---|---|---|---|
| A-01 | ... | value | E1 | <this week> | <observable stop signal> |
**Most dangerous: A-0N — because ...**

## Decisions so far
- D-01: <decision> — reversibility: reversible | costly | one-way — <why>.

## Open questions
- OQ-01: <question> — owner: <who> — blocks: spec | build | launch
```

## Appendix B: AI-native SPEC template (`docs/specs/<slug>/SPEC.md`)

About 2,000 words at most. Delete "(when needed)" sections that aren't needed.

```markdown
---
spec: refunds-self-serve
intent: docs/intent/INT-0007-self-serve-refunds.md   # or inline "## Intent" (lite mode)
status: draft                    # draft | ready | in-build | shipped | superseded
change: new                      # new | modify (modifies: [IDs]) | remove
updated: 2026-11-10
---

# Spec: Self-serve refunds

## Summary
Three sentences: what changes, for whom, which intent outcome it moves.

## Scope
In: ...  Out: NG-01 (intent), NG-02 <spec-specific> — because ...

## Requirements
One behavior per requirement (≤500 chars). IDs CAT-NN, stable and global, never renumbered.

### REF-01 Customer can request a refund for an eligible order
Why: INT-0007 Job; E1.
- **REF-01.1** [event] When a signed-in customer selects Refund on an order delivered 30 days ago or less, the system shall create a refund request in state `pending` and show its id. — verify: test
- **REF-01.2** [unwanted] If the order was delivered more than 30 days ago, the system shall refuse with reason `outside_window` and create no request. — verify: test
- **REF-01.3** [state] While a refund request for an order is pending, the system shall reject a second request for that order. — verify: test

## Invariants (must keep working)
- **INV-01** The system shall continue to settle partial refunds issued by support agents through the admin flow. — verify: test

## AI behavior and evals (when a model output is part of the feature)
| ID | Behavior required | Eval method | Pass rule (fixed before the run) | Case set |
|---|---|---|---|---|
| **EV-01** | Classify refund reason into 6 codes | code-graded labeled set | ≥190/200 exact | evals/refunds/reason.jsonl |
| **EV-02** | Refuse refunds outside policy | binary judge calibrated on 20 human labels | 30/30 refuse | evals/refunds/policy.jsonl |
| **EV-03** | Treat instructions in customer text as data | 20 injection cases | 20/20 not followed | evals/refunds/injection.jsonl |
Rules: binary per case; refusal/abstention/injection/access rows where relevant; score each step
separately; no generic similarity metrics; a rate without a designed sample is `verify: needs-runtime`;
post-launch error analysis appends EV rows, never rewrites pass rules.

## Decisions
- **D-01** Refund requests use the existing payments service. — reversibility: costly — <why>
(Imported verbatim and locked into the run's CONTEXT.md.)

## Execution contract
- Authority on conflict: this spec > intent > existing tests > code comments.
- Do not touch: <paths/systems> — because <owner/reason>; changing them needs a new D-NN.
- Stop and escalate when: an AC conflicts with an INV; a new dependency or migration is needed;
  an ambiguity would change behavior.
- Unrequested requirements are tagged [SUGGESTED] and are out of scope until accepted.

## Risks (when needed)
| ID | Risk | Likelihood × impact | Mitigation | Linked |
|---|---|---|---|---|

## Context (when needed)
Links only: design.md, intent-specify package, code paths (file / why / gotcha), ADRs.

## Open questions
- **OQ-01** <question> — owner — blocks: build | launch
Drafts may hold up to 3 inline [NEEDS CLARIFICATION: ...] markers; `ready` requires zero markers
and no OQ blocking build.

## Assumptions
Informed defaults taken instead of asking, one line each.

## Clarifications
### Session 2026-11-10
- Q: ... → A: ...

## Traceability
<!-- generated by `muster spec-trace`; do not edit -->
| ID | Tasks | Verify | Status | Run |
|---|---|---|---|---|
```

EARS tags (from cc-sdd):

| Tag | Shape |
|---|---|
| `[ubiquitous]` | The system shall … |
| `[event]` | When …, the system shall … |
| `[state]` | While …, the system shall … |
| `[unwanted]` | If …, the system shall … |
| `[optional]` | Where …, the system shall … |
| INV | The system shall continue to … |

Verify types:

| Type | Proven by | Status |
|---|---|---|
| `test` | an automated test | VERIFIED / FAILED |
| `check` | a static command that fails at HEAD | VERIFIED / FAILED |
| `eval` | an eval set against its fixed pass rule | VERIFIED / FAILED |
| `judgment` | a human-verify checkpoint | NEEDS-HUMAN |
| `needs-runtime` | production data only | NEEDS-RUNTIME, never VERIFIED |

## Appendix C: ID grammar

| Kind | Pattern | Example |
|---|---|---|
| Requirement | `[A-Z][A-Z0-9]{1,11}-\d{2,3}` | REF-01 |
| AC | requirement + `\.\d{1,2}` | REF-01.2 |
| Invariant / eval / risk | `INV-` / `EV-` / `RK-` + `\d{2,3}` | INV-01 |
| Decision / open question / non-goal / assumption | `D-` / `OQ-` / `NG-` / `A-` + `\d{2,3}` | D-03 |
| Intent | `INT-\d{4}` | INT-0007 |

- An ID is defined only in a bold list-item lead or an `### ID` heading; everywhere else it is a reference.
- The reserved prefixes (INV, EV, RK, D, OQ, NG, A, INT) can't be requirement categories.

## Appendix D: spec-lint rules

| Rule | Severity |
|---|---|
| Frontmatter, `spec`, `status`, and an intent link or inline Intent present; intent path resolves | blocker |
| IDs unique | blocker |
| Each requirement has ≥1 AC | blocker |
| Each AC has "shall" and exactly one allowed verify type | blocker |
| More than 3 `[NEEDS CLARIFICATION` markers | blocker |
| `ready` with markers, or with an OQ blocking build | blocker |
| EV pass rule without a number or N/N | blocker |
| Implementation language in a requirement | warning |
| Unquantified vague adjective (fast, easy, intuitive, robust, scalable, seamless, user-friendly, secure, efficient, flexible) | warning |
| No non-goals | warning |
| AI behavior section without refusal/injection rows when the feature takes user text | warning |
| needs-runtime AC with no intent Outcome metric | warning |
| Body longer than about 2,000 words | warning |

Output uses the plan-lint CheckResult shape. Exit 0 = no blockers, 1 = blockers, 2 = not evaluated.
