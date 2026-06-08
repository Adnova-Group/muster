# Pipelines

A pipeline is a phased, gated recipe for producing one kind of artifact. Each pipeline declares a `domain`, an ordered list of `phases` (each phase names a `role`), and a `gate`. Pipelines live as YAML in `pipelines/` and cover both software and knowledge work.

## Routing

Routing to a pipeline is deterministic. `muster route "<outcome>"` matches the outcome against each pipeline's `match` keywords on word boundaries; if nothing matches, it falls back to the domain default.

```sh
npx @adnova-group/muster route "draft a PRD for a referral program"
npx @adnova-group/muster pipeline prd
```

## The gate: a floor principle

Gating uses a **floor principle**: the weakest dimension must clear the gate's floor, and the total must clear a pass threshold. A strong average cannot rescue one weak dimension. Scoring is deterministic and fails loud on non-finite inputs. The model only estimates the per-dimension scores; the code decides pass or fail.

## Humanize

Human-facing pipelines end with a `humanize` phase. The `muster-humanizer` built-in strips em-dashes, banned AI-tell words, and robotic cadence. Machine-facing AI specs (the implementation-spec and test-plan pipelines) are exempt, to preserve technical precision.

## The set

The catalog spans software and knowledge work:

- **Product**: PRD, epic, user-story, roadmap
- **Business**: business-case, executive-summary, OKRs, competitive-battlecard
- **Launch and comms**: launch-plan, release-notes, case-study
- **Content**: blog-post, social-post, newsletter, lead-magnet, book (fiction and non-fiction)
- **Engineering specs**: AI implementation spec, AI test plan
- **Operations**: runbook

## Roadmap prioritization

One pipeline worth calling out. Goals go in, a prioritized now/next/later roadmap comes out. The model estimates the factors with evidence-backed rationale; `muster prioritize` does the arithmetic and fails loud on bad input. RICE is the default, with `ice`, `wsjf`, and `weighted` also available. See [prioritization models](/reference/commands#prioritization-models).

The roadmap skill can render the ranking to a doc, optionally file the top-N initiatives as GitHub issues, and optionally push them onto a GitHub Project board with status columns by tier. Each external step degrades gracefully, skipping with a note when `gh` access is unavailable.

Next: the full [Architecture](/reference/architecture).
