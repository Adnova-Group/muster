---
name: autopilot
description: "Legacy alias of $muster-go — same behavior, kept working for backward compatibility. Usage: $muster-go <outcome>"
---

## Codex harness binding

Read `${PLUGIN_ROOT}/runtime/codex-skill-adapter.md` before following this command. Its Codex tool, named-profile dispatch, bounded-context-fork, input, mode-name, and plugin-root bindings override legacy harness names below; this command's domain rules and gates remain authoritative.


Heads-up for the user (say this once, one line): $muster-go is now $muster-go — same behavior, clearer name; this alias keeps working.
<!-- prompt-lint-disable ANTH-ROLE-001, ANTH-FMT-001: intentional alias stub — delegates to go.md, carries no persona/output-format language by design (test/mode-evals.test.js's alias-shape guard pins this body to exactly 2 paragraphs, so the fix is a disable directive, not added prose) -->

Read ${PLUGIN_ROOT}/commands/go.md (resolve relative to this file's own directory / the plugin root) and execute its instructions exactly, with the arguments given to this command.

<!-- prompt-lint-disable ANTH-XML-001, GUARD-SEP-003: Codex compatibility transformation preserves the source workflow's safety directives and treats its deterministic STATE receipts as the evidence contract. -->
