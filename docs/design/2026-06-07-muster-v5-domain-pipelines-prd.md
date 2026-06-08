# Muster slice 5 — Domain pipelines (framework + PRD)

- Status: draft for review
- Date: 2026-06-07
- Builds on: slices 1–4 (router/detect, fan-out/review, native built-ins, autopilot/greenfield)

## 1. What slice 5 adds

So far Muster assumes the **software** domain. Slice 5 makes work-domain first-class — the
differentiator vs every dev tool — by adding (a) **domain detection** (hybrid), (b) a **pipeline
registry** (domain → phased pipeline), and (c) the first non-code pipeline: **PRD / product-spec**,
the canonical PM artifact and ForceVue's flagship. PM/business is the primary audience; software was
just the proving ground.

Decisions: domain detection is **hybrid** (outcome intent + workspace signals + explicit override);
the first pipeline is **PRD**, a phased flow (intake → research → draft → review → score) reusing
slice-2's review gate + a book-genesis-style scoring gate with a floor principle.

## 2. Goals / non-goals

**Goals**
1. `classifyDomain(outcome, profile, override)` — deterministic domain pick (override > outcome
   keywords > workspace signal > unknown) with `{domain, source, confidence}`. Router refines `unknown`.
2. Pipeline registry: `pipelines/*.yaml` + `loadPipelines` / `validatePipeline` (id, domain, phases[], gate).
3. `pipelines/prd.yaml` — the PRD pipeline (phases + role per phase + scoring rubric + floor).
4. `scoreArtifact(scores, floor)` — deterministic score tally with the floor principle.
5. CLI: `muster domain <outcome> [--domain x]`, `muster pipeline <domain|id>`, `muster score <file>`.
6. Skills: **prd-pipeline** (run the phases, reuse review-gate, score, gate on floor) and a
   **domain-router** step (classify → select pipeline → run, else fall to the software flow).
7. Glass Box: domain choice + per-phase outputs + scores recorded.

**Non-goals (deferred)**
- Other pipelines (business case, marketing, ops) — quick adds via the same registry afterward.
- Expanding the formal role enum — pipelines reference roles as free strings, resolved by the
  slice-1 ladder (installed → builtin → inline); PM roles (research/author/review/score) resolve to
  knowledge-work/context7/built-ins when present, else inline.
- ForceVue connector (push the PRD with lineage) — later.
- Remote control (S5), other-CLI adapters (S1).

## 3. Domain detection (hybrid) — `classifyDomain`

Deterministic precedence:
1. **override** (`--domain pm`) → that domain, source `override`.
2. **outcome keywords** → first domain whose keyword set matches the outcome text, source `outcome`.
   - pm: prd, product spec, user story, epic, roadmap, requirements, product brief
   - business: business case, investor, pitch, financial model, market analysis
   - marketing: lead magnet, campaign, landing page, gtm, go-to-market, email sequence
   - ops: runbook, sop, operations, process doc, incident
   - software: implement, refactor, bug, api, endpoint, function, deploy
     (note: `test` deliberately excluded — substring-matches "latest"/"attestation"; revisit with
     word-boundary matching before growing the keyword sets)
3. **workspace signal** → a real code project (`profile.shape !== unknown && !greenfield`) ⇒ software,
   source `workspace`.
4. else `{domain: "unknown"}` — the **router skill** classifies via model judgment (glass-box: records
   it chose by model + why). This is the named model path for the ambiguous case.

Pure/deterministic for 1–3; unit-tested. Output threads into routing + is recorded in the manifest.

## 4. Pipeline registry — `pipelines/*.yaml`

Each pipeline:
```yaml
id: prd
domain: pm
title: Product Requirements Document
phases:
  - { id: intake,   role: brainstorm,     desc: "clarify problem, audience, success metrics" }
  - { id: research, role: docs-research,  desc: "gather evidence, market/competitor/customer context" }
  - { id: draft,    role: author,         desc: "draft PRD sections (problem, goals, scope, reqs, metrics)" }
  - { id: review,   role: code-review,    desc: "adversarial review gate (reuse review-gate)" }
  - { id: score,    role: score,          desc: "score vs rubric, apply floor principle" }
gate:
  criteria: [problem-clarity, outcome-alignment, evidence, scope-discipline, feasibility, measurability]
  floor: 2          # each dimension scored 0-3; the weakest must be >= floor (book-genesis floor)
  pass_total: 14    # and total must clear this threshold
```
`loadPipelines(dir)` reads `pipelines/*.yaml`; `validatePipeline` checks id/domain/phases/gate shape.
Phases reference roles as free strings (resolved by the slice-1 ladder).

## 5. Scoring — `scoreArtifact(scores, gate)`

Book-genesis-style. Input: `scores` = `{ [criterion]: 0..3 }`, `gate` = `{ floor, pass_total }`.
Output: `{ total, weakest: {criterion,value}, passing }` where `passing = weakest.value >= floor &&
total >= pass_total`. Deterministic, unit-tested. The judge (model) produces the per-criterion
evidence-cited scores; `scoreArtifact` makes the pass/fail call deterministically.

## 6. Skills (model-facing)

- **domain-router** (extends the slice-1 router): run `muster domain <outcome>`; if a pipeline matches
  the domain, hand to that pipeline skill; else proceed with the existing software route/manifest flow.
- **prd-pipeline**: execute `pipelines/prd.yaml` phase by phase —
  intake (clarify), research (dispatch docs-research/knowledge-work providers), draft (author role),
  review (reuse the **review-gate** skill), score (judge → `muster score` → floor gate). On gate fail,
  loop the draft/review with the weakest dimension called out (capped, then escalate). Output a
  finished PRD + the score card. Each phase + score recorded in STATE (glass box, checkbox per phase).

## 7. CLI additions (deterministic, TDD-able)

- `muster domain <outcome> [--domain x]` → `{domain, source, confidence}`.
- `muster pipeline <domain|id>` → the matching pipeline definition (or null).
- `muster score <scores.json>` (with the pipeline's gate) → `scoreArtifact` result.

## 8. Glass-box / DNA fidelity

Outcome-anchored (the PRD's success criteria drive the rubric); glass-box (domain choice + each phase
output + per-criterion scores recorded); compounding memory (the PRD + score card written to the
LLM-Wiki memory, ready for the later ForceVue connector). Recommendation overlay still fires (e.g.
"install a research MCP / knowledge-work PM plugin for stronger research").

## 9. Graceful degradation & error handling
- `classifyDomain` unknown → router model classifies (never guesses silently — records the model call).
- A phase role with no provider → builtin/inline (PRD still drafts inline if no author/research provider).
- Score gate fail past the cap → escalate with the weakest dimension; don't ship a failing PRD.
- Unknown pipeline / domain with no pipeline → fall back to the software flow (or report no pipeline).

## 10. Testing strategy
- `classifyDomain` (TDD): override wins; each domain's keyword; workspace→software; unknown.
- `loadPipelines`/`validatePipeline` (TDD): valid prd.yaml; reject missing phases/gate.
- `scoreArtifact` (TDD): floor fail (one weak dim), total fail, pass; weakest reported.
- CLI smoke: `domain`, `pipeline prd`, `score`.
- prd-pipeline / domain-router **skills**: scenario-shape (phase sequence, gate-loop, escalation),
  not LLM prose.

## 11. Open questions
1. PRD rubric dimensions/weights (proposed 6 dims, 0-3, floor 2, pass_total 14) — tune at review.
2. PM role names (research/author/review/score) — keep as free strings or formalize later.
3. Whether `draft` should itself be a tournament (competing PRD drafts judged) — natural reuse of
   slice-2 tournament; proposed: optional, default single for v1.

## Change log

### 2026-06-07 — Initial slice-5 draft
- **What changed:** First design for domain pipelines: hybrid `classifyDomain`, a `pipelines/*.yaml`
  registry + loader/validator, the PRD pipeline (phases intake→research→draft→review→score), a
  deterministic `scoreArtifact` with the floor principle, CLI `domain`/`pipeline`/`score`, and the
  prd-pipeline + domain-router skills reusing slice-2 review/scoring. Roles referenced as free strings
  resolved by the slice-1 ladder (no enum expansion).
- **Why:** make PM/business work first-class — Muster as a business-outcome engine, not a dev tool —
  starting with the PRD (the user's domain + ForceVue's flagship), with the framework reusable for
  business-case/marketing/ops pipelines next.
