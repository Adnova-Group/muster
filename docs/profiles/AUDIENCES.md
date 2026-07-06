# Audience profiles

Named audience profiles that content pipelines (`blog-post`, `social-post`, and
any future content pipeline that adopts the pattern) resolve the target
audience to, so register, jargon, and depth stay consistent for a given
audience across runs instead of being re-invented from scratch every time.

**Why this lives here, in git, and not under `.muster/`:** `.muster/` is
gitignored — anything written there evaporates at the end of a session and
never compounds across runs. This file is committed instead (same rationale as
`docs/qa/RUNBOOK.md`), so the next run inherits the calibration the last one
worked out instead of re-guessing jargon and depth from zero.

## How pipelines use this file

During the `intake`/`brainstorm` phase, resolve the stated or implied target
audience to one of the named profiles below. If none fits, create a new
profile section following the schema, or extend an existing one (e.g. add a
term to its jargon allowlist) if the brief surfaces a gap — don't fork a
near-duplicate profile for a one-off variation. During `draft`, calibrate
register, jargon, and depth to the resolved profile's fields.

## Profile schema

Each profile is a `##` section with these fields:

- **Name** — the profile's identifier, referenced by pipelines (kebab-case).
- **Expertise level** — one of `novice`, `practitioner`, `expert`, or a named
  mix (e.g. "technical practitioner, business novice") when the audience spans
  two domains at different depths.
- **Jargon allowlist** — terms safe to use unexplained; the audience already
  has this vocabulary.
- **Jargon banlist** — terms to avoid or that must be defined inline on first
  use; the audience does not reliably have this vocabulary, or the term reads
  as insider-speak that erodes trust.
- **Altitude/depth** — how close to implementation detail vs. outcome/impact
  the content should sit (e.g. "code-level detail welcome" vs. "outcomes and
  ROI only, no implementation detail").
- **Preferred formats** — structural conventions this audience responds to
  (e.g. code blocks + CLI transcripts vs. narrative + charts).

## Seed profiles

### technical-operator

- **Expertise level:** practitioner to expert — hands-on-keyboard engineers,
  SREs, platform/DevOps staff who will run or maintain what's described.
- **Jargon allowlist:** CLI, API, CI/CD, latency, throughput, idempotent,
  observability, rollback, canary, on-call, SLA/SLO, YAML, schema, regression.
- **Jargon banlist:** marketing-speak ("synergy", "best-in-class",
  "game-changing", "revolutionary", "seamless" as a filler adjective) — reads
  as evasive to this audience; if a claim is true, state the mechanism instead
  of the adjective.
- **Altitude/depth:** implementation detail welcome and expected — concrete
  commands, config, error modes, and edge cases beat summarized outcomes. Show
  the actual command/output, not a paraphrase of what it does.
- **Preferred formats:** code blocks and terminal transcripts, numbered
  step-by-step procedures, tables for config/flag reference, explicit
  before/after diffs. Prose is a connective layer between artifacts, not the
  main payload.

### business-buyer

- **Expertise level:** novice to practitioner on implementation; often
  expert in their own domain (finance, ops, their industry) but not in the
  underlying technology.
- **Jargon allowlist:** ROI, TCO, time-to-value, headcount, risk, compliance,
  vendor lock-in (as a named concern, not explained mechanics), payback
  period, business terms native to the buyer's own function.
- **Jargon banlist:** implementation-level technical terms unless directly
  tied to a business consequence (e.g. don't say "idempotent retries" — say
  "a failed run can be safely retried without double-charging customers").
  Undefined acronyms below the executive-summary layer (API, SDK, CI/CD)
  should either be spelled out on first use or dropped in favor of the
  outcome they enable.
- **Altitude/depth:** outcomes, cost, risk, and timeline — no implementation
  detail unless it's the single fact that changes a purchase decision. Answer
  "what does this mean for my budget/risk/timeline" before anything else.
- **Preferred formats:** narrative framing with a clear takeaway up front,
  short paragraphs, comparison tables (cost/risk/timeline vs. alternatives),
  pull-quotes or callouts for the one number that matters. Avoid dense code or
  config examples entirely.
