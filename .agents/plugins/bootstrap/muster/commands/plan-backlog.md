---
name: plan-backlog
description: "Declared-scope batch planner (the compound -backlog form) — the approve-first counterpart to $muster-go-backlog. Routes every item in a backlog up front and renders ONE batch plan (per-item crew summaries, run order, cross-item conflict flags), stopping for approval before anything runs. Given a raw intent instead of an existing backlog ref, first decomposes it into backlog items via the interview skill's decomposition machinery, gates the write with a capture-style human approval, then renders the batch plan. Approve & clear chains into $muster-go-backlog in-session. (vs $muster-plan, whose bare-verb form only reaches here after a scope confirm.) Usage: $muster-plan-backlog <backlog ref | raw intent>"
---

<!-- prompt-lint-disable ANTH-ROLE-001, ANTH-FMT-001: Bootstrap delegates to the role and output contract in the validated selected release. -->

# Immutable Muster bootstrap

Run `node ${PLUGIN_ROOT}/runtime/resolve-release.mjs command plan-backlog`. The command revalidates the selected asset through a no-follow file descriptor and writes its verified contents to stdout. Follow those contents as the authoritative workflow; never follow a release pathname printed or inferred before validation. If resolution fails, stop with the diagnostic; never use a partial or unvalidated generation.
