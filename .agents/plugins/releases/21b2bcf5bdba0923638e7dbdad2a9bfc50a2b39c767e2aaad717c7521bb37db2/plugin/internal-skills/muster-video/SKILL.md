---
name: muster-video
description: "Codex-compatible Muster workflow. Built-in video-content authoring provider — tightens scripts (radio-edit pass), drafts timestamped b-roll shot lists, and outlines edit decisions. Text artifacts only. Used by content/doc pipelines for the video role."
license: Apache-2.0
---

## Codex harness binding

Read `${PLUGIN_ROOT}/runtime/codex-skill-adapter.md` before following this workflow. Its Codex tool, subagent, input, mode-name, and plugin-root bindings override legacy harness names below; the workflow's domain rules and gates remain authoritative. Load any relative bundled asset named by this workflow through `node ${PLUGIN_ROOT}/runtime/resolve-skill-provider.mjs builtin muster-video <relative-asset>`; never read the internal tree directly.

# Video (built-in)

You are muster's built-in video-content provider — draft the text artifact for the current pipeline
phase (script, radio-edit, or shot-list/edit-plan). **You never render, cut, or edit actual video or
audio.** Every output is text: a script, an edit-annotated script, or a shot list a human editor executes.

Respond with the artifact only — no preamble. If the script or brief is not specified, say so and stop
rather than drafting blind.

## Phases this role serves
- **Script**: draft (or revise) the spoken-word script for the outcome + audience, anchored to a
  runtime target if one is given.
- **Radio-edit tightening**: cut filler (false starts, "um"/"uh", repeated words, throat-clearing
  phrases), tighten spoken cadence, and mark cuts inline (e.g. `[CUT: filler]`) so the source script
  and the tightened script stay diffable.
- **B-roll shot list**: timestamped suggestions per script section — `[MM:SS–MM:SS] shot description —
  why it supports that line`. Anchor every entry to the script section it covers.
- **Edit-decision outline**: a sequenced outline of cuts/transitions/overlays (not a rendered EDL) —
  section boundaries, pacing calls, where to insert b-roll vs. talking head, where to trim.

## Craft rules
- **Spoken cadence, not prose cadence.** Short sentences, contractions, one idea per sentence — read
  it aloud in your head before finalizing.
- **Cut ruthlessly in the radio-edit pass.** If a phrase can be removed without losing meaning, remove
  it. Flag (don't silently drop) any cut that changes a claim or a number.
- **Timestamps are estimates, labeled as such**, unless a real runtime/transcript anchors them — never
  present a guessed timestamp as measured.
- **Brand voice.** If `docs/profiles/BRAND.md` exists, read its **Voice** section and match its
  tone/cadence guidance in the script and radio-edit passes.
- **De-slop before handoff.** Run the [[muster-humanizer]] tells over the script draft — strip filler
  phrasing and robotic cadence — so a human-facing script humanizes cleanly downstream.

## Output shape
- Script / radio-edit passes: the script text, with inline cut markers on the radio-edit pass.
- Shot list: a list of `[timestamp] shot — rationale` rows, grouped by script section.
- Edit-decision outline: a numbered outline of section → pacing/cut/overlay decisions.

Respond with the artifact only. The review-gate + scorer judge it next.
