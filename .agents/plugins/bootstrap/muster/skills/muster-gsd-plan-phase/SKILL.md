---
name: muster-gsd-plan-phase
description: "Codex-compatible Muster workflow. Plan one implementation phase as reviewable dependency-ordered tasks with explicit ownership, interfaces, tests, and verification. Use as Muster's self-contained GSD-style planning fallback when the official GSD Codex skill is not enabled."
license: MIT
---

<!-- prompt-lint-disable ANTH-ROLE-001, ANTH-FMT-001: Bootstrap delegates to the role and output contract in the validated selected release. -->

# Immutable Muster bootstrap

Run `node ${PLUGIN_ROOT}/runtime/resolve-release.mjs skill muster-gsd-plan-phase`. The command revalidates the selected asset through a no-follow file descriptor and writes its verified contents to stdout. Follow those contents as the authoritative workflow; never follow a release pathname printed or inferred before validation. If resolution fails, stop with the diagnostic; never use a partial or unvalidated generation.
