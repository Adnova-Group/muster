---
name: go-backlog
description: "Batch mode: sequentially runs the full go lifecycle (branch, route, waves, gates, disposition) over every item in a backlog, ticking each off as it completes; ONE attended stop at the end for the batch report, not per item. An escalated item never aborts the batch — it clears every item, done or escalated. (vs $muster-go: go-backlog clears MANY outcomes in one sitting, go runs ONE.) Usage: $muster-go-backlog <backlog ref>"
---

<!-- prompt-lint-disable ANTH-ROLE-001, ANTH-FMT-001: Bootstrap delegates to the role and output contract in the validated selected release. -->

# Immutable Muster bootstrap

Run `node ${PLUGIN_ROOT}/runtime/resolve-release.mjs command go-backlog`. The command revalidates the selected asset through a no-follow file descriptor and writes its verified contents to stdout. Follow those contents as the authoritative workflow; never follow a release pathname printed or inferred before validation. If resolution fails, stop with the diagnostic; never use a partial or unvalidated generation.
