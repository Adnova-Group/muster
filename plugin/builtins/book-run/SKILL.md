---
name: book-run
description: "Book runs: canon ledger, continuity debts, outline methods, POV and tense discipline, nonfiction structure."
muster_builtin: true
license: Apache-2.0
upstream:
  - repo: danjdewhurst/story-skills
    ref: 3c0e0346ee09ded32546d9481ac18ec5324f02c3
    path: skills/reader-panel/SKILL.md
    license: MIT
    relation: inspired-by
  - repo: Calliope-Editor/writing-skills
    ref: 2fad031982cbbcb00c4da14c2fc9712d2daa78da
    path: skills/craft/psychic-distance/SKILL.md
    license: MIT
    relation: inspired-by
  - repo: epicsagas/Velith
    ref: 5ddd29675c5fd00e2c5b3bb095b7ac3749a22c90
    path: skills/book-nonfiction/SKILL.md
    license: Apache-2.0
    relation: inspired-by
  - repo: clutcher/book-writing-skills
    ref: 0bea387d1fe1936667373036e43e9f425cb3415e
    path: plugins/book/skills/check-facts/SKILL.md
    license: MIT
    relation: inspired-by
  - kind: book
    title: How to Write a Novel Using the Snowflake Method
    author: Randy Ingermanson
    url: null
    relation: inspired-by
  - repo: NousResearch/autonovel
    ref: d165f267a0ffd34f3b0a70a8a72ac38cb8e4a542
    path: null
    license: NONE
    relation: inspired-by
  - kind: book
    title: Save the Cat!
    author: Blake Snyder
    url: null
    relation: inspired-by
  - kind: book
    title: The Story Grid
    author: Shawn Coyne
    url: null
    relation: inspired-by
  - kind: book
    title: Techniques of the Selling Writer (scene and sequel)
    author: Dwight V. Swain
    url: null
    relation: inspired-by
  - kind: article
    title: Chapter Blog nonfiction outline; ProWritingAid non-fiction structure
    author: null
    url: null
    relation: inspired-by
---

# Book runs (built-in)

You are working on a muster book run: a novel, novella, memoir or nonfiction book written over many sessions. This file is the contract the write-book command, the `muster:book` workflow and the five `book-*` agents share. Read the section your job needs.

## Run layout

Everything lives in `.muster/runs/<runId>/` and is committed on the work branch, so the book survives across sessions and days:

| File | Owner | What it is |
|---|---|---|
| `book.json` | `muster book` CLI | The ledger: outline, chapter states, canon facts, continuity debts, pass history |
| **CANON.md** | rendered from book.json | The story bible every agent reads. Never hand-edited |
| **LEDGER.md** | rendered from book.json | Chapter table, open debts, chapter summaries |
| `chapters/<id>.md` | `book-writer`, `book-line-editor`, the author | The manuscript, one file per chapter |
| `book-args.json` | `muster book args` | The exact args for the next workflow pass |
| `book-result-<n>.json` | the main thread | A pass's returned JSON, input to `muster book record` |
| **STATE.md** | `muster book` | `## Log` lines, one per init, pass, amend and close |

Commands: `muster book init <runId> --outline <file>`, `args <runId> [--limit N] [--beta N]`, `record <runId> --result <file>`, `amend <runId> <C-id> <new fact>`, `close <runId> <D-id> <resolution>`, `status <runId>`.

## Canon and debts

A **canon fact** is something the manuscript has committed to and later chapters must respect. Categories: `character` (names, ages, appearance, history, what they know), `world` (rules, magic, technology, institutions), `place`, `timeline` (dates, durations, order), `object`, `term` (invented or defined words), `claim` and `source` (nonfiction: a claim and the evidence it rests on), `style` (a voice rule the book keeps). One fact per entry, concrete enough to contradict: "Mara is 34 in chapter 1", not "Mara is youngish". If you are unsure whether something is canon, say so in your notes instead of guessing.

A **continuity debt** is an open contradiction between a chapter and the canon. Debts are opened when:
- the continuity checker finds an issue the writer did not fix within two rounds;
- a canon fact is amended (`muster book amend`): every written chapter that relied on the old fact gets a debt against the new one;
- a line edit changed a canon-bearing passage.

A chapter whose file changed since the last `record` is **stale**: the next pass re-checks it before drafting anything new. Debts close only when a re-check that was shown the debt passes, or when the author closes one by hand with a reason ("intentional: Teo lies here"). A simulated beta read never marks a book ready.

## Outline methods (fiction)

Pick the method that fits the book; name it in the outline summary. All are tools, not templates to fill mechanically.
- **Snowflake** (Randy Ingermanson): grow the book from one sentence to a paragraph, then one-page character sheets, then a scene list. Good when the premise is clear and the plot is not.
- **Beat sheet** (Blake Snyder, *Save the Cat!*): fifteen beats from the opening image through the catalyst, midpoint, all-is-lost and finale. Good for commercial genre pacing; resist hitting every beat on the exact page.
- **Story Grid** (Shawn Coyne): every scene, sequence and act turns on five commandments (inciting incident, progressive complication, crisis, climax, resolution) and shifts a value from one charge to another. Good for diagnosing a scene that "does nothing".
- **Scene and sequel** (Dwight V. Swain): a scene is goal, conflict, disaster; a sequel is reaction, dilemma, decision. Good for chapter-level cause and effect.

Whatever the method, each chapter's goal says what changes by its end. `dependsOn` names only real dependencies (an event it follows, a reveal it pays off), because chapters without one are drafted in parallel. Sepia's architecture sheet (the narrative pass in the `sepia` builtin) is the check against generated-feeling structure: an implied theme, one subplot in roughly two stories of five, an ending that is not always the protagonist choosing, accepting and growing, moderate nonlinearity, exactly one rarity move.

## Nonfiction structure

- **Thesis and argument map.** One sentence the book argues. Under it, the claims that support it, the evidence for each claim, and the strongest objection to each with its answer. Every claim and its source go into canon (`claim`, `source`).
- **One promise per chapter.** Each chapter promises the reader one thing and keeps it, and makes at least one claim a reader could disagree with. A chapter that only restates the thesis is an orphan.
- **Chapter unit.** Concept (one idea), proof (case, story or data), how (what the reader does), bridge (why the next chapter follows).
- **Citations.** A reference is not a citation: name the source, the page or section, and what it actually says. Never invent a quote, a number or a study. A missing source is marked `[SOURCE NEEDED: what claim]` and left for the author.

## POV and tense discipline

- Write from inside the POV character's knowledge state: what they have lived through, what they would notice and miss. The outline knows things the character does not.
- One POV per scene unless the book's stated voice is omniscient. A head-hop is a continuity issue (kind `pov`).
- Hold the tense. Past-tense narration may slip into present only for a deliberate, signalled effect. A slip is an issue (kind `tense`).
- Psychic distance is a dial, not a constant: close in at peaks, pull back for transitions. Filter verbs (she saw, he felt, she noticed) are the countable sign of distance creeping out by accident.

## The pass, agent by agent

| Phase | Agent | Reads | Returns |
|---|---|---|---|
| Outline | `book-writer`, then `book-developmental-editor` | the brief | OUTLINE_RESULT, OUTLINE_CHECK |
| Draft | `book-writer`, one per chapter, parallel within a wave | CANON.md, LEDGER.md, the closing lines of the chapters it follows | DRAFT_RESULT |
| Continuity | `book-continuity-checker`, then `book-writer` fixes (2 rounds) | one chapter, CANON.md, LEDGER.md, provisional canon | CONTINUITY_RESULT |
| Develop | `book-developmental-editor` | the whole manuscript in order | DEV_RESULT |
| Line | `book-line-editor`, one per chapter, only after a developmental PASS | one chapter and its neighbours | LINE_RESULT |
| Beta | `book-beta-reader`, three personas | the chapter files only, never the canon | BETA_RESULT |

Schemas: `plugin/workflows/book-schemas.js`. Craft references the agents load by path: `builtins/cws-story-review/` (editorial, developmental, line, copyedit, proofread, continuity), `builtins/cws-reader-sim/`, `builtins/cws-writing-principles/`, `builtins/cws-creative-writing-craft/` (scene craft and per-genre contracts), `builtins/sepia/` (narrative-architecture tells and per-venue prose rules), and `builtins/muster-humanizer/` (the final filter).
