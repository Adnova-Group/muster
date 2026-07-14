---
name: muster-audit
description: "Use for Muster orchestration when the user asks to run the whole-codebase audit workflow and consolidate actionable findings. Explicitly invoke with $muster-audit."
---

<!-- prompt-lint-disable ANTH-ROLE-001, ANTH-FMT-001: Bootstrap delegates to the role and output contract in the validated selected release. -->

# Immutable Muster bootstrap

Run `node ${PLUGIN_ROOT}/runtime/resolve-release.mjs skill muster-audit`. The command revalidates the selected asset through a no-follow file descriptor and writes its verified contents to stdout. Follow those contents as the authoritative workflow; never follow a release pathname printed or inferred before validation. If resolution fails, stop with the diagnostic; never use a partial or unvalidated generation.
