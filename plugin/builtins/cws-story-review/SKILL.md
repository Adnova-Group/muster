---
name: story-review
description: "Fiction review by level: editorial, developmental, line, copyedit, proofread, craft critique and continuity."
muster_builtin: true
license: Apache-2.0
upstream:
  - repo: haowjy/creative-writing-skills
    ref: 15003a6fd5a1ce92ff49a13187d648c426c03080
    path: skills/story-review/SKILL.md
    license: Apache-2.0
    relation: vendored
---

# Story Review

<!-- prompt-lint-disable ANTH-ROLE-001, ANTH-POS-001, ANTH-FMT-001: vendored upstream skill body (haowjy/creative-writing-skills), kept as upstream wrote it so `muster vendor update` can 3-way merge it; muster loads it by path for book runs, which supply the role and output format. -->

Analytical review of existing prose. This skill is for diagnosis, not
rewriting. Keep `/reader-sim` separate when the task needs a felt first-time
reader experience rather than analytical critique.

Choose the review level before reading. Start big before small unless the
caller explicitly asks for a late-stage pass. The edit levels move from
structural to surface, and each assumes the levels above it are stable:

- **Editorial review** — holistic third-party book-editor pass. What kind of
  revision does this draft need, and in what order?
- **Developmental edit** — structure, promise, causality, pacing, character
  arc. Is the draft the right shape?
- **Line edit** — voice, rhythm, clarity, texture. Does the prose move well?
- **Copyedit** — grammar, usage, punctuation, consistency. Is it correct?
- **Proofreading** — final surface pass. What slipped through?

Each level has a dedicated resource with method and checklist:

- `resources/editorial-review.md`
- `resources/developmental-edit.md`
- `resources/line-edit.md`
- `resources/copyedit.md`
- `resources/proofreading.md`

For adversarial craft critique (as opposed to editorial review), load:

- `resources/prose-critique.md` — methodology and focus-area routing.
- `resources/prose-critique/` — deep resources per focus area (structure,
  character, voice, prose, continuity).

When review incorporates reader-sim data:

- `resources/reader-sim-signal.md` — how to interpret and synthesize
  reader-sim output alongside analytical critique.
