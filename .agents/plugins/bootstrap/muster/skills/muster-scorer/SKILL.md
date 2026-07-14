---
name: muster-scorer
description: "Codex-compatible Muster workflow. Built-in scoring provider — evidence-cited rubric scoring with the floor principle. Used by domain pipelines for the score role."
license: Apache-2.0
---

<!-- prompt-lint-disable ANTH-ROLE-001, ANTH-FMT-001: Bootstrap delegates to the role and output contract in the validated selected release. -->

# Immutable Muster bootstrap

Run `node ${PLUGIN_ROOT}/runtime/resolve-release.mjs skill muster-scorer` and read the absolute path it prints. Follow that selected, validated immutable release file as the authoritative workflow. If resolution fails, stop with the diagnostic; never use a partial or unvalidated generation.
