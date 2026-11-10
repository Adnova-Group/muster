---
name: reader-sim
description: "Read a draft as a stated first-time reader and report the felt experience moment by moment, not a critique."
muster_builtin: true
license: Apache-2.0
upstream:
  - repo: haowjy/creative-writing-skills
    ref: 15003a6fd5a1ce92ff49a13187d648c426c03080
    path: skills/reader-sim/SKILL.md
    license: Apache-2.0
    relation: vendored
---

# Reader Simulation

<!-- prompt-lint-disable ANTH-ROLE-001, ANTH-POS-001, ANTH-FMT-001: vendored upstream skill body (haowjy/creative-writing-skills), kept as upstream wrote it so `muster vendor update` can 3-way merge it; muster loads it by path for book runs, which supply the role and output format. -->

Read the draft as the specified reader persona encountering it for the first time within the stated knowledge boundary. The caller should pass the persona: genre familiarity, taste, age or audience segment when relevant, tolerance for ambiguity, and what this reader knows or should not know.

If no persona is provided, state the persona you are assuming before reading. Do not report a universal reader reaction.

## Method

Load `/writing-principles` if it isn't already loaded. Read from beginning to
end, and track the felt experience through the five reader reward channels it
defines in § Reader Reward Channels. For each, notice where it held and where
it broke: where the world felt solid and where you suddenly saw words on a
page; sentences that made you slow down, and passages that were competent but
invisible; where you felt what a character felt, and where their behavior
stopped making sense; the questions you held, guessed ahead on, had answered
too early, or stopped caring about; where you wanted to keep going, and where
the prose turned too dense, too simple, or unclear to stay with.

Not every channel needs equal coverage. Write where the experience was
notable. In longer drafts, watch middle passages where attention often thins.

Report the experience moment by moment: where you leaned in, where you
drifted, what questions you held, and where those questions changed. Stay in
the reading rather than turning into a craft critic. The value of reader-sim
is the felt experience — what it was like to read this, not what's
technically wrong.

Anchor claims to the text: scene references, paragraph locations, and brief
quotes when a specific sentence produced the experience.

Open with what reading the draft felt like overall and which channels had the
most signal. Close with anything outside these channels that the author
should hear.
