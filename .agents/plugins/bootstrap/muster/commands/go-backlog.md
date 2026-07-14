---
name: go-backlog
description: "Batch mode: sequentially runs the full go lifecycle (branch, route, waves, gates, disposition) over every item in a backlog, ticking each off as it completes; ONE attended stop at the end for the batch report, not per item. An escalated item never aborts the batch — it clears every item, done or escalated. (vs $muster-go: go-backlog clears MANY outcomes in one sitting, go runs ONE.) Usage: $muster-go-backlog <backlog ref>"
---

<!-- prompt-lint-disable ANTH-ROLE-001, ANTH-FMT-001: Bootstrap delegates to the role and output contract in the validated selected release. -->

# Immutable Muster bootstrap

Run `node ${PLUGIN_ROOT}/runtime/resolve-release.mjs command go-backlog` and read the absolute path it prints. Follow that selected, validated immutable release file as the authoritative workflow. If resolution fails, stop with the diagnostic; never use a partial or unvalidated generation.
