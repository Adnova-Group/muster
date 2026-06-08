---
name: roadmap-prioritization
description: Turn goals into a RICE-prioritized now/next/later roadmap — generate candidate initiatives, gather market+customer-feedback evidence, estimate RICE factors, let `muster prioritize` do the math, render a roadmap doc (+ optional GitHub issues).
---

# Roadmap prioritization

The implementation skill behind the `roadmap` pipeline (pm domain). Load it with
`npx muster pipeline roadmap`; the pipeline's **prioritize** phase is where step 4 below runs. Run the
flow anchored to the outcome — goals, strategy, themes in, a prioritized roadmap out.

1. **Generate** candidate initiatives from the goals/strategy/themes — brainstorm broadly, one
   initiative per distinct bet. If the goal is thin (no clear strategy or themes to mine), reuse the
   **interview** skill first to enrich it; do not invent initiatives from a vague outcome.
2. **Evidence** — gather market, competitor, and CUSTOMER-FEEDBACK signal per initiative
   (research / docs-research). Every estimate must rest on evidence, not vibes; cite the source.
3. **Estimate RICE factors** per initiative — `reach` (count per period), `impact`, `confidence`,
   `effort` — each with a one-line rationale tied to the step-2 evidence. **Confidence reflects
   evidence strength**: thin or contested signal means lower confidence, full stop.
4. **Score deterministically** — write the initiatives to a JSON file
   (`{ items:[{name,reach,impact,confidence,effort}], model: "rice" }`) and run
   `npx muster prioritize <file> --model rice`. It returns the items ranked by RICE score
   `(reach*impact*confidence)/effort` with `score` + `rank`, and fails loud on non-finite or
   zero-effort inputs. **Code does the math; the model only supplies the factors** — never hand-rank.
   This is the muster principle: deterministic transforms belong in code.
5. **Render the roadmap doc** — a now/next/later structure (or ranked tiers) derived from the RICE
   ranking, with the RICE score table (name, R, I, C, E, score, rank), a short sequencing rationale,
   and dependencies between initiatives. Write it to a roadmap doc — default `docs/roadmap.md`, or a
   user-named path.
6. **Optional GitHub issues** — offer (via the **AskUserQuestion** selection UI: how many top items, or
   none) to file the top-N initiatives as GitHub issues via `gh issue create`. Degrade gracefully: with
   no remote or no `gh`, skip and note it in the doc (same graceful pattern as issue input).
7. **Glass box** — record the factor rationales and the ranking in the doc and run STATE so the roadmap
   is traceable back to the evidence it rests on.
