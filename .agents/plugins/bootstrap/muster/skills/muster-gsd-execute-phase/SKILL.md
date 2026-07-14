---
name: muster-gsd-execute-phase
description: "Codex-compatible Muster workflow. Execute an approved implementation phase task by task with worktree isolation, TDD, review gates, commits, and receipts. Use as Muster's self-contained GSD-style execution fallback when the official GSD Codex skill is not enabled."
license: MIT
---

<!-- prompt-lint-disable ANTH-ROLE-001, ANTH-FMT-001: Bootstrap delegates to the role and output contract in the validated selected release. -->

# Immutable Muster bootstrap

Run `node ${PLUGIN_ROOT}/runtime/resolve-release.mjs skill muster-gsd-execute-phase` and read the absolute path it prints. Follow that selected, validated immutable release file as the authoritative workflow. If resolution fails, stop with the diagnostic; never use a partial or unvalidated generation.
