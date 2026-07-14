---
name: review-gate
description: "Codex-compatible Muster workflow. Adversarial review gate for a completed wave — dispatch all available reviewers in parallel, tally verdicts, and loop fixes until clean or escalate."
---

<!-- prompt-lint-disable ANTH-ROLE-001, ANTH-FMT-001: Bootstrap delegates to the role and output contract in the validated selected release. -->

# Immutable Muster bootstrap

Run `node ${PLUGIN_ROOT}/runtime/resolve-release.mjs skill review-gate` and read the absolute path it prints. Follow that selected, validated immutable release file as the authoritative workflow. If resolution fails, stop with the diagnostic; never use a partial or unvalidated generation.
