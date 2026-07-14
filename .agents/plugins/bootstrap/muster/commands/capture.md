---
name: capture
description: "Conversation-to-backlog generator — the third and final backlog generator, alongside the interview skill's decomposition check and audit's backlog mode, so hand-written backlog items are never needed. Turns a session's discussion (research findings, design decisions, review residuals, explicit user directives like 'add those 5') into backlog items via the identical extract/validate/dedupe/write machinery, gated by human approval before anything is written. Usage: $muster-capture [hint] — hint optionally scopes which part of the conversation to mine; empty = the whole session so far."
---

<!-- prompt-lint-disable ANTH-ROLE-001, ANTH-FMT-001: Bootstrap delegates to the role and output contract in the validated selected release. -->

# Immutable Muster bootstrap

Run `node ${PLUGIN_ROOT}/runtime/resolve-release.mjs command capture` and read the absolute path it prints. Follow that selected, validated immutable release file as the authoritative workflow. If resolution fails, stop with the diagnostic; never use a partial or unvalidated generation.
