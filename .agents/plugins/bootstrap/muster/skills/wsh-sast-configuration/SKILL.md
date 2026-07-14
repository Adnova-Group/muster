---
name: wsh-sast-configuration
description: "Codex-compatible Muster workflow. Configure Static Application Security Testing (SAST) tools for automated vulnerability detection in application code. Use when setting up security scanning, implementing DevSecOps practices, or automating code vulnerability detection."
license: MIT
---

<!-- prompt-lint-disable ANTH-ROLE-001, ANTH-FMT-001: Bootstrap delegates to the role and output contract in the validated selected release. -->

# Immutable Muster bootstrap

Run `node ${PLUGIN_ROOT}/runtime/resolve-release.mjs skill wsh-sast-configuration`. The command revalidates the selected asset through a no-follow file descriptor and writes its verified contents to stdout. Follow those contents as the authoritative workflow; never follow a release pathname printed or inferred before validation. If resolution fails, stop with the diagnostic; never use a partial or unvalidated generation.
