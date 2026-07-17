# Muster

Glass-box, multi-domain agentic orchestrator for Claude Code and Codex. Give it an outcome; it assembles the right crew and shows its reasoning before it acts.

[![License: Apache-2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](LICENSE)
[![Node >= 20](https://img.shields.io/badge/node-%3E%3D20-brightgreen.svg)](package.json)
[![npm](https://img.shields.io/npm/v/@adnova-group/muster.svg)](https://www.npmjs.com/package/@adnova-group/muster)
[![Docs](https://img.shields.io/badge/docs-adnova--group.github.io%2Fmuster-6d5ce7.svg)](https://adnova-group.github.io/muster/)

📖 **Documentation: [adnova-group.github.io/muster](https://adnova-group.github.io/muster/)**

## What it is

Muster turns an outcome into finished work. It detects your project, discovers the capabilities you already have installed, picks the best tool for each piece of the job, and runs a crew of specialists toward your success criteria. Every decision is inspectable: which role resolved to which provider, on which model, and why.

It runs on bare Claude Code or Codex with no separate model API, and it gets better as you install more tools. The work is not limited to code. Product, business, content, and operations are first-class.

## Quickstart

```sh
npx -y @adnova-group/muster install
```

`install` mutates nothing in your `~/.claude`. It just prints the steps it cannot do for you, because registering a plugin is a Claude Code action:

```sh
/plugin marketplace add Adnova-Group/muster  # register the marketplace
/plugin install muster@muster                # install the plugin
```

Muster's glass-box output style ships inside the plugin and applies automatically when the plugin is enabled (`force-for-plugin`), so there is no command to run. Plugin install is a Claude Code action, so the running session picks Muster up only after you (re)install it through `/plugin`. Restart or `/clear`, then run your first outcome:

```
/muster:plan Add rate limiting to the public API with tests
```

### Codex CLI and Desktop

Build or install the package, then install Muster's managed Codex profiles and plugin:

```sh
npx -y @adnova-group/muster install codex --scope project
```

`--scope project` writes Muster-owned profiles under `.codex/agents/` plus the hook runtime under `.codex/muster/`, and merges owned hook groups into `.codex/hooks.json`. `--scope user` uses the corresponding paths under `$CODEX_HOME` (or `~/.codex`). Existing unrelated profiles and hook groups are preserved. With Codex on `PATH`, Muster registers `Adnova-Group/muster` and adds `muster@muster` idempotently. Without Codex it still installs the profiles and hooks, then prints the exact registration follow-up.

Use `$muster` or a mode skill such as `$muster-plan`, `$muster-go`, `$muster-audit`, or `$muster-capture`. The three legacy aliases (`run`, `autopilot`, `sprint`) remain skills. Codex users can inspect live Codex capability state with `muster capabilities --codex` and run `muster doctor --codex`.

The Codex plugin bundles the deterministic CLI, all pipelines, 21 MCP tools, 27 custom-agent profiles, 11 native skills, and 51 capability skills. The npm installer adds Codex-native lifecycle hooks through the supported project or user `hooks.json` layer because Codex 0.144 does not execute plugin-bundled hooks. Codex requires a one-time trust review for these non-managed hooks; inspect them with `/hooks`. The hooks inject orchestration context and surface supported diagnostics and policy warnings. Todo and spawn enforcement remain advisory, and write-capable waves must use isolated Git worktrees.

## The eight modes

| Mode | Command | What it does |
| --- | --- | --- |
| Plan | `/muster:plan <outcome \| backlog text>` | Approve-first entry point. Detects whether the invocation is one outcome or a backlog and confirms via AskUserQuestion whenever the signals are anything but a clear single item -- scope is never inferred silently -- then announces the artifact it's about to produce. For a single outcome: assembles the crew and shows the glass-box Crew Manifest for approval (tasks may carry `owns`/`frozen`/`forbiddenActions` fences and the manifest an overall `mergeDisposition`); Approve & run chains into `/muster:go` in-session, Adjust loops the router, Cancel stops. A confirmed backlog scope delegates to `/muster:plan-backlog` for the batch form. |
| Go | `/muster:go <outcome \| backlog text>` | Hands-off entry point: the same scope detection and confirm as Plan, then -- for a single outcome -- plans and runs end to end: branch, route, run waves, commit per wave, present the merge. Stops only for the scope confirmation, the merge decision, or an escalation. A confirmed backlog scope delegates to `/muster:go-backlog`. |
| Plan-backlog | `/muster:plan-backlog <backlog ref \| raw intent>` | The declared-scope batch planner: routes every item in a backlog up front and renders ONE batch plan (per-item crew summaries, run order, cross-item conflict flags), stopping for approval before anything runs. Given a raw intent instead of an existing backlog ref, it decomposes the intent into backlog items behind a capture-style approval gate first. Approve & clear chains into `/muster:go-backlog`. |
| Go-backlog | `/muster:go-backlog <backlog ref>` | The batch clearer: sequentially runs the full Go lifecycle over every item in a backlog, ticking each off as it completes, with one attended stop at the end for the batch report -- "cleared N, escalated M." An escalated item never aborts the batch. |
| Diagnose | `/muster:diagnose <symptom>` | Failure-first bug fix: reproduce, find root cause, fix, add a regression test, verify. No symptom-patching. |
| Audit | `/muster:audit [path]` | Breadth-first whole-codebase review and fix across six dimensions (seven when the project builds prompts or agents), then fixes everything with tests and verifies. |
| Runner | `/muster:runner [source]` | Unattended one-cycle work-picker for a Claude Code Routine or cron: resumes an answered blocked item or claims exactly one available item, drives it through the full Go lifecycle force-coerced to a `pr` disposition, leaves a receipt, and stops. The schedule provides the loop, not the verb. |
| Capture | `/muster:capture [hint]` | Conversation-to-backlog generator: mines the session's discussion (findings, decisions, review residuals, an explicit directive) into backlog items via the same extract/validate/dedupe/write machinery, gated by your approval before anything is written. Writes only `.muster/backlog.md` -- it never assembles a crew or runs work itself. |

`/muster:run`, `/muster:autopilot`, and `/muster:sprint` still work: each prints a one-line heads-up, then runs its replacement (`plan`, `go`, and `go-backlog`, respectively) unchanged. They are kept for backward compatibility, not deprecated on any schedule.

Plan and Go accept a GitHub issue reference (a bare number, `#123`, or an issues URL) as the outcome; both also accept the same backlog refs as Plan-backlog and Go-backlog (a backlog `.md` path, `issues:<label>`, or `linear:<key>`) and confirm the scope before planning a whole batch. A thin outcome gets refined first: `muster assess` does a deterministic gap-check, and if the outcome is vague, an interview skill asks one question at a time behind an approval gate before any crew is assembled. An outcome that decomposes into independent parts can instead be written to a backlog (`.muster/backlog.md`) for `/muster:go-backlog` to clear as a batch, or for `/muster:plan-backlog` to batch-plan first; `/muster:audit backlog [path]` fills the same backlog from audit's findings, sweeping read-only instead of fixing them inline; `/muster:capture [hint]` fills it a third way, mining a conversation's findings and decisions instead of an audit sweep or an interview decomposition. A backlog item annotated with `{id}`/`{deps}` switches `/muster:go-backlog` into wave mode: `pr`/`keep` items in a wave dispatch as parallel worktree-isolated runners capped by `MUSTER_SPRINT_PARALLEL`, while `merge-local`/`merge-push` items serialize at the wave barrier. Go-backlog and Runner share a **coordination** skill (claim/receipt/ledger discipline) so a scheduled Runner and an attended Go-backlog clear can safely work the same backlog or `issues:<label>` at once.

## How it works

The novel core is a capability and domain router. Muster names a fixed vocabulary of roles (the kinds of work a crew might need), and each role resolves through a ladder, best available first:

1. An installed external provider (a plugin, agent, or MCP server you already have)
2. A Muster built-in agent
3. A Muster built-in skill
4. Inline (the model does it directly)

`muster capabilities` walks this ladder for every role and reports the winner, the full fallback chain, installable recommendations, and the chosen model. Because the chain always ends at inline, every role resolves to something, so Muster works on bare Claude Code and improves as you add tools.

The role set is fixed but the provider set is not. When an outcome does not fit a named role, description-search bridges the gap: `muster match "<task>"` ranks every catalog provider by deterministic token overlap (no model call), so "audit this code for security vulnerabilities" surfaces the security specialist even though it never names a role.

Each role also carries a model picked to fit the work: mechanical roles run on Haiku, the default is Sonnet, and heavy judgment runs on Fable (degrades to Opus when unavailable on the plan). Muster composes the tools you already have and falls back to its own. For the full design, see the [architecture reference](https://adnova-group.github.io/muster/reference/architecture) (or [docs/architecture.md](docs/architecture.md) in-repo).

## Always-on guidance

Muster ships three plugin-native hooks. Enforcement follows the run's EXTERNAL effects, not the orchestrator's own in-repo edits: the only hard deny left anywhere in the stack is the action-class fence, scoped to a live run that declared a forbidden action. Everything else is a single warn-only "border invitation" that sells the value of a crew run rather than commanding, and review gates remain muster's actual quality enforcement.

- **`SessionStart`**: injects a one-line pointer (muster available; `/muster:plan` for orchestration-scale work) at the start of every session, and clears stale `.muster/run-active`/`wave-active` markers and per-session drift state so a new session never inherits a crashed run's state.
- **`UserPromptSubmit`**: the ONLY prompt-time nudge is the isDirective-triggered border invitation -- a directive-shaped prompt (an imperative verb like fix/build/implement, optionally after a polite lead-in; declaratives like "Update:"/"Fix for" and questions are excluded) landing with no muster run active sells the value of a crew run (parallel dispatch, adversarial review, a receipts trail) once per crossing, then stays silent until re-armed by a muster run starting, `SessionStart`, or 60 minutes of inactivity.
- **`PreToolUse`**: the action-class fence (the one hard deny) plus the tool-call half of the same border invitation. While a muster run is active AND `.muster/forbidden-actions` lists a class, a tool call classified into that class (send/sign/submit/publish/purchase/delete-remote) is denied, honoring `MUSTER_ACTION_GUARD` (`off`/`warn`/deny-by-default). Independently, a cumulative counter of distinct inline-edited files (across turns, with no muster run active) crossing `MUSTER_INLINE_SCALE` (default 3) warns once per crossing with the same value-toned copy -- never denies. Writes into `.muster/` and `.claude/` (in-cwd repo) are always exempt.

All three hooks live inside the plugin, so they activate when muster is enabled and go away when muster is disabled. They do not write to your `~/.claude/CLAUDE.md` or `settings.json` and create no global files. Each hook is fail-safe: any error falls back to an empty result and never blocks a session from starting.

## Pipelines

A pipeline is a phased, gated recipe for producing one kind of artifact. Each declares a domain, an ordered list of phases, and a gate. Gating uses a floor principle: the weakest dimension must clear the floor and the total must clear a pass threshold, so a strong average cannot rescue one weak dimension.

The set spans software and knowledge work. A few examples: PRD, business-case, launch-plan, executive-summary, OKRs, AI implementation spec, competitive-battlecard, blog-post, case-study, runbook, video-content, and book (fiction and non-fiction). Roadmap prioritization is one to call out: goals go in, and a RICE-ranked now/next/later roadmap comes out, with the model estimating the factors and the CLI doing the arithmetic. Human-facing pipelines end with a humanize phase that strips em-dashes, AI-tell words, and robotic cadence. Content pipelines that name an audience or a voice resolve a named profile from `docs/profiles/AUDIENCES.md`/`VOICE.md` (creating or extending it on first use) and calibrate depth/jargon/altitude and register/rhythm to it; a `docs/profiles/BRAND.md` anchors image-prompt and publish-phase visuals to a shared palette.

## Prompt evaluation

Muster can lint, eval, and optimize prompts, including the prompts an application generates at runtime to build agents and agentic workflows, and prompts found in a codebase Muster is working in. The deterministic core runs offline; a built-in skill (`muster-prompt-smith`, the `prompt-quality` role) supplies the model calls for empirical eval.

- **Lint** (`muster prompt lint <file|->`) is a no-LLM structural check that enforces Anthropic's best practices (role, XML tags, multishot examples, explicit output format, positive framing) and the agent/guardrail rules (imperative tool framing, stop conditions, "I don't know" allowance, citations, input separation). Every finding cites the doc rule it comes from and suggests a fix; the rubric is gated by the same floor principle as pipelines. Pass `--agent --tools` for runtime agent prompts.
- **Eval** (`muster prompt eval <suite.json>`) grades outputs against a test dataset with code graders (`json`/`regex`/`python`) plus an LLM-judge, and reports accuracy.
- **Optimize** (`muster prompt variations` then `muster prompt optimize`) generates technique-driven variations, re-scores them, and keeps the winner via the tournament floor, flagging a regression when nothing beats the baseline.
- **Scan** (`muster prompt scan <dir>`) walks a repo for prompts (markdown skill/agent/command docs, `.prompt` files, code assignments) and lints each; it powers the conditional `prompt-quality` audit dimension.

The linter is genre-aware (`--system` relaxes task-only rules for instruction prompts), ignores code fences across languages, and lets a prompt opt out of a rule inline (`<!-- prompt-lint-disable RULE: reason -->`). A prompt with zero findings scores a perfect 15/15.

```sh
# lint a runtime agent prompt piped straight from your app
your-app --print-agent-prompt | npx @adnova-group/muster prompt lint - --agent --tools
```

See the [commands reference](https://adnova-group.github.io/muster/reference/commands) for the full surface.

## Configuration

Muster's runtime behavior can be tuned with environment variables:

| Variable | Default | Semantics |
| --- | --- | --- |
| `MUSTER_INLINE_SCALE` | `3` | The border-invitation threshold: the Nth distinct file edited inline across turns, with no muster run active, crosses the border and warns once per crossing (never denies). |
| `MUSTER_MAX_TIER` | _(unset)_ | Caps the model tier policy (e.g. `opus` disables Fable, `sonnet` for budget mode); unset = no cap. Note: static agent frontmatter pins (e.g. muster-strategist) are not affected on direct invocation; in muster runs the dispatch override honors the cap. |
| `MUSTER_ENABLE_FABLE` | _(unset)_ | Opts back into the Fable tier for peak-judgment roles (the tournament judge, architecture-review, improve, advisor). Unset (or `0`/`false`) degrades Fable to Opus deterministically, since the tier can be disabled platform-wide; `1`/`true` re-enables it once the tier is available. |
| `MUSTER_ACTION_GUARD` | `deny` | Action-class fence on `PreToolUse` while `.muster/forbidden-actions` is present: `deny` blocks a matching send/sign/submit/publish/purchase/delete-remote tool call, `warn` allows with a reminder, `off` disables the fence. This is the only hard-deny surface left in muster's enforcement stack. |
| `MUSTER_ADVISOR_MAX_CONSULTS` | `3` | Maximum advisor consults per run. Bounds the cost of workers escalating to the advisor role. Set to 0 to disable advisor consults. |
| `MUSTER_FUSE_TOPK` | `3` | Maximum number of tournament candidates passed to the fusion synthesizer. Must be >= 1. |
| `MUSTER_FUSE_MIN_DISAGREEMENT` | `1` | Minimum disagreement score required to activate fusion synthesis. Below this threshold `muster fuse` falls back to the single best candidate. Set to 0 to always fuse when >= 2 candidates pass. |
| `MUSTER_SPRINT_PARALLEL` | `3` | Max concurrent item-runner subagents per wave in `/muster:go-backlog` wave mode; hard ceiling `8` (higher values clamp, `0` is invalid; concurrency is never unbounded). Read by go-backlog's orchestration protocol, not by library code. |

## Built on

Muster's design was inspired by atomic-claude, superpowers, and gsd-core. It vendors a curated set of MIT-licensed skills and agents, with every source and item recorded for attribution:

| Source | License | Provides |
| --- | --- | --- |
| obra/superpowers | MIT | Brainstorming, planning, TDD, code-review, debugging, verification skills |
| wshobson/agents | MIT | Software and knowledge-work agents across many specialties |
| open-gsd/gsd-core | MIT | Plan, execute, and verify workflow phases |

For Codex, Muster prefers enabled authoritative upstream implementations when they exist: the official Superpowers plugin, WSHObson's per-plugin Codex skills, and GSD's installer-generated Codex skills. Bundled `sp-*`, `wsh-*`, and `muster-gsd-*` skills remain deterministic fallbacks and never install those providers implicitly. The pinned compatibility survey, including Atomic Codex, Book Genesis, humanizer sources, and Promptfoo, is recorded in [`codex/upstreams.json`](codex/upstreams.json).

Alongside the vendored material, Muster ships its own clean-room specialists, authored fresh from the role concept. Full provenance lives in [NOTICE](NOTICE).

## Contributing and license

Contributions are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) to get started.

Muster is licensed under Apache-2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
