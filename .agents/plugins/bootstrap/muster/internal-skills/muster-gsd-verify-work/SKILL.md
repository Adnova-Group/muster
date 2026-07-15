---
name: muster-gsd-verify-work
description: "Codex-compatible Muster workflow. Verify completed work against stated outcomes with fresh tests, regression checks, UAT evidence, and an honest pass/fail ledger. Use as Muster's self-contained GSD-style verification fallback when the official GSD Codex skill is not enabled."
license: MIT
---

<!-- prompt-lint-disable ANTH-ROLE-001, ANTH-FMT-001: Bootstrap delegates to the role and output contract in the validated selected release. -->

# Immutable Muster bootstrap

Run `node ${PLUGIN_ROOT}/runtime/resolve-release.mjs internal-skill muster-gsd-verify-work`. The command revalidates the selected asset through a no-follow file descriptor and writes its verified contents to stdout. Follow those contents as the authoritative workflow; never follow a release pathname printed or inferred before validation. If resolution fails, stop with the diagnostic; never use a partial or unvalidated generation.
