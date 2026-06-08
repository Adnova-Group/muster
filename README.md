# Muster

Glass-box agentic orchestrator. Detects your project, discovers the capabilities you have installed,
assembles the right crew, and shows its reasoning. Works on bare Claude Code; gets better with the
tools you already use.

- Design: `docs/design/2026-06-07-muster-v1-glass-box-router.md`
- Plan: `docs/plan/2026-06-07-muster-v1-glass-box-router.md`

CLI: `npx muster detect | capabilities | manifest validate <file> | memory read|write`

Slice 2 (fan-out + review): `npx muster wave <manifest> | tally <verdicts> | pick <candidates>`
Design: `docs/design/2026-06-07-muster-v2-fanout-review.md`

Native built-ins: `npx muster vendor` imports curated upstream skills/agents (superpowers, gsd, wshobson) into `plugin/skills/builtins/` with attribution. Design: `docs/design/2026-06-07-muster-v3-native-builtins.md`
