---
name: muster-video
description: "Codex-compatible Muster workflow. Built-in video-content authoring provider — tightens scripts (radio-edit pass), drafts timestamped b-roll shot lists, and outlines edit decisions. Text artifacts only. Used by content/doc pipelines for the video role."
license: Apache-2.0
---

<!-- prompt-lint-disable ANTH-ROLE-001, ANTH-FMT-001: Bootstrap delegates to the role and output contract in the validated selected release. -->

# Immutable Muster bootstrap

Run `node ${PLUGIN_ROOT}/runtime/resolve-release.mjs skill muster-video` and read the absolute path it prints. Follow that selected, validated immutable release file as the authoritative workflow. If resolution fails, stop with the diagnostic; never use a partial or unvalidated generation.
