---
name: interview
description: "Codex-compatible Muster workflow. Interactive requirements interview — one question at a time via the interactive user input selection UI — that turns a thin outcome into an enriched, criteria-backed outcome the router can run."
---

<!-- prompt-lint-disable ANTH-ROLE-001, ANTH-FMT-001: Bootstrap delegates to the role and output contract in the validated selected release. -->

# Immutable Muster bootstrap

Run `node ${PLUGIN_ROOT}/runtime/resolve-release.mjs skill interview` and read the absolute path it prints. Follow that selected, validated immutable release file as the authoritative workflow. If resolution fails, stop with the diagnostic; never use a partial or unvalidated generation.
