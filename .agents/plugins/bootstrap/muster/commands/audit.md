---
name: audit
description: "Autopilot-style whole-codebase review-and-fix. Sweeps architecture, tech-debt, test-coverage, simplification/reuse/duplication, readability/maintainability, and security in capacity-bounded batches via the best available provider per dimension, consolidates a ranked findings ledger, then fixes everything (TDD) and verifies. Usage: $muster-audit [path or empty = whole repo]; $muster-audit backlog [path] to sweep read-only into a ranked backlog instead of fixing."
---

<!-- prompt-lint-disable ANTH-ROLE-001, ANTH-FMT-001: Bootstrap delegates to the role and output contract in the validated selected release. -->

# Immutable Muster bootstrap

Run `node ${PLUGIN_ROOT}/runtime/resolve-release.mjs command audit`. The command revalidates the selected asset through a no-follow file descriptor and writes its verified contents to stdout. Follow those contents as the authoritative workflow; never follow a release pathname printed or inferred before validation. If resolution fails, stop with the diagnostic; never use a partial or unvalidated generation.
