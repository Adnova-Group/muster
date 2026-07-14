---
name: sprint
description: "Legacy alias of $muster-go-backlog — same behavior, kept working for backward compatibility. Usage: $muster-go-backlog <backlog ref>"
---

<!-- prompt-lint-disable ANTH-ROLE-001, ANTH-FMT-001: Bootstrap delegates to the role and output contract in the validated selected release. -->

# Immutable Muster bootstrap

Run `node ${PLUGIN_ROOT}/runtime/resolve-release.mjs command sprint` and read the absolute path it prints. Follow that selected, validated immutable release file as the authoritative workflow. If resolution fails, stop with the diagnostic; never use a partial or unvalidated generation.
