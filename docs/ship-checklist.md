# Ship checklist (0.5.0 bar)

The bar is finite — these, and nothing open-ended:

1. **Green suite**: `npm test` (pretest builds the Codex bundle — never gate on bare `node --test`).
2. **Install/doctor smoke**: `muster install <harness> --dry-run` + `muster doctor` clean on at least the Claude Code harness.
3. **CHANGELOG date-stamp**: fold `[Unreleased]` into the dated release section. Version stays as declared in package.json/plugin.json (lockstep, doctor-checked).

Context-health checks (Claude-5 context-engineering adoption, 2026-07-29):

4. **Prompt surface**: `node src/cli.js prompt scan .` reports zero failing files — the CTX-EXAMPLE-001/CTX-RULE-001 ratchets guard against example- and rule-densification of muster-authored prompts (`src/prompt-lint.js`).
5. **`claude doctor`**: run it in a session with the muster plugin enabled and act on anything it reports about muster's skills/CLAUDE.md footprint — Anthropic's own tooling for context-engineering drift.
