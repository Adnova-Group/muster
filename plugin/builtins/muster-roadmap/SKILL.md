---
name: muster-roadmap
description: Built-in roadmap prioritizer — outcome-framed initiatives, cited evidence, RICE factors scored by `muster prioritize`, and a Now/Next/Later roadmap. Read by the roadmap pipeline.
muster_builtin: true
license: Apache-2.0
upstream:
  - kind: article
    title: "RICE: simple prioritization for product managers"
    author: Sean McBride (Intercom)
    url: https://www.intercom.com/blog/rice-simple-prioritization-for-product-managers/
    relation: inspired-by
  - kind: article
    title: The Now-Next-Later roadmap
    author: Janna Bastow (ProdPad)
    url: https://www.prodpad.com/blog/invented-now-next-later-roadmap/
    relation: inspired-by
---

<!-- prompt-lint-disable ANTH-ROLE-001, ANTH-FMT-001: read by a roadmap pipeline phase agent, whose brief supplies the role and the return format; this file is the procedure. -->

# Roadmap prioritization

Moved here from the `roadmap-prioritization` skill (PM domain stage D) so it costs nothing until
the `roadmap` pipeline runs (`/muster:pm run roadmap`, or `/muster:go` / `/muster:plan` on a
roadmap outcome). The pipeline's phases say which steps each phase owns; this file is how to do
them. If the evidence needed to estimate a factor is thin or absent, say so and lower confidence
rather than guessing.

1. **Generate** candidate initiatives from the goals, strategy and themes
   (`docs/product/STRATEGY.md` if present). Frame each as an **outcome**: the problem to solve,
   for whom, and the metric it should move. "Add saved searches" is a feature; "returning buyers
   find a repeat item in under 30 s (from 2 min)" is an outcome. One initiative per distinct bet.
   If the goal is too thin to mine (no strategy, no themes), stop and say what is missing; do not
   invent initiatives from a vague outcome.
2. **Evidence**: gather market, competitor and customer-feedback signal per initiative and cite
   each source. Every estimate rests on evidence, not vibes.
3. **Estimate RICE factors** per initiative: `reach` (count per quarter), `impact`
   (3 / 2 / 1 / 0.5 / 0.25), `confidence` (1, 0.8 or 0.5; thin or contested signal means lower
   confidence, full stop) and `effort` (person-months), each with a one-line rationale tied to the
   step-2 evidence.
4. **Score deterministically**: write `{ "items": [{ "name", "reach", "impact", "confidence",
   "effort" }], "model": "rice" }` to the file the phase names and run `muster prioritize <file>
   --model rice` (`npx -y @adnova-group/muster prioritize <file> --model rice` when `muster` is not
   on PATH). It returns the items ranked by `(reach × impact × confidence) / effort` with `score`
   and `rank`, and fails loud on non-finite or zero-effort input. **Code does the math; the model
   only supplies the factors.** Never hand-rank or edit the scores.
5. **Render the roadmap**: Now / Next / Later from the ranking, each item stated as its outcome
   and the metric it moves, with the RICE table (name, R, I, C, E, score, rank), a short
   sequencing rationale and the dependencies between initiatives. A Now item with no intent gets an
   INT stub from the muster-pm INTENT template (the pipeline's draft phase says how).
6. **Glass box**: keep the factor rationales and the ranking in the roadmap so it traces back to
   the evidence it rests on.

## After the pipeline (main thread only)

Phase agents cannot ask the user anything. When the run finishes, the session that started it may
offer, through AskUserQuestion, to file the top N initiatives as GitHub issues (`gh issue create`)
and to add them to a GitHub Project board with a single-select Status of Now / Next / Later
(reuse a project with the same title before `gh project create`). Fail soft: with no remote, no
`gh`, or no `project` scope on the token, skip the step and say why in the roadmap. Record the
issue and board URLs, or the reason for skipping, in the roadmap.
