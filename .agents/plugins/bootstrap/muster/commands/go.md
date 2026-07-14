---
name: go
description: "Hands-off full lifecycle. Bare invocation detects scope from the outcome text (single item vs backlog) via `muster scope` and confirms before proceeding; on confirmed backlog scope, delegates to $muster-go-backlog. Otherwise plans THEN executes end to end: branch, route, run waves (parallel fan-out + tournaments + adversarial review gate), commit per wave, then present merge. Only stops for a scope confirmation, the merge decision, or an escalation. (vs $muster-plan, which only plans and shows.) Usage: $muster-go <outcome>"
---

<!-- prompt-lint-disable ANTH-ROLE-001, ANTH-FMT-001: Bootstrap delegates to the role and output contract in the validated selected release. -->

# Immutable Muster bootstrap

Run `node ${PLUGIN_ROOT}/runtime/resolve-release.mjs command go`. The command revalidates the selected asset through a no-follow file descriptor and writes its verified contents to stdout. Follow those contents as the authoritative workflow; never follow a release pathname printed or inferred before validation. If resolution fails, stop with the diagnostic; never use a partial or unvalidated generation.
