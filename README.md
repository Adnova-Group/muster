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

Agent layer: roles resolve to a first-class `agent` provider kind alongside skills/MCP (`muster capabilities` -> `roles[<role>].chosen.kind` is `agent | skill | mcp | inline`). Muster ships its own clean-room specialists in `plugin/agents/` — `muster-surgeon` (1-2 file edits), `muster-builder` (cohesive slice), `muster-reviewer` (verdict-emitting review), `muster-investigator` (read-only locator, haiku), `muster-strategist` (heavyweight reasoning, opus) — authored fresh from the role concept (atomic-claude credited as inspiration, not copied; Apache-2.0). It also vendors curated MIT agents from wshobson/agents (backend-architect, code-reviewer, debugger, security-auditor, frontend-developer, test-automator, legacy-modernizer, docs-architect) with provenance, via `vendor/manifest.yaml`. The ladder prefers an installed external agent first, then a muster built-in agent, then a skill, then inline — so muster composes the tools you already have and falls back to its own, and no longer borrows atomic's agents at build time. Dispatch honors `chosen.kind` (agent → `subagent_type`; else generic + injected skill) and always applies `roles[<role>].model` as the model override, so `modelForRole` governs regardless of provider kind.

Commands (namespaced under the plugin): `/muster:run <outcome>` plans and shows the glass-box crew + plan, then stops for approval; `/muster:autopilot <outcome>` runs the full lifecycle hands-off (detect → route → waves → commit-per-wave → present merge); `/muster:diagnose <symptom>` is failure-first bug fix. `npx muster setup` scaffolds a new repo; `npx muster plan-checklist <manifest>` renders ticking progress. Design: `docs/design/2026-06-07-muster-v4-autopilot-greenfield.md`

Domain pipelines: `npx muster route "<outcome>"` picks the right pipeline by matching the outcome (then domain default), and `npx muster pipeline <id|domain>` shows it; all are phased + floor-scored (`npx muster score`). 18 shipped — PRD, business-case, epic, user-story, launch-plan, release-notes, executive-summary, okrs, ai-implementation-spec, ai-test-plan (the ForceVue doc set), competitive-battlecard, blog-post, social-post, lead-magnet, newsletter, case-study, runbook, and book (fiction + non-fiction). The author/research/score roles resolve to bundled best-of-breed built-ins (copywriting frameworks AIDA/PAS/BAB/QUEST + E-E-A-T; floor-principle scoring). PM/business/content/ops work is first-class, not just code. Design: `docs/design/2026-06-07-muster-v5-domain-pipelines-prd.md`

Diagnose (bug fix): `/muster:diagnose <symptom>` (or paste failing output) -> reproduce -> root cause (systematic debugging, via the best available `debug` provider) -> fix -> regression test -> verify. `npx muster diagnose` seeds the fix plan. Design: `docs/design/2026-06-07-muster-v6-diagnose.md`

Model selection: each role carries a model (`muster capabilities` -> `roles[<role>].model`) — mechanical roles (code-navigation, docs-research, research) run on haiku, default sonnet, heavy judgment / tournament judge on opus. The orchestrator dispatches subagents accordingly, so quota spend tracks the work.

Execution model: the `muster` CLI is deterministic Node (no LLM calls). Model work runs through the interactive Claude Code session's built-in subagent dispatch (the Task tool) — NOT `claude -p` or the Agent SDK. So Muster draws normal interactive subscription quota (it does not hit the separate June-2026 Agent-SDK credit), and fan-out simply spends that quota faster.

Output style: `output-styles/muster.md` is a glass-box, terse TUI voice (lead with outcome, show crew/decisions/evidence, tick checkboxes). Enable via `/output-style` or copy to `~/.claude/output-styles/`.

Ralph loop + humanizer: orchestration loops-until-done via the Ralph primitive (`src/loop.js` `loopState({ iteration, maxIterations, done })` -> `iterate` | `done` | `max-iterations`) — each wave re-runs implement→review→fix until the gate passes or the cap escalates, so subagents drive toward the success criteria instead of stopping after one pass. Every human-facing pipeline ends with a `humanize` phase (the `muster-humanizer` built-in: strips em-dashes, banned words, robotic cadence) — machine-facing AI specs (ai-implementation-spec, ai-test-plan) are exempt to preserve technical precision.

Driving muster remotely: Muster ships no remote-control transport of its own — it rides Claude Code's native features. **Schedule it** — a Claude Code Routine (`/schedule`, `claude.ai/code/routines`, or API `POST https://api.anthropic.com/v1/claude_code/routines/<id>/fire` with a `text` field) fires `/muster:autopilot <outcome>` as an autonomous cloud run; unattended mode opens a PR by default (see `plugin/commands/autopilot.md`). Docs: `code.claude.com/docs/en/routines.md`. **Steer it** — Channels (Telegram/Discord/iMessage/webhook) deliver `<channel>` events the orchestrator interprets as steering (approve / stop / status / retarget) mid-run; the session must be running to receive them. Docs: `code.claude.com/docs/en/channels.md`. **Take over** — Remote Control (`claude --remote-control` / `/remote-control`, QR to phone) gives phone/web access to a running local session when a human wants to grab the wheel. Docs: `code.claude.com/docs/en/remote-control.md`.

Expanded built-ins (wshobson-expand): two new routable roles added — `performance` (application performance engineering) and `seo` (technical SEO optimization) — plus expanded wshobson coverage: `application-performance` and `seo-technical-optimization` plugins vendored via their primary agent files (no skills/ dir in source); `distributed-debugging`, `error-debugging`, `error-diagnostics`, `code-refactoring`, and `codebase-cleanup` plugins skipped (no skills/ dir; existing wsh-* builtins already cover debug/refactor/tech-debt roles). Total vendored builtins: 44 generated + 3 muster-authored = 47.
