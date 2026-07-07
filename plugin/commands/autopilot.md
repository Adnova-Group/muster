---
name: autopilot
description: "Legacy alias of /muster:go — same behavior, kept working for backward compatibility. Usage: /muster:autopilot <outcome>"
---

Heads-up for the user (say this once, one line): /muster:autopilot is now /muster:go — same behavior, clearer name; this alias keeps working.
<!-- prompt-lint-disable ANTH-ROLE-001, ANTH-FMT-001: intentional alias stub — delegates to go.md, carries no persona/output-format language by design (test/mode-evals.test.js's alias-shape guard pins this body to exactly 2 paragraphs, so the fix is a disable directive, not added prose) -->

Read plugin/commands/go.md (resolve relative to this file's own directory / the plugin root) and execute its instructions exactly, with the arguments given to this command.
