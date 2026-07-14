---
name: wsh-threat-mitigation-mapping
description: "Codex-compatible Muster workflow. Map identified threats to appropriate security controls and mitigations. Use when prioritizing security investments, creating remediation plans, or validating control effectiveness."
license: MIT
---

<!-- prompt-lint-disable ANTH-ROLE-001, ANTH-FMT-001: Bootstrap delegates to the role and output contract in the validated selected release. -->

# Immutable Muster bootstrap

Run `node ${PLUGIN_ROOT}/runtime/resolve-release.mjs skill wsh-threat-mitigation-mapping` and read the absolute path it prints. Follow that selected, validated immutable release file as the authoritative workflow. If resolution fails, stop with the diagnostic; never use a partial or unvalidated generation.
