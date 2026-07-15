---
name: wsh-architecture-decision-records
description: "Codex-compatible Muster workflow. Write and maintain Architecture Decision Records (ADRs) following best practices for technical decision documentation. Use when documenting significant technical decisions, reviewing past architectural choices, or establishing decision processes."
license: MIT
---

<!-- prompt-lint-disable ANTH-ROLE-001, ANTH-FMT-001: Bootstrap delegates to the role and output contract in the validated selected release. -->

# Immutable Muster bootstrap

Run `node ${PLUGIN_ROOT}/runtime/resolve-release.mjs internal-skill wsh-architecture-decision-records`. The command revalidates the selected asset through a no-follow file descriptor and writes its verified contents to stdout. Follow those contents as the authoritative workflow; never follow a release pathname printed or inferred before validation. If resolution fails, stop with the diagnostic; never use a partial or unvalidated generation.
