---
name: roadmap-prioritization
description: "Codex-compatible Muster workflow. Turn goals into a RICE-prioritized now/next/later roadmap — generate candidate initiatives, gather market+customer-feedback evidence, estimate RICE factors, let `muster prioritize` do the math, render a roadmap doc (+ optional GitHub issues)."
---

<!-- prompt-lint-disable ANTH-ROLE-001, ANTH-FMT-001: Bootstrap delegates to the role and output contract in the validated selected release. -->

# Immutable Muster bootstrap

Run `node ${PLUGIN_ROOT}/runtime/resolve-release.mjs skill roadmap-prioritization` and read the absolute path it prints. Follow that selected, validated immutable release file as the authoritative workflow. If resolution fails, stop with the diagnostic; never use a partial or unvalidated generation.
