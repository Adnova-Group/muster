---
name: diagnose
description: "Failure-first bug fix. Reproduce, find root cause (systematic debugging via the best available debug provider — installed wshobson/external else built-in), fix, add a regression test, verify. No symptom-patching. Usage: $muster-diagnose <symptom | paste failing test/CI output>"
---

<!-- prompt-lint-disable ANTH-ROLE-001, ANTH-FMT-001: Bootstrap delegates to the role and output contract in the validated selected release. -->

# Immutable Muster bootstrap

Run `node ${PLUGIN_ROOT}/runtime/resolve-release.mjs command diagnose` and read the absolute path it prints. Follow that selected, validated immutable release file as the authoritative workflow. If resolution fails, stop with the diagnostic; never use a partial or unvalidated generation.
