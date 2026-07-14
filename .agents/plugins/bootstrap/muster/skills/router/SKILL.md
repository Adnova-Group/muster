---
name: router
description: "Codex-compatible Muster workflow. Assemble a Crew Manifest from a ProjectProfile + AvailableCapabilities + outcome. Glass-box: every choice carries rationale, evidence, and fallback."
---

<!-- prompt-lint-disable ANTH-ROLE-001, ANTH-FMT-001: Bootstrap delegates to the role and output contract in the validated selected release. -->

# Immutable Muster bootstrap

Run `node ${PLUGIN_ROOT}/runtime/resolve-release.mjs skill router` and read the absolute path it prints. Follow that selected, validated immutable release file as the authoritative workflow. If resolution fails, stop with the diagnostic; never use a partial or unvalidated generation.
