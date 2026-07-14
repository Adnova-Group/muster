---
name: domain-router
description: "Codex-compatible Muster workflow. Pick the work domain for an outcome and route to its pipeline (PM/PRD, etc.); for unrecognized domains, classify by judgment and pick the closest pipeline. Falls back to the software route for code workspaces. Glass-box: records the domain choice + why."
---

<!-- prompt-lint-disable ANTH-ROLE-001, ANTH-FMT-001: Bootstrap delegates to the role and output contract in the validated selected release. -->

# Immutable Muster bootstrap

Run `node ${PLUGIN_ROOT}/runtime/resolve-release.mjs skill domain-router`. The command revalidates the selected asset through a no-follow file descriptor and writes its verified contents to stdout. Follow those contents as the authoritative workflow; never follow a release pathname printed or inferred before validation. If resolution fails, stop with the diagnostic; never use a partial or unvalidated generation.
