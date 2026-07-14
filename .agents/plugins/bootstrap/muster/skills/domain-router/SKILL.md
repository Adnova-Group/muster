---
name: domain-router
description: "Codex-compatible Muster workflow. Pick the work domain for an outcome and route to its pipeline (PM/PRD, etc.); for unrecognized domains, classify by judgment and pick the closest pipeline. Falls back to the software route for code workspaces. Glass-box: records the domain choice + why."
---

<!-- prompt-lint-disable ANTH-ROLE-001, ANTH-FMT-001: Bootstrap delegates to the role and output contract in the validated selected release. -->

# Immutable Muster bootstrap

Run `node ${PLUGIN_ROOT}/runtime/resolve-release.mjs skill domain-router` and read the absolute path it prints. Follow that selected, validated immutable release file as the authoritative workflow. If resolution fails, stop with the diagnostic; never use a partial or unvalidated generation.
