---
name: muster-video
description: "Codex-compatible Muster workflow. Built-in video-content authoring provider — tightens scripts (radio-edit pass), drafts timestamped b-roll shot lists, and outlines edit decisions. Text artifacts only. Used by content/doc pipelines for the video role."
license: Apache-2.0
---

<!-- prompt-lint-disable ANTH-ROLE-001, ANTH-FMT-001: Bootstrap delegates to the role and output contract in the validated selected release. -->

# Immutable Muster bootstrap

Run `node ${PLUGIN_ROOT}/runtime/resolve-release.mjs internal-skill muster-video`. The command revalidates the selected asset through a no-follow file descriptor and writes its verified contents to stdout. Follow those contents as the authoritative workflow; never follow a release pathname printed or inferred before validation. If resolution fails, stop with the diagnostic; never use a partial or unvalidated generation.
