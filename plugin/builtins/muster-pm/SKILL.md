---
name: muster-pm
description: PM artifact kit for AI-native teams — INTENT and SPEC templates, the EARS requirement patterns and AI-eval guidance, all checked by `muster spec-lint`; read it before writing or reviewing an intent or a spec.
muster_builtin: true
license: Apache-2.0
upstream:
  - repo: gotalab/cc-sdd
    ref: e2a0c671aef37a482404905b409ab5c27092b25b
    path: tools/cc-sdd/templates/shared/settings/rules/ears-format.md
    license: MIT
    relation: vendored
  - repo: ghaida/intent
    ref: 1806110106a472bc588d7a8a2b7e3d39aee4a4b8
    path: skills/measure/SKILL.md
    license: CC0-1.0
    relation: adapted
  - repo: mattpocock/skills
    ref: 4ae2317ddb22b046e26455e4f9c9b3aaaf62212d
    path: skills/engineering/to-tickets/SKILL.md
    license: MIT
    relation: adapted
  - repo: phuryn/pm-skills
    ref: 9af7bfd0bc47fdad43c2eaa7a43cd13918e7aaef
    path: pm-execution/skills/strategy-red-team/SKILL.md
    license: MIT
    relation: adapted
  - repo: github/spec-kit
    ref: 08252af8c5fb1c68135768fde2049d6578fa46c3
    path: null
    license: MIT
    relation: inspired-by
  - repo: Fission-AI/OpenSpec
    ref: 579fcac57ae00c2dff38f971b6d88b6f1f098b8a
    path: null
    license: MIT
    relation: inspired-by
  - repo: Wirasm/prp
    ref: 435292597e7b04f64f8f275da9d2c985c4251281
    path: null
    license: MIT
    relation: inspired-by
  - repo: product-on-purpose/pm-skills
    ref: 9b920db418c5bf641edea9afb4915a286e1d42ea
    path: skills/deliver-prd/SKILL.md
    license: Apache-2.0
    relation: adapted
  - repo: phuryn/product-engineering
    ref: 061014ffe954b4dca1f108de614ce25e4607161e
    path: ai-shipping/skills/intended-vs-implemented/SKILL.md
    license: MIT
    relation: adapted
  - repo: open-gsd/gsd-core
    ref: 9385f4618b52ef68ed8a5e8bdd93cfb25bd87765
    path: gsd-core/templates/requirements.md
    license: MIT
    relation: inspired-by
  - kind: article
    title: Define success criteria and build evaluations (Claude Docs)
    author: Anthropic
    url: https://platform.claude.com/docs/en/test-and-evaluate/develop-tests
    relation: inspired-by
  - kind: article
    title: Demystifying evals for AI agents
    author: Anthropic
    url: https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents
    relation: inspired-by
  - kind: article
    title: Evaluation best practices (OpenAI API docs)
    author: OpenAI
    url: https://developers.openai.com/api/docs/guides/evaluation-best-practices
    relation: inspired-by
  - kind: article
    title: Your AI Product Needs Evals
    author: Hamel Husain
    url: https://hamel.dev/blog/posts/evals/
    relation: inspired-by
  - kind: article
    title: "AI Evals: Everything You Need to Know"
    author: Hamel Husain and Shreya Shankar
    url: https://hamel.dev/blog/posts/evals-faq/
    relation: inspired-by
---

<!-- prompt-lint-disable ANTH-ROLE-001, ANTH-FMT-001, GUARD-IDK-001: a file index read on demand by whoever writes or reviews an intent or spec; the caller supplies the role and output format, and the files it points at are document templates, not prompts that answer questions. -->

# muster-pm

The files muster uses to write product intent and change specs that agents can execute and the
verifier can check. The templates carry the format rules as comments and `muster spec-lint`
enforces them; this index says which file to open and when. Read only what the task needs.

## The chain

| Artifact | Lives at | Owner | Answers |
|---|---|---|---|
| INTENT (durable) | `docs/intent/INT-NNNN-<slug>.md` | a human | why, for whom, what good looks like, which tradeoffs win |
| SPEC (per change) | `docs/specs/<slug>/SPEC.md` | the change | exactly what changes and how each part is proven |

One intent serves many specs. A small change skips the intent file and carries an inline
`## Intent` section in its spec (lite mode). A PRD is a rendering of intent plus spec for
stakeholders, not a third source of truth.

## Files

| File | What it is | Read it when |
|---|---|---|
| [templates/INTENT.md](templates/INTENT.md) | One-page intent: Job, evidence, Outcome (one primary metric, guardrails), non-goals, constraints, at most 3 tradeoff principles, bets with kill criteria, decisions, open questions | Writing or revising an intent, or deciding whether a request needs one |
| [templates/SPEC.md](templates/SPEC.md) | Change spec: scope, requirements with EARS acceptance criteria and verify types, invariants, AI behavior evals, decisions, execution contract, open questions, clarifications, traceability | Writing a spec, converting a PRD or ticket into one, or reviewing one before build |
| [references/ears.md](references/ears.md) | The five EARS patterns (event, state, unwanted, optional, ubiquitous), vendored verbatim from gotalab/cc-sdd | Phrasing an acceptance criterion, or when spec-lint flags an EARS tag |
| [references/ai-evals.md](references/ai-evals.md) | How to write EV rows: binary pass rules fixed up front, a slot for evals found by error analysis, no similarity metrics, designed samples for rates, refusal / abstention / injection rows, and how post-launch rows are appended | A model output is part of the feature, spec-lint flags an EV row, or error analysis found a new failure pattern |
| [references/red-team.md](references/red-team.md) | Red-team and pre-mortem: load-bearing claims, ranked kill-assumptions with the cheapest test, mapped onto A-NN / RK-NN / OQ-NN (adapted from phuryn/pm-skills) | A subagent stress-tests a spec, intent or PRD before it is called ready |
| [references/tickets.md](references/tickets.md) | Spec to tracer-bullet backlog items that cite acceptance-criterion IDs, published with `muster backlog-publish` (adapted from mattpocock/skills to-tickets) | Splitting a ready spec into work |
| [references/audit.md](references/audit.md) | Intended vs. implemented: compare a shipped spec and its intent with the code, both sides cited, findings for /muster:capture (adapted from phuryn/product-engineering) | Checking a shipped change for drift |

`/muster:pm` runs these: `intent`, `spec` (lint plus a red-team subagent), `check`, `tickets`,
`audit`, and `run <pipeline>` for any PM pipeline.

**Brownfield deltas.** A change to an already-specified feature is its own spec with
`change: modify`, `base: <the spec it changes>` and `modifies: [IDs]`. It restates each changed
requirement in full under its base ID and adds new requirements with new IDs; spec-lint checks
that every listed ID exists in the base spec and that no base ID is redefined without being
listed (docs/spec-format.md, "Delta specs").

ears.md keeps cc-sdd's wording, including its note on the `spec.json` language setting; muster
has no such file, so write criteria in the project's language and keep the EARS keywords
(When, If, While, Where, shall) in English.

## Writing a spec

1. Start from [templates/SPEC.md](templates/SPEC.md). Delete every section marked "(when needed)"
   that is not needed; never write TBD.
2. One requirement per user-visible capability (`### REF-01 <title>`), one behavior per
   criterion (`- **REF-01.1** [event] When …, the system shall … — verify: test`). IDs are stable
   and never renumbered; a removed requirement keeps its ID retired.
3. Pick the verify type by what can prove it: `test` (automated test), `check` (a static command
   that fails before the work), `eval` (an EV row's pass rule), `judgment` (a human checkpoint),
   `needs-runtime` (production data only; never verified before launch).
4. Say what, not how. Storage, framework and endpoint choices go to `## Decisions` (D-NN), which
   the plan imports and locks.
5. Prefer an informed default recorded under `## Assumptions` to a question. At most 3 inline
   `[NEEDS CLARIFICATION: …]` markers; a spec is `ready` only with zero markers and no open
   question that blocks build.
6. Run `muster spec-lint docs/specs/<slug>/SPEC.md` and fix every blocker. Warnings are judgment
   calls; fix them or leave them on purpose.

## Writing an intent

Start from [templates/INTENT.md](templates/INTENT.md). Exactly one primary metric; at least one
guardrail; never invent a baseline ("not yet measured" is a value). Every assumption gets a
cheapest test and an observable kill criterion; name the most dangerous one. Lint it with
`muster spec-lint docs/intent/INT-NNNN-<slug>.md` (auto-detected; `--intent` forces it).

## Planning from a spec (stage B, not yet wired)

A later stage teaches `/muster:plan docs/specs/<slug>/SPEC.md` to skip the interview for a
ready spec, import its decisions into the run context, and require every criterion, invariant and
EV ID to be covered by a plan task. Until then, paste the spec path into the outcome text and the
planner reads it like any other context file.
