---
name: sprint
description: "Legacy alias of /muster:go-backlog — same behavior, kept working for backward compatibility; deprecated 2026-07-17, retiring in muster 0.7.0. Usage: /muster:sprint <backlog ref>"
---

Heads-up for the user (say this once per session): /muster:sprint is now /muster:go-backlog — same behavior, clearer name; this alias keeps working. Deprecation notice (2026-07-17): /muster:sprint retires in muster 0.7.0 — switch to /muster:go-backlog before then; behavior stays unchanged for the rest of this window.
<!-- prompt-lint-disable ANTH-ROLE-001, ANTH-FMT-001: intentional alias stub — delegates to go-backlog.md, carries no persona/output-format language by design (test/mode-evals.test.js's alias-shape guard pins this body to exactly 2 paragraphs, so the fix is a disable directive, not added prose) -->

Read plugin/commands/go-backlog.md (resolve relative to this file's own directory / the plugin root) and execute its instructions exactly, with the arguments given to this command.
