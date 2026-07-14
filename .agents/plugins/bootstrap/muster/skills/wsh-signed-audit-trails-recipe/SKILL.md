---
name: wsh-signed-audit-trails-recipe
description: "Codex-compatible Muster workflow. Design and review cryptographically verifiable audit trails for Codex tool-mediated workflows without silently installing hooks, packages, keys, or remote services. Use for security architecture and implementation planning, not automatic environment mutation."
license: MIT
---

<!-- prompt-lint-disable ANTH-ROLE-001, ANTH-FMT-001: Bootstrap delegates to the role and output contract in the validated selected release. -->

# Immutable Muster bootstrap

Run `node ${PLUGIN_ROOT}/runtime/resolve-release.mjs skill wsh-signed-audit-trails-recipe` and read the absolute path it prints. Follow that selected, validated immutable release file as the authoritative workflow. If resolution fails, stop with the diagnostic; never use a partial or unvalidated generation.
