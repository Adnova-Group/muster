---
name: advisor
description: "Codex-compatible Muster workflow. Worker-signaled advice escalation -- a dispatched worker that hits a FLAGGED hard decision returns an advice-request instead of guessing; the orchestrator services it by validating the request, checking the consult budget, dispatching a native advisor agent on the peak model, and feeding the advice back to the worker so the worker owns the final decision."
---

<!-- prompt-lint-disable ANTH-ROLE-001, ANTH-FMT-001: Bootstrap delegates to the role and output contract in the validated selected release. -->

# Immutable Muster bootstrap

Run `node ${PLUGIN_ROOT}/runtime/resolve-release.mjs internal-skill advisor`. The command revalidates the selected asset through a no-follow file descriptor and writes its verified contents to stdout. Follow those contents as the authoritative workflow; never follow a release pathname printed or inferred before validation. If resolution fails, stop with the diagnostic; never use a partial or unvalidated generation.
