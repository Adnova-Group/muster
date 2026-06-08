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

Commands (namespaced under the plugin): `/muster:run <outcome>` plans and shows the glass-box crew + plan, then stops for approval; `/muster:autopilot <outcome>` runs the full lifecycle hands-off (detect → route → waves → commit-per-wave → present merge); `/muster:diagnose <symptom>` is failure-first bug fix. `npx muster setup` scaffolds a new repo; `npx muster plan-checklist <manifest>` renders ticking progress. Design: `docs/design/2026-06-07-muster-v4-autopilot-greenfield.md`

Domain pipelines: Muster detects the work domain (`npx muster domain "<outcome>"`) and runs a phased, floor-scored pipeline (`npx muster pipeline <domain>`, `npx muster score`). Shipped pipelines: PRD (pm), business-case (business), blog-post (blog), social-post (social), lead-magnet (marketing), newsletter (newsletter), case-study (sales), runbook (ops). Content rubrics draw on AIDA/PAS/BAB/QUEST + E-E-A-T. PM/business/content/ops work is first-class, not just code. Design: `docs/design/2026-06-07-muster-v5-domain-pipelines-prd.md`

Diagnose (bug fix): `/muster:diagnose <symptom>` (or paste failing output) -> reproduce -> root cause (systematic debugging, via the best available `debug` provider) -> fix -> regression test -> verify. `npx muster diagnose` seeds the fix plan. Design: `docs/design/2026-06-07-muster-v6-diagnose.md`
