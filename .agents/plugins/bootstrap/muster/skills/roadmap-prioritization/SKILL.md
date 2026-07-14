---
name: roadmap-prioritization
description: "Codex-compatible Muster workflow. Turn goals into a RICE-prioritized now/next/later roadmap — generate candidate initiatives, gather market+customer-feedback evidence, estimate RICE factors, let `muster prioritize` do the math, render a roadmap doc (+ optional GitHub issues)."
---

<!-- prompt-lint-disable ANTH-ROLE-001, ANTH-FMT-001: Bootstrap delegates to the role and output contract in the validated selected release. -->

# Immutable Muster bootstrap

Run `node ${PLUGIN_ROOT}/runtime/resolve-release.mjs skill roadmap-prioritization`. The command revalidates the selected asset through a no-follow file descriptor and writes its verified contents to stdout. Follow those contents as the authoritative workflow; never follow a release pathname printed or inferred before validation. If resolution fails, stop with the diagnostic; never use a partial or unvalidated generation.
