# Pipelines

A pipeline is a phased, gated recipe for producing one kind of artifact. Each pipeline declares a `domain`, an ordered list of `phases` (each phase names a `role`), and a `gate`. Pipelines live as YAML in `pipelines/` and cover both software and knowledge work.

## Routing

Routing to a pipeline is deterministic. `muster route "<outcome>"` matches the outcome against each pipeline's `match` keywords on word boundaries; if nothing matches, it falls back to the domain default.

```sh
npx -y @adnova-group/muster route "draft a PRD for a referral program"
npx -y @adnova-group/muster pipeline prd
```

## The gate: a floor principle

Gating uses a **floor principle**: the weakest dimension must clear the gate's floor, and the total must clear a pass threshold. A strong average cannot rescue one weak dimension. Scoring is deterministic and fails loud on non-finite inputs. The model only estimates the per-dimension scores; the code decides pass or fail.

## Humanize

Human-facing pipelines end with a `humanize` phase. The `muster-humanizer` built-in strips em-dashes, banned AI-tell words, and robotic cadence. Machine-facing documents (the design-doc and QA test-plan pipelines) are exempt, to preserve technical precision.

## The set

There are **19 pipelines**, spanning software and knowledge work. Ask for any of them by id, or list them all with `muster pipeline --list`:

```sh
# print one pipeline's phases, roles, and gate
npx -y @adnova-group/muster pipeline runbook
npx -y @adnova-group/muster pipeline release-notes
```

`pipeline` also accepts a domain (`pipeline ops`, `pipeline pm`), which resolves that domain's default pipeline. The set:

- **Product**: PRD (it can also render an existing intent and spec for stakeholders), epic, roadmap (outcome-framed, with intent stubs for its Now items)
- **Business**: business-case, executive-summary, OKRs, competitive-battlecard
- **Launch and comms**: launch-plan, release-briefing (`release-notes.yaml`; three audience-split artifacts -- technical changelog, user briefing, announcement post -- from one draft phase), case-study
- **Content**: blog-post, social-post, newsletter, lead-magnet, video-content, book (fiction and non-fiction)
- **Engineering specs**: design doc (`design`; the old id `ai-implementation-spec` still resolves), human QA test plan (`ai-test-plan`)
- **Operations**: runbook

Content pipelines that resolve an audience or a voice read named profiles from `docs/profiles/`: `AUDIENCES.md` (depth, jargon, altitude), `VOICE.md` (register, rhythm, anti-patterns), and `BRAND.md` (a visual anchor for the `image`/`video` roles) -- created or extended on first use, not hand-authored up front. Blog-post, lead-magnet, and social-post also carry an `optional_phases: [publish]` phase: skippable, terminal, and scoped to assembling the ready-to-publish packet and evidence -- never the deploy/post/send act itself, which stays behind the [action-class fence](/reference/architecture#session-hooks).

## Roadmap prioritization

One pipeline worth calling out. Goals go in, a prioritized Now/Next/Later roadmap of outcomes comes out. The model estimates the factors with evidence-backed rationale; `muster prioritize` does the arithmetic and fails loud on bad input. RICE is the default, with `ice`, `wsjf`, and `weighted` also available. See [prioritization models](/reference/commands#prioritization-models).

The `muster-roadmap` built-in it reads can render the ranking to a doc, optionally file the top-N initiatives as GitHub issues, and optionally push them onto a GitHub Project board with status columns by tier. Each external step degrades gracefully, skipping with a note when `gh` access is unavailable.

## Running a pipeline by name

`/muster:go` and `/muster:plan` route an outcome to a pipeline by its keywords. `/muster:pm run <pipeline> [outcome]` runs any pipeline by id, through the same `muster pipeline-args` and `muster:pipeline` workflow; `/muster:pm run` alone lists them. The user-story pipeline is retired: `/muster:pm tickets <SPEC.md>` turns a spec into backlog items that cite its acceptance-criterion IDs. `muster doctor` checks that every pipeline stays reachable this way and that its sources are in `vendor/manifest.yaml`.

Next: the full [Architecture](/reference/architecture).
