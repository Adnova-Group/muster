# Changelog

All notable changes to `@adnova-group/muster` are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.4] - 2026-06-09

### Added
- **Fable tier** — `modelForRole` routes peak judgment (tournament judge, architecture-review) to `fable`, degrading to `opus` when unavailable (`fallbackModelFor`); ordered tier policy exported as `MODEL_TIER_ORDER`/`maxTier`.
- **Crew model binding** — every non-inline crew member carries its `model` in the manifest (`makeStage`), and `manifest validate` rejects members without a known tier; the orchestrator passes the bound model as the Agent dispatch override.
- **PreToolUse wave-guard hook** — denies main-loop Edit/Write/NotebookEdit while `.muster/wave-active` exists (crew `agent_id` exempt, `.muster/` paths exempt, 60-min stale TTL, `MUSTER_WAVE_GUARD=warn|off`); SessionStart clears the marker only on `startup`/`clear` (never `compact`/`resume`).
- **`muster steer` subcommand** — deterministic steering classification over the CLI; orchestrator prose no longer references un-shipped `src/` functions.
- **Doctor checks** — hooks.json integrity (events + script paths) and installed-plugin staleness vs repo version, with remediation steps.
- **Generated-artifact drift test** — vendored agent frontmatter models must match `modelForRoles(roles)`; caught and fixed 3 stale `wsh-*` agents.

### Fixed
- All `npx muster` invocations in plugin prose now use `npx -y @adnova-group/muster` (the bare name resolves an unrelated registry package).
- `install` run from the ephemeral npx cache now recommends the GitHub marketplace (`Adnova-Group/muster`) instead of a prunable local path.
- Review-gate iteration cap (3) enforced in code (`reviewGateState`); vendor version-dir selection picks max semver (hash dirs no longer win); `skills` detection populated in the harness scan; `fileURLToPath` for repo-root resolution.
- Vendor pipeline hardening: id/repo/ref format validation, clone-root and repoRoot containment, tools allowlist for vendored agents.
- Stale "opus = heavy judgment" prose corrected to fable across README, docs, website, and command files; duplicate/ambiguous skill descriptions de-duplicated (gsd-verify-work, interview, domain-router); sp-debug no longer claims the implement role.

## [0.2.3] - 2026-06-09

### Added

- **In-session drift reinforcement (`UserPromptSubmit` hook).** A new plugin-native hook
  re-asserts muster mode on a turn cadence so a session stops reverting to default inline Claude
  behavior. Short nudge every `N` turns (`MUSTER_NUDGE_EVERY`, default 3); full
  principles + verbs every `N*K` turns (K = `MUSTER_PRINCIPLES_EVERY`, default 3 -- at defaults:
  nudge every 3, full every 9). Per-session turn counter in `os.tmpdir()`; fully self-contained and
  fail-safe (always valid JSON, exit 0). Compaction still re-fires `SessionStart` as a backstop.
- **Default-routing posture (`ROUTING_POLICY`).** Injected guidance now states that, in a
  muster repo, actionable prompts should be driven through the verbs (and copy/content through the
  humanizer) by default, while conversational turns fall through — no need to prefix every task
  with `/muster`. Carried in the `SessionStart` payload, the periodic full payload, and a condensed
  clause in the short nudge.
- **Orchestrator iron rule + `PreToolUse` wave-guard hook.** `plugin/skills/orchestrator`
  leads with the iron rule: each wave task MUST be dispatched via the Agent tool before any edit,
  with an announce-to-STATE requirement so inline work is auditable. The `PreToolUse` hook
  (`plugin/hooks/pre-tool-use.js`) now ships as the hard harness-level gate. Decision order:
  (1) subagent calls always allowed; (2) `.muster/` STATE writes always allowed; (3) allow if no
  wave marker; (4) allow if marker is stale (>60 min); (5) honour `MUSTER_WAVE_GUARD`:
  `off` = silent allow, `warn` = allow with reminder, unset or `deny` = deny.

### Changed

- **Shared `plugin/hooks/guidance.js` is the single source of truth.** `session-start.js` was
  refactored to consume `PRINCIPLES`/`VERBS`/`ROUTING_POLICY`/`detect` from it instead of inlining
  the text, so the two hooks can never drift apart.

## [0.2.2] - 2026-06-08

### Added

- **Fail-loud guard against an all-inline crew.** `npx muster manifest validate` now emits a
  `warnings` entry when every crew member has `source: inline` — the signature of a manifest that
  skipped capability resolution and would silently run everything in-context instead of routing to
  specialists (builtins resolve roles like `implement -> muster-builder`). The manifest is still
  structurally valid, so this is a warning, not an error; `validateManifest`'s `{ok, errors}`
  contract is unchanged. New `manifestWarnings()` export.

### Changed

- **`/muster:autopilot` step 3 spells out the recovery rule.** Build the crew from `npx muster
  capabilities`; never hand-author crew providers. If `manifest validate` fails or warns, fix the
  inputs (run the interview for `successCriteria`, re-resolve) rather than patching the crew to
  `inline` to force `ok:true`.
- **Output style tightened.** The Muster glass-box voice now caps verbosity hard (shortest complete
  answer, stop when answered, one table max), bans selling/justifying Muster, and bans self-narration
  ("Let me…") and rigor-flagging ("rather than guess").

## [0.2.1] - 2026-06-08

### Fixed

- **Installer no longer references the removed `/output-style` command.** Claude
  Code dropped `/output-style <name>` in v2.1.91, so a fresh install printed
  `Unknown commands: /output-style`. The glass-box style now ships inside the
  plugin (`plugin/output-styles/muster.md`) with `force-for-plugin: true`, so it
  auto-applies whenever the plugin is enabled — no command to run. `muster
  install` no longer copies anything into `~/.claude`; it just prints the plugin
  steps.

### Added

- **`muster uninstall`.** Prints the plugin-removal steps and cleans up any
  legacy home-copy of the output style left by older versions.
- **`keep-coding-instructions: true`** on the output style, so the glass-box
  voice layers on top of Claude Code's engineering behavior instead of replacing
  it.

Note: the npm `0.2.0` tarball predated this installer fix; `0.2.1` is the first
publish to carry it.

## [0.2.0] - 2026-06-08

### Added

- **`muster prioritize`: three new scoring models** (#2). Beyond the existing
  RICE model, the deterministic scorer now offers `--model ice`
  (impact times confidence times ease), `--model wsjf` (cost-of-delay divided by
  job-size), and `--model weighted` (Aha-style weighted scorecard: the sum of
  weight times score across custom criteria). Each fails loud on non-finite,
  non-positive, or zero-denominator inputs, matching RICE's discipline. The four
  models share one `scoreAndRank` scaffold, so they all produce the same shape:
  2-decimal scores, score-descending order with an ascending-name tie-break, and
  1-based ranks.
- **Roadmap pipeline: optional GitHub Projects board output** (#4). The
  `roadmap-prioritization` skill can now push the prioritized initiatives onto a
  GitHub Project board with status columns by tier (Now / Next / Later), in
  addition to the doc and issues. It degrades gracefully, skipping with a note
  when `gh project` access is unavailable, and reuses an existing board before
  creating one.

### Changed

- The `prioritize` dispatcher's unsupported-model error and the CLI usage strings
  now list every supported model (`rice`, `ice`, `wsjf`, `weighted`).
- `docs/architecture.md` documents all four prioritization models.

### Documented

- **Orchestrator generic-subagent fallback** (#1). The orchestrator skill now
  explicitly documents the degraded path: when a role resolves to an agent
  provider whose type is not yet dispatchable in the running session (for example,
  plugin agents installed before a restart), it falls back to a generic subagent
  with the resolved provider's brief injected and the role's model override still
  applied.

## [0.1.0] - 2026-06-08

### Added

- Initial public release. A glass-box, multi-domain agentic orchestrator for
  Claude Code: it detects the project, discovers installed capabilities, resolves
  each role to the best available provider, and runs a crew toward an outcome with
  every decision inspectable. Ships the `muster` CLI (deterministic, no LLM calls),
  the plugin (agents and skills), the capability and domain catalogs, the domain
  pipelines, and the glass-box output style. Runs on bare Claude Code and improves
  as more tools are installed.

[0.2.4]: https://github.com/Adnova-Group/muster/releases/tag/v0.2.4
[0.2.3]: https://github.com/Adnova-Group/muster/releases/tag/v0.2.3
[0.2.2]: https://github.com/Adnova-Group/muster/releases/tag/v0.2.2
[0.2.1]: https://github.com/Adnova-Group/muster/releases/tag/v0.2.1
[0.2.0]: https://github.com/Adnova-Group/muster/releases/tag/v0.2.0
[0.1.0]: https://github.com/Adnova-Group/muster/releases/tag/v0.1.0
