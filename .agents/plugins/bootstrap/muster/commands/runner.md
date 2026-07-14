---
name: runner
description: "Unattended one-cycle work-picker: resolves a work source, resumes an answered blocked item or claims exactly ONE available item, drives it through the full autopilot lifecycle disposition-forced to pr, leaves receipts, and stops — fired repeatedly by a Codex automation/cron; the standing runner IS this mode invoked on a schedule. (vs $muster-go-backlog, which drains a whole backlog in one sitting.) Usage: $muster-runner [backlog path | issues:<label>]"
---

<!-- prompt-lint-disable ANTH-ROLE-001, ANTH-FMT-001: Bootstrap delegates to the role and output contract in the validated selected release. -->

# Immutable Muster bootstrap

Run `node ${PLUGIN_ROOT}/runtime/resolve-release.mjs command runner` and read the absolute path it prints. Follow that selected, validated immutable release file as the authoritative workflow. If resolution fails, stop with the diagnostic; never use a partial or unvalidated generation.
