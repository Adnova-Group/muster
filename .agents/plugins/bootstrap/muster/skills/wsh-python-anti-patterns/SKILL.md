---
name: wsh-python-anti-patterns
description: "Codex-compatible Muster workflow. Use this skill when reviewing Python code for common anti-patterns to avoid. Use as a checklist when reviewing code, before finalizing implementations, or when debugging issues that might stem from known bad practices."
license: MIT
---

<!-- prompt-lint-disable ANTH-ROLE-001, ANTH-FMT-001: Bootstrap delegates to the role and output contract in the validated selected release. -->

# Immutable Muster bootstrap

Run `node ${PLUGIN_ROOT}/runtime/resolve-release.mjs skill wsh-python-anti-patterns` and read the absolute path it prints. Follow that selected, validated immutable release file as the authoritative workflow. If resolution fails, stop with the diagnostic; never use a partial or unvalidated generation.
