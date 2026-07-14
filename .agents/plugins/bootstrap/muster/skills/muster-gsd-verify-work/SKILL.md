---
name: muster-gsd-verify-work
description: "Codex-compatible Muster workflow. Verify completed work against stated outcomes with fresh tests, regression checks, UAT evidence, and an honest pass/fail ledger. Use as Muster's self-contained GSD-style verification fallback when the official GSD Codex skill is not enabled."
license: MIT
---

<!-- prompt-lint-disable ANTH-ROLE-001, ANTH-FMT-001: Bootstrap delegates to the role and output contract in the validated selected release. -->

# Immutable Muster bootstrap

Run `node ${PLUGIN_ROOT}/runtime/resolve-release.mjs skill muster-gsd-verify-work` and read the absolute path it prints. Follow that selected, validated immutable release file as the authoritative workflow. If resolution fails, stop with the diagnostic; never use a partial or unvalidated generation.
