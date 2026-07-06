# Voice profiles

Named voice profiles that content pipelines (`blog-post`, `social-post`,
`newsletter`, and any future content pipeline that adopts the pattern) resolve
to during `draft`, so register and rhythm stay consistent for a given voice
across runs instead of being re-invented from scratch every time.

This composes with `docs/profiles/AUDIENCES.md`, it does not replace it: the
**audience profile** sets depth and jargon (how much the reader already
knows), the **voice profile** sets register and rhythm (how the sentences
sound). A single draft resolves both and calibrates to each independently.

**Why this lives here, in git, and not under `.muster/`:** same rationale as
`AUDIENCES.md` and `docs/qa/RUNBOOK.md` — `.muster/` is gitignored, so
anything written there evaporates at the end of a session. This file is
committed instead, so the next run inherits the calibration the last one
worked out.

## How pipelines use this file

During `draft`, resolve the stated or implied target voice to one of the
named profiles below (alongside the audience-profile resolution from
`intake`). If none fits, create a new profile section following the schema,
or extend an existing one — don't fork a near-duplicate for a one-off
variation. The humanizer (`plugin/builtins/muster-humanizer/SKILL.md`) reads
the resolved profile too: its anti-patterns list is checked before the
generic humanize-score pass.

## Profile schema

Each profile is a `##` section with these fields:

- **Name** — the profile's identifier, referenced by pipelines (kebab-case).
- **Register rules** (3-5) — the recurring structural patterns of the voice:
  sentence rhythm (short/long mix, where the "why" clause attaches), person
  (first/second/third, imperative vs. narrative), formality (plain-spoken vs.
  ornamental), and any other axis that recurs across the source samples.
  These are rules derived from evidence, not adjectives someone wishes were
  true of the writing.
- **Anti-patterns** — phrases or constructions this voice never uses. A
  violation of this list is a **finding** when the humanizer checks a draft
  against the profile (see the humanizer skill).
- **Contextual rules** — how the voice shifts across content types (e.g.
  technical vs. promotional) if it shifts at all. Most real voices are not
  perfectly uniform; name the axis of variation instead of pretending there
  is none.
- **Derived from** — the actual files/samples the profile was built from, so
  a future edit can re-derive instead of guessing at what changed.

## Deriving a profile from samples

A voice profile is extracted from evidence, not vibes. To build one:

1. **Collect 5-10 representative writing samples** of the target voice — not
   one paragraph. A single passage can't distinguish a real pattern from a
   one-off stylistic choice.
2. **Mark each sample** for: sentence-length pattern (uniform vs. bursty),
   where the "why"/justification clause attaches to its main clause (a
   subordinate conjunction, a colon, an em-dash aside, or a separate
   sentence), person (first/second/third), and whether hedges, adjectives, or
   marketing language appear.
3. **Tally what recurs across at least 3 of the samples.** A pattern that
   shows up in one sample is noise; a pattern that shows up in most of them
   is a register rule. Write only the recurring patterns down as rules —
   this is the mechanism that keeps the profile honest instead of aspirational.
4. **Anti-patterns come from consistent absence.** If a construction (e.g.
   exclamation points, first-person "we believe" framing, rhetorical-question
   openers) never appears across all the samples, that absence is itself
   evidence — list it as an anti-pattern.
5. **Contextual rules come from splitting the samples by content type.** If
   the samples span, say, technical documentation and promotional copy,
   compare the two groups and note where the register actually diverges
   (rather than assuming a single voice is uniform everywhere).

## Seed profiles

### muster-maintainer

- **Derived from:** `README.md`, `CONTRIBUTING.md`, `docs/qa/RUNBOOK.md` —
  the repo's own docs prose, not marketing copy, so this profile is honest
  about what "muster's voice" actually looks like on the page today.

- **Register rule — rhythm (short declarative + one load-bearing aside):**
  A short declarative sentence states a fact, then a single em-dash or colon
  clause supplies the mechanism or rationale behind it, in the same
  sentence — it is not decorative. Examples: RUNBOOK's *"`.muster/` is
  gitignored (`git check-ignore .muster/x` confirms it) — anything written
  there evaporates at the end of a session and never compounds across
  runs"*; README's *"Every decision is inspectable: which role resolved to
  which provider, on which model, and why."* The aside answers "why should I
  believe this," not "here's a flourish."

- **Register rule — person (imperative/third, never first):** Instructions
  are imperative ("Clone the repo, then install dependencies", "Run the test
  suite with"), and everything else is third-person description of what the
  system does ("It detects your project, discovers the capabilities you
  already have installed..."). No first-person "I"/"we" framing appears in
  any of the three samples.

- **Register rule — formality (plain, exact, no adjectives standing alone):**
  Technical nouns are used precisely (role, gate, floor principle,
  `pipelineForDomain`) instead of being dressed up. CONTRIBUTING's *"There is
  a single runtime dependency (`yaml`), so install is quick"* states the fact
  and lets the reader draw the "quick" conclusion from the number, not from
  an adjective doing the work alone.

- **Register rule — evidence-first (claim, then the mechanism, in that
  order):** A claim is immediately followed by the specific mechanism that
  backs it, never left to stand on its own. RUNBOOK: *"Keep it real: every
  command below was run against this repo and the output pasted is what
  actually came back, not a guess."* README: *"muster capabilities walks this
  ladder for every role and reports the winner, the full fallback chain,
  installable recommendations, and the chosen model."*

- **Register rule — density (one idea per sentence, short paragraphs):**
  Paragraphs run 2-4 sentences. Compound sentences join two facts with "and"
  or "so," not with stacked subordinate clauses. No filler transition
  sentences between paragraphs.

- **Anti-patterns:**
  - No throat-clearing openers ("Certainly," "In today's landscape," "When it
    comes to").
  - No marketing adjective standing alone without a stated mechanism (never
    "seamless," "powerful," "cutting-edge," "game-changing" — say what it
    does instead: none of the three samples uses any of these words).
  - No first-person "we believe"/"our mission" framing.
  - No rhetorical questions as section or paragraph openers.
  - No rule-of-three padding or aphorism closers ("...and that changes
    everything.").
  - No exclamation points in prose (badge/shield markup is exempt) — none appear in the three samples' prose.

- **Contextual rules (technical vs. promotional):**
  - **Technical** (CONTRIBUTING.md, docs/qa/RUNBOOK.md): maximal density —
    commands, paths, and file names inline in prose, the em-dash/colon aside
    carries a "why" or a caveat, zero adjectives.
  - **Promotional** (README.md's framing lines, e.g. *"Give it an outcome. It
    detects your project, assembles the right crew, and shows its reasoning
    before it acts."*): still terse and still zero hype adjectives, but
    allows one confident short-sentence hook before the mechanism follows.
    The hook is a compressed claim, not an adjective — the very next sentence
    or clause cashes it out concretely. This matches `docs/profiles/BRAND.md`'s
    own voice note for video/script cadence: *"Direct, technical, unhurried —
    short declarative sentences, confident without hype."*
