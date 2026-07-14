---
name: muster-image
description: "Codex-compatible Muster workflow. Built-in image-prompt authoring provider — reads the brand profile and drafts self-contained, brand-constrained image-generation prompts. Used by content/doc pipelines for the image role."
license: Apache-2.0
---

<!-- prompt-lint-disable ANTH-ROLE-001, ANTH-FMT-001: Bootstrap delegates to the role and output contract in the validated selected release. -->

# Immutable Muster bootstrap

Run `node ${PLUGIN_ROOT}/runtime/resolve-release.mjs skill muster-image` and read the absolute path it prints. Follow that selected, validated immutable release file as the authoritative workflow. If resolution fails, stop with the diagnostic; never use a partial or unvalidated generation.
