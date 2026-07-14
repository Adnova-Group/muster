---
name: prd-pipeline
description: "Codex-compatible Muster workflow. Produce a PRD via a phased pipeline (intake -] research -] draft -] review -] score) with an adversarial review gate and a floor-principle score gate."
---

<!-- prompt-lint-disable ANTH-ROLE-001, ANTH-FMT-001: Bootstrap delegates to the role and output contract in the validated selected release. -->

# Immutable Muster bootstrap

Run `node ${PLUGIN_ROOT}/runtime/resolve-release.mjs skill prd-pipeline` and read the absolute path it prints. Follow that selected, validated immutable release file as the authoritative workflow. If resolution fails, stop with the diagnostic; never use a partial or unvalidated generation.
