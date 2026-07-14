---
name: wsh-multi-reviewer-patterns
description: "Codex-compatible Muster workflow. Coordinate parallel code reviews across multiple quality dimensions with finding deduplication, severity calibration, and consolidated reporting. Use this skill when organizing multi-reviewer code reviews, calibrating finding severity, or consolidating review results."
license: MIT
---

<!-- prompt-lint-disable ANTH-ROLE-001, ANTH-FMT-001: Bootstrap delegates to the role and output contract in the validated selected release. -->

# Immutable Muster bootstrap

Run `node ${PLUGIN_ROOT}/runtime/resolve-release.mjs skill wsh-multi-reviewer-patterns`. The command revalidates the selected asset through a no-follow file descriptor and writes its verified contents to stdout. Follow those contents as the authoritative workflow; never follow a release pathname printed or inferred before validation. If resolution fails, stop with the diagnostic; never use a partial or unvalidated generation.
