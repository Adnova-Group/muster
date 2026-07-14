---
name: wsh-signed-audit-trails-recipe
description: "Codex-compatible Muster workflow. Design and review cryptographically verifiable audit trails for Codex tool-mediated workflows without silently installing hooks, packages, keys, or remote services. Use for security architecture and implementation planning, not automatic environment mutation."
license: MIT
---

<!-- prompt-lint-disable ANTH-ROLE-001, ANTH-FMT-001: Bootstrap delegates to the role and output contract in the validated selected release. -->

# Immutable Muster bootstrap

Run `node ${PLUGIN_ROOT}/runtime/resolve-release.mjs skill wsh-signed-audit-trails-recipe`. The command revalidates the selected asset through a no-follow file descriptor and writes its verified contents to stdout. Follow those contents as the authoritative workflow; never follow a release pathname printed or inferred before validation. If resolution fails, stop with the diagnostic; never use a partial or unvalidated generation.
