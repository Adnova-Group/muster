# Changelog

All notable changes to `@adnova-group/muster` are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.3.2] - 2026-07-02

### Added
- **Cowork MCP parity -- muster_fuse + muster_advise tools.** Two new MCP tools bring the Cowork surface to 0.3.1 feature parity: `muster_fuse` (fusion decision engine -- validate the debate map, apply the agreement gate, select top-K for synthesis or fall back to the single best; deterministic, no LLM) and `muster_advise` (validate an advice-request and resolve the advisor model fable->opus; deterministic, no LLM). Tool count: 17 -> 19.
- **Fusion/advisor execution protocol in Cowork INSTRUCTIONS.** The wave-barrier step now teaches the full fusion flow (judge maps consensus/contradiction/partial-coverage/blind-spots -> muster_fuse decides fuse-vs-fallback -> synthesizer grafts top-K; muster_pick remains the fallback ranker) and adds an advisor escalate-up step (worker returns a structured advice-request -> muster_advise resolves the advisor model -> advisor dispatched and feeds advice back; worker keeps the decision; consult budget bounded).
- **Todo-driving gate -- runs are mechanically todo-driven.** A new `PreToolUse` hook on the `Task` tool denies a subagent-wave dispatch during a live muster run unless a native todo list (`TodoWrite`/`TaskCreate`/`TaskUpdate`) was written since the run started, so plan progress stays visible in Claude Code's todo UI. Biased hard toward allow -- fail-open on any uncertainty, with a 2s grace margin against sub-second timestamp flooring -- and tunable via `MUSTER_TODO_GATE` (`off`/`warn`).
- **Enforcement layer: run-active scoping + named limits.** `.claude/` meta-edits are exempt from the write gates, the post-run scale gate is scoped to the `run-active` marker with an explicit verb lifecycle, enforcement limits are named constants, and the post-hoc humanizer artifact contract is now covered by tests.

### Changed
- **Structure-first concision in the muster output style.** The output style now leads with structure (answer first, then support) and trims filler, derived from the atomic-claude concision rules.

### Fixed
- **Security: A-SEC2 re-broadened.** Any `$` in a Bash redirect target is denied (closes a variable-traversal of the write gate); the bash write-guard is hardened against parser-differential bypasses; and a SEC-1 path-normalization bypass in the hooks is closed.
- **Whole-repo audit (waves 1-5 and A-D).** P1 fixes across src-core (env parsing, array guards, a memory race), hooks (guard scope, `applyGate`, hook `envInt`), and cowork (async `mkdtemp`, cwd footgun, json2 dedup); test-coverage additions incl. re-scoped wave-guard tests; public docs synced with the enforcement + fusion + issue-verb reality.

## [0.3.1] - 2026-07-01

### Added
- **Fusion tournaments.** The agent tournament now synthesizes instead of discarding runners-up. A judge maps consensus, contradictions, partial-coverage, and blind-spots across all candidates; `muster fuse` decides fuse-vs-fallback (an agreement-gate skips synthesis when candidates already agree, fuses only the top-K, and de-identifies plus hash-orders them to curb position and self bias); a synthesizer then grafts the best of the top-K under a hardened anti-launder prompt. Winner-take-all stays as the deterministic fallback (`pickWinner`), tunable via `MUSTER_FUSE_MIN_DISAGREEMENT` and `MUSTER_FUSE_TOPK`. Native (no external server tools), grounded in Mixture-of-Agents and LLM-Blender.
- **Advisor role (escalate-up).** A cheap-tier worker can consult a stronger model (fable, degrading to opus) at a hard decision point: it returns a structured advice-request, `muster advise` validates it, a consult budget bounds cost (`MUSTER_ADVISOR_MAX_CONSULTS`, default 3), the consult is logged to STATE, and the advice is fed back so the worker keeps the decision. The advisor informs; the worker decides. Native and autonomous-first (no human prompt).
- **Post-run scale gate.** The `PreToolUse` hook now also guards the window after a run completes: main-loop inline work that crosses the 3-file boundary (`MUSTER_INLINE_SCALE`, default 3) in a turn with no active wave is denied and routed to a verb, counting both editor tools and high-confidence Bash writes. Closes the drift gap the advisory nudge alone could not hold.

### Changed
- **`/muster:run` "Approve & run" chains into `/muster:autopilot` in-session.** Approving a plan now runs it end to end without pasting a command; Adjust and Cancel stay plan-only.

## [0.3.0] - 2026-06-23

### Added
- **`muster-improver` agent + `improve` role** — a read-only post-run retrospective that mines the run STATE, escalations, and review-gate fix-loops for recurring friction and proposes user-gated edits to muster's own skills/agents/rules (proposes, never applies). Closes the self-improvement gap vs the atomic-claude role concept; dispatches on the top tier alongside the strategist.
- **`muster humanize-score <file>`** + `src/humanizer-score.js` — a deterministic 0–100 AI-tell score (no LLM) with per-category capped penalties (em/en-dash & curly quotes, tiered vocab, banned openers, signposting, negative parallelism, copula avoidance, sycophancy, emoji). The CI-gateable measure behind the LLM humanizer rewrite (default pass ≥ 85).
- **lintlang H3/H4/H7 coverage** in the prompt linter: `LINT-SCHEMA-003` (schema↔intent — fires when real tool schemas are passed via `prompt lint --tool-schema <file>`), `lintChat` + `prompt lint --chat <file>` (H7 role-ordering / role-bleed, incl. API content-block arrays), and `lintWorkflow` + `prompt lint --workflow <file>` (H4 context-boundary erosion — shared mutable-state artifacts across sibling prompts).
- **`tool-call` and `trajectory` eval graders** (`prompt-eval.js`) — validity checks for prompts that must emit a function call or a multi-step agent trajectory (promptfoo `is-valid-function-call` analog).
- **`trackOptimization`** (`prompt-optimize.js`) — a deterministic multi-round convergence controller (running-best + plateau patience) so an iterative optimize loop stops instead of running forever.
- **`calibrateScores`** (`score.js`) — an optional per-judge per-criterion offset hook for cross-provider score comparability (identity no-op until offsets are empirically measured).
- **Orchestrator hardening** — a pre-flight plan-conflict review before wave 1, `muster-strategist` root-cause dispatch on review-gate escalation (before the human prompt), and per-task git-worktree isolation for concurrent file-writing wave tasks.
- **`book` pipeline** gains a premise-forge gate (5 scored variants behind a floor before drafting), a per-chapter scored loop, and a continuity-propagation ledger; plus targeted pipeline/skill currency fixes (blog-post GEO/answer-first + named-author E-E-A-T, ADR→MADR 4.0 status lifecycle, test-plan→ISO/IEC/IEEE 29119-3, canonical RICE scales, the 9 Lawrence story-splitting patterns, runbook triage decision-tree).
- **Built-in skill enrichments** — humanizer (two-pass self-audit, tiered vocab, full tell taxonomy, voice calibration), research (cross-source corroboration + entailment-checked citations), scorer (LLM-judge bias guardrails), author (PASTOR + Schwartz routing, de-slop pass), prompt-smith (failure-reasons-as-actionable-side-info in the optimize loop).

### Fixed
- **ReDoS** in `lintWorkflow`'s `STATE_TOKEN` regex (catastrophic backtracking via `prompt lint --workflow`) — rewritten as non-overlapping anchored alternatives, which also removes the false positive on bare prose words.
- `humanize-score` read unbounded stdin and duplicated the reader — hoisted the capped `readStdin`/`readText` helper to module scope and reused it.
- `LINT-SCHEMA-003` field check now uses word boundaries (a required `id` is no longer satisfied by "provided"); humanizer-score emoji range narrowed to drop typographic-dingbat false positives and catch flag emoji; `lintChat` flattens API content-block arrays; `calibrateScores` rejects a non-finite offset; the fenced-JSON parser is deduplicated (`stripFence`/`isToolCallShape`).

### Docs
- Full muster asset drift audit ledger (`docs/audits/2026-06-23-muster-asset-drift-ledger.md`): every shipped asset traced to its source material with ranked, adopted improvements.

## [0.2.8] - 2026-06-18

### Added
- **Prompt evaluation (`lint → eval → optimize`)** — a muster-native capability for grading prompts an application generates at runtime to build agents/agentic workflows, and prompts found in a codebase muster is working in. Three deterministic, dependency-free core modules plus a model-driven skill:
  - **`src/prompt-lint.js`** — a no-LLM structural linter (callable at runtime, <50ms) that enforces Anthropic's prompt-engineering best practices (role/system, XML tags around interpolated content, multishot examples, explicit output format, positive framing, clear-and-direct lead) plus the agent/guardrail rules (imperative tool framing and stop conditions from the lintlang taxonomy; "I don't know" allowance, citations, and input separation from the strengthen-guardrails docs). Every rule carries a source-cited id (e.g. `ANTH-XML-001`, `LINT-STOP-002`) and a fix; findings are scored into a five-dimension rubric gated by the floor principle (`scoreArtifact`).
  - **`src/prompt-eval.js`** — an empirical eval pipeline: `{{VARIABLE}}` interpolation, code-based graders (`json`/`regex`/`python`), an LLM-judge grader (reasoning-before-score), and a `gradeCollected` path that scores pre-collected outputs offline. Reports per-case score, accuracy, and average.
  - **`src/prompt-optimize.js`** — an evaluator-optimizer loop that proposes technique-driven variations (each closing a specific lint gap), re-scores them, and selects the winner via the tournament floor (`pickWinner`), flagging a regression when no variation beats the pinned baseline.
- **`muster prompt lint|variations|eval|optimize`** CLI subcommands (file or stdin) and a **`prompt-quality` role** resolved by the new **`muster-prompt-smith`** built-in skill, so the router can dispatch prompt review as a quality dimension. `promptfoo` is supported as an optional eval substrate behind the injected `callModel` contract; the native runner is the zero-dependency default.
- **Prompt quality as a conditional `audit` dimension** — when the target project builds prompts/agents, `muster audit` adds a 7th read-only review dimension. `detect.js` emits a `prompting` signal when an LLM/agent SDK dependency is present (`@anthropic-ai/sdk`, `openai`, `langchain`/`@langchain/*`, `llamaindex`/`@llamaindex/*`, `ai`/`@ai-sdk/*`, `@modelcontextprotocol/sdk`, etc.); `buildAuditManifest(caps, { prompting })` gates the `prompt-quality` dimension on it (via the git-free `hasPromptingSignal`), so a plain codebase still gets the six core dimensions.
- **`muster prompt scan <dir>`** — deterministic repo prompt-discovery: walks the tree (skipping vendored/build dirs, text files only, per-file + total caps), locates candidate prompts via `src/prompt-discover.js` (`.prompt` files, `prompts/` directories, and backtick `system`/`prompt`/`instructions`/`persona` assignments), lints each, and returns per-prompt findings plus a pass/fail summary. This is the repo-scan mode the `muster-prompt-smith` skill uses to drive the audit dimension.
- **Genre-aware prompt linting.** `lintPrompt` takes a `ctx.genre` of `task` (default) or `system`. Task-only rules (action-verb lead, multishot examples) are exempt for system/instruction prompts, and `ANTH-POS-001` tolerates more prohibitions for guardrail roles. `prompt lint`/`variations` gain a `--system` flag, and `prompt scan` lints discovered docs in the system genre. Score counts every applicable finding (any severity), so zero findings ⇔ a perfect 15/15.
- **`prompt scan` finds markdown/text prompts, not just code.** `discoverPrompts` recognizes prompt docs — markdown with `name`+`description` frontmatter (the Claude Code skill/agent/command convention) or files under `.claude/`/`plugin/` `agents|commands|skills` (and any `prompts/`) — and strips YAML frontmatter so the lint reads the instruction body. Ordinary docs (`README`, `docs/`, `website/`, `.github/` issue templates) are deliberately excluded.
- **Per-prompt `prompt-lint-disable` directive.** `<!-- prompt-lint-disable RULE-ID: reason -->` suppresses a rule for a prompt that legitimately violates it (e.g. an orchestration prompt that must stack prohibitions); suppressions are surfaced in `result.suppressed`.
- **Router eval harness (`eval/router/`).** The first empirical (response-quality) eval: outcome → Crew Manifest, graded by code (manifest validity + expected-role coverage) and an LLM judge (routing appropriateness). Wired into CI as a deterministic contract regression test (`test/router-eval.test.js`, runs in `npm test`) plus an `npm run eval:router` report step; the full model-driven run stays a manual/scheduled job. See `eval/router/README.md`.

### Changed
- **Broadened + hardened linter detectors.** `ANTH-ROLE-001` accepts second-person persona framing ("You review a diff."); `ANTH-FMT-001` accepts natural-language and verb-near-format-noun specs ("one finding per line", "Emit ONLY the … JSON"); code stripping is now language-agnostic and ReDoS-safe (line-based `stripCode` blanks fenced, `<pre>`/`<code>`, and indented blocks for any language); interpolation detection covers Handlebars/JS/Ruby/ERB/Python styles. These removed false positives the dogfood surfaced.
- **muster's own prompts taken to 15/15.** Dogfooding the linter on muster itself remediated all 88 shipped prompt-docs to a clean 15/15 (adding roles, output-format lines, and "I don't know" allowances), with the safety-critical orchestration prompts kept verbatim and cleared via the disable directive rather than rewritten.

### Fixed
- **Router skill emitted invalid manifests.** The router eval found that the router skill's documented crew shape omitted the `model` field that `validateManifest` requires (a defect the structural linter, which scored the router 15/15, could not see). The crew shape now specifies `model` per non-inline member, sourced from `roles[role].model`; re-running the router yields valid manifests.

## [0.2.7] - 2026-06-15

### Added
- **Claude Cowork port (in progress)** — `cowork/mcp-server.mjs` wraps muster's deterministic CLI brain as a local MCP server (zero-dep stdio JSON-RPC, 16 tools: routing, scoring, RICE, wave planning), with principles + routing policy injected via the MCP `instructions` field (reusing `plugin/hooks/guidance.js`). `cowork/manifest.json` is the MCPB desktop-extension descriptor. Cowork extends only through MCP/MCPB — no plugin/skill/slash/hook primitives — so the deterministic half ports cleanly; the orchestration half is gated on undisclosed subagent dispatch.
- **`scripts/cowork-probe.mjs`** — portability probe for a target runtime: phase 1 (CLI shell-out + JSON shape) and phase 2 (dispatch-contract invariants) self-verify; phase 3 emits a fan-out + model-override self-test spec the host runtime executes, then grades the results via `--dispatch-results`.
- **`muster next` / `muster_next`** — single-agent execution driver. Given a manifest and the task ids completed so far, returns the next runnable task (lowest wave first), the full ready frontier, and the blocked set with missing deps (`nextTasks` in `src/wave.js`, reusing `computeWaves` validation). Lets a runtime with no parallel dispatch (e.g. Cowork's single agent loop) walk a plan deterministically: run `next`, append its id, repeat. Exposed as the 17th Cowork MCP tool.
- **Connector-aware capabilities** — `muster capabilities --cowork` (and the MCP `muster_capabilities` tool) resolves providers from Cowork's MCP registry instead of `~/.claude`: local servers from `claude_desktop_config.json` and MCPB extensions enumerated from the `Claude Extensions/` directory (`readInstalledCowork` / `coworkConfigDirs` in `src/harness.js`, Windows MSIX-virtualized path tried first). Remote connectors cannot be discovered from disk, so they are reported with `connectorsDiscoverable: false` and accepted as a declared list via `--connectors` / `MUSTER_COWORK_CONNECTORS`. The MCPB manifest exposes these as `user_config` (`enable_fable`, `max_tier`, `connectors`) wired through `mcp_config.env`.

### Changed
- **MCPB manifest bumped to `manifest_version` 0.3** (the DXT→MCPB rename) with `user_config` and `compatibility.runtimes.node`. `MUSTER_ENABLE_FABLE` parsing hardened so an MCPB boolean `user_config` (which substitutes as the string `"false"`) no longer wrongly enables fable. The probe now flags the Windows-MSIX child-process spawn risk.
- **Cowork dispatch confirmed and the execution protocol completed.** Parallel subagent dispatch with per-call model override verified working in Claude Cowork, so the MCP `instructions` now carry the full per-mode lifecycle (autopilot branches then commits per green wave then presents the merge; audit fans out six review dimensions; diagnose reproduces before fixing; run plans and stops), leading with parallel fan-out and keeping `muster_next` as the no-fan-out fallback. `cowork/README.md` expanded with full prerequisites, both install routes (local MCP server and MCPB), a configuration reference, and troubleshooting.

### Fixed
- **UserPromptSubmit hook stays silent on slash-command turns.** The hook injected `additionalContext` on every turn, including `/command` turns. In a relayed/remote session (Claude Code driven from a desktop remote-control session) that injected `<system-reminder>` could land ahead of the typed command and break slash-command parsing. The hook now emits nothing and skips the turn counter when the prompt starts with `/` (after leading whitespace) — re-asserting muster mode on an explicit command is noise anyway.
- **Fable degrades to opus deterministically, by default** — Anthropic disabled the fable tier platform-wide, and the old fallback was prose-only in the orchestrator skill (the model had to catch the dispatch rejection) while `fallbackModelFor` sat unused, so orchestrated runs *choked* instead of falling over. `modelForRole` (`src/model.js`) now wires `fallbackModelFor("fable")` unless `MUSTER_ENABLE_FABLE=1` is set, so `capabilities`/`crew`/`signals`/vendored agent frontmatter never emit fable and the orchestrator never dispatches a rejected tier. Opt back in with `MUSTER_ENABLE_FABLE=1` when the tier returns.

## [0.2.6] - 2026-06-10

### Added
- **Subagent dispatch-failure contract** — a dispatch that errors or dies is never a silent stop: the orchestrator re-dispatches once with the error appended as context (`dispatchRetryState` / `DISPATCH_MAX_ATTEMPTS = 2` in `src/loop.js`, mirroring the review-gate primitive); model-availability rejections keep following the fable→opus fallback; a second failure escalates like a review-gate cap while the wave's other tasks still complete. Field-reported: an orchestrated run halted outright when one subagent errored.

## [0.2.5] - 2026-06-10

### Added
- **Doctor `install-integrity` check** — verifies each registered muster entry's `installPath` actually exists and contains `hooks/hooks.json`. Catches the field failure where `installed_plugins.json` records a successful install but the plugin-cache copy silently never happened, leaving the plugin inert (no hooks → no routing) while the staleness check reports healthy. Failure detail names the missing path and the uninstall/reinstall remediation.

## [0.2.4] - 2026-06-09

### Added
- **`MUSTER_MAX_TIER` env cap** — `capTier(tier, cap)` (exported from `src/model.js`) enforces a model-tier ceiling: if the resolved tier sits above the cap in `MODEL_TIER_ORDER`, the cap is returned instead. `modelForRole` applies the cap as its final step so it flows through capabilities → crew manifests → dispatch. Invalid or unset cap is a no-op (fail-open). Example: `MUSTER_MAX_TIER=opus` disables Fable and routes peak-judgment roles to Opus; `MUSTER_MAX_TIER=sonnet` for budget mode.
- **Bash wave-guard (extends PreToolUse hook)** — the PreToolUse hook (first shipped in 0.2.3 for `Edit|Write|NotebookEdit`) now also matches `Bash` commands. When a wave is active, Bash commands are inspected by `bashWriteTarget()` (pure function in `plugin/hooks/bash-write-target.js`, unit-tested without spawning) and denied only on high-confidence file writes: `sed -i`, `tee` to a non-exempt target, and `>` / `>>` redirects to non-exempt targets. Everything else allows (fail-open). Exempt targets: `/dev/*`, `/tmp/*`, `.muster/*`. Deny reason names the matched pattern and notes `MUSTER_WAVE_GUARD=warn` as the false-positive escape hatch. `MUSTER_WAVE_GUARD` values: `deny` (default), `warn` (allow with reminder), `off` (disable guard). Known limitations: unbalanced quotes and heredoc bodies are not fully parsed (balanced quoted strings are handled).
- **SHA-pinned vendor sources** — github sources in `vendor/manifest.yaml` are pinned to full commit SHAs (`wshobson/agents`, `open-gsd/gsd-core`); `muster vendor` fetches a pinned SHA via init/fetch/checkout (`cloneCommandsFor`). Updating an upstream is now a deliberate act: bump the SHA, re-vendor, and review the full regenerated diff before committing (see CONTRIBUTING "Vendored content").
- **Fable tier** — `modelForRole` routes peak judgment (tournament judge, architecture-review) to `fable`, degrading to `opus` when unavailable (`fallbackModelFor`); ordered tier policy exported as `MODEL_TIER_ORDER`/`maxTier`.
- **Crew model binding** — every non-inline crew member carries its `model` in the manifest (`makeStage`), and `manifest validate` rejects members without a known tier; the orchestrator passes the bound model as the Agent dispatch override.
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

[0.3.2]: https://github.com/Adnova-Group/muster/releases/tag/v0.3.2
[0.3.1]: https://github.com/Adnova-Group/muster/releases/tag/v0.3.1
[0.3.0]: https://github.com/Adnova-Group/muster/releases/tag/v0.3.0
[0.2.6]: https://github.com/Adnova-Group/muster/releases/tag/v0.2.6
[0.2.5]: https://github.com/Adnova-Group/muster/releases/tag/v0.2.5
[0.2.4]: https://github.com/Adnova-Group/muster/releases/tag/v0.2.4
[0.2.3]: https://github.com/Adnova-Group/muster/releases/tag/v0.2.3
[0.2.2]: https://github.com/Adnova-Group/muster/releases/tag/v0.2.2
[0.2.1]: https://github.com/Adnova-Group/muster/releases/tag/v0.2.1
[0.2.0]: https://github.com/Adnova-Group/muster/releases/tag/v0.2.0
[0.1.0]: https://github.com/Adnova-Group/muster/releases/tag/v0.1.0
