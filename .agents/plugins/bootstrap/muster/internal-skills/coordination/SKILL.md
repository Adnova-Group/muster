---
name: coordination
description: "Codex-compatible Muster workflow. Source-agnostic protocol for running one backlog with more than one independent runner at a time — CLAIM before work, structured RECEIPTS on every state change, BLOCKED items record a question and RESUME once answered (HUMAN-HOLD narrows resume to a named authorizer), one heartbeat LEDGER entry per runner. Three bindings: GitHub issues (labels + gh CLI), backlog.md (annotations + STATE), and Linear (issue statuses + MCP). Wired in by $muster-go-backlog."
---

<!-- prompt-lint-disable ANTH-ROLE-001, ANTH-FMT-001: Bootstrap delegates to the role and output contract in the validated selected release. -->

# Immutable Muster bootstrap

Run `node ${PLUGIN_ROOT}/runtime/resolve-release.mjs internal-skill coordination`. The command revalidates the selected asset through a no-follow file descriptor and writes its verified contents to stdout. Follow those contents as the authoritative workflow; never follow a release pathname printed or inferred before validation. If resolution fails, stop with the diagnostic; never use a partial or unvalidated generation.
