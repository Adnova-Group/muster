# Slice 1 — deferred follow-ups

Living record. Non-blocking findings from the final review (2026-06-07). Resolved before merge: wshobson
recommendability, `detect.kind` enum validation, real `vcs` fields, friendly CLI arg errors.

Status:

- **`test/helpers.js` auto-loaded by `node --test`.** Shows as a no-op "test" in output. Rename to a
  non-`test/` location or `_helpers.js` to suppress. Harmless.
  **DEFERRED 2026-06-08** — cosmetic; not worth the cross-file import churn.
- **`AvailableCapabilities.roles[role].chain` sentinel.** Always appends a trailing `inline` entry;
  not described in the design's shape and unused by the router skill. Document it or drop it.
  **RESOLVED 2026-06-08** — documented in `plugin/skills/router/SKILL.md` (Respect the ladder: trailing
  `inline` is the always-available fallback, not a provider to prefer). Kept, not dropped.
- **`readMemory` hit shape undocumented for the router.** Hits are `{slug, content}` with raw
  markdown (frontmatter + body + `[[links]]`). Add a line to the router skill / `/muster` command
  describing the shape so the model extracts title/outcome reliably.
  **RESOLVED 2026-06-08** — documented in `plugin/skills/router/SKILL.md` (new "Input shapes" note:
  `{ slug, content }`, content is raw markdown, extract title/outcome from it).
- **`readJson` swallows malformed JSON.** A syntactically broken `package.json` is treated as
  "absent" rather than surfacing a warning. Design favors graceful degradation, but a malformed
  manifest is arguably worth a logged warning.
  **RESOLVED 2026-06-08** — `readJson` now warns on malformed JSON (detect's `package.json` path)
  instead of treating it as absent.
- **`/muster` command passes no path to `npx muster detect`.** Defaults to `cwd`; pass an explicit
  path (`"$PWD"`/`.`) so detection is correct if the agent's cwd drifts.
  **RESOLVED 2026-06-08** — `plugin/commands/run.md` step 2 now runs `npx muster detect .` (explicit
  path) so a drifted cwd doesn't misdetect.
- **`catalog/software.yaml` `wshobson-agents` detect match `agents`.** Verify the real published
  plugin id once wshobson/agents ships as a Claude Code plugin; adjust `detect.match` if needed.
  **BLOCKED — external** — pending the wshobson/agents plugin's publish; can't confirm the real plugin
  id until then.
