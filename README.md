# Muster

Glass-box, multi-domain agentic orchestrator for Claude Code, Codex, and Cowork. Give it an outcome; it assembles the right crew and shows its reasoning before it acts.

[![License: Apache-2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](LICENSE)
[![Node >= 20](https://img.shields.io/badge/node-%3E%3D20-brightgreen.svg)](package.json)
[![npm](https://img.shields.io/npm/v/@adnova-group/muster.svg)](https://www.npmjs.com/package/@adnova-group/muster)
[![Docs](https://img.shields.io/badge/docs-adnova--group.github.io%2Fmuster-6d5ce7.svg)](https://adnova-group.github.io/muster/)

**Documentation: [adnova-group.github.io/muster](https://adnova-group.github.io/muster/)**

## What it is

Muster turns an outcome into finished work. It detects your project, discovers the capabilities you already have installed, picks the best tool for each piece of the job, and runs a crew of specialists toward your success criteria. Every decision is inspectable: which role resolved to which provider, on which model, and why.

It runs on Claude Code, Codex, or Cowork with no separate model API, and it gets better as you install more tools. Runtime support differs: Claude Code (including Desktop's Code tab) and Codex expose the full native command surface; Desktop's Chat and Cowork load the plugin from your claude.ai account, with an MCP-only fallback that has a seven-mode protocol subset. ChatGPT Work is a separate, conditional local/private MCP lane: configuration alone is not proof that the active Work host invoked Muster. The work is not limited to code. Product, business, content, and operations are first-class.

## Quickstart

```sh
npx -y @adnova-group/muster@0.7.1 install
```

Pin the reviewed release in automation and copy the current version from `package.json` when updating. `npx` uses npm's execution path and may download the named package from the configured registry before running it. Review the package provenance and release notes before changing the pin.

`install` mutates nothing in your `~/.claude`. It only prints the steps it cannot do for you, because registering a plugin is a Claude Code action:

```sh
/plugin marketplace add Adnova-Group/muster  # register the marketplace
/plugin install muster@muster                # install the plugin
```

Muster's glass-box output style ships inside the plugin but is not forced: pick "Muster" under `/config` → Output style if you want it. Plugin install is a Claude Code action, so the running session picks Muster up only after you (re)install it through `/plugin`. Restart or `/clear`, then run your first outcome:

```
/muster:plan Add rate limiting to the public API with tests
```

### Claude Desktop (Code tab, Chat, Cowork)

Install the same plugin from Desktop: **Customize > Plugins > Add > Add marketplace**, enter `Adnova-Group/muster`, then install **muster**. The install belongs to your claude.ai account and syncs to Claude Code. The Code tab runs the full plugin. Cowork loads its skills, commands, agents and hooks; Chat loads its skills and commands. Desktop WSL sessions load no plugins, so use a local or SSH Code-tab session, or the CLI inside WSL. Without the plugin, the local MCP server in `cowork/` (the Cowork adapter over `mcp/server.mjs`) is the fallback; it does not run in Cowork's cloud sessions. `muster doctor --desktop` reports what Desktop sees, read-only. Details: [`cowork/README.md`](cowork/README.md).

### Codex CLI and Desktop

Build or install the package, then install Muster's managed Codex profiles and plugin:

```sh
npx -y @adnova-group/muster@0.7.1 install codex --scope project
```

`--scope project` writes Muster-owned profiles and declarations under the project's `.codex/` layer, installs the hook runtime under `.codex/muster/`, and merges owned hook groups into `.codex/hooks.json`. The install also records ownership receipts and registers the plugin. Existing unrelated profiles, configuration, and hook groups are preserved.

Codex CLI, Desktop, and the IDE share `$CODEX_HOME/config.toml`. Even for `--scope project`, the installer ensures the canonical `agents.max_concurrent_threads_per_session` setting exists, defaulting it to `12` only when the user has not configured a canonical or legacy ceiling. Existing positive user ceilings are preserved. A receipt lets the last managed-scope uninstall restore only values Muster changed, including cleanup of legacy `max_threads`/`max_depth` values only when an older Muster receipt proves ownership. The user scope is canonical for hooks: a healthy user install makes a project install skip its own hook merge, avoiding duplicate events. Use `--dry-run` to inspect the complete write, merge, registration, and cleanup plan first:

```sh
npx -y @adnova-group/muster@0.7.1 install codex --scope project --dry-run
```

On Windows, install from the same host that runs Codex. Native Windows and WSL have different home directories, Node installations, plugin caches, and normally different `CODEX_HOME` values; an install under `~/.codex` in WSL does not configure native Codex Desktop under `%USERPROFILE%\.codex`. If you switch hosts, rerun the scoped install and `muster doctor --codex` in the new host. Do not point native Desktop at a WSL-only path or assume that a `/mnt/c/...` checkout makes the two user scopes identical.

Codex requires a new trust review when installed hook definitions change. Inspect exact definitions with `/hooks`; update-sensitive trust means a previously trusted hash does not authorize changed code. To remove only Muster-owned project state, preview and then run:

```sh
npx -y @adnova-group/muster@0.7.1 uninstall codex --scope project --dry-run
npx -y @adnova-group/muster@0.7.1 uninstall codex --scope project
```

Uninstall preserves unrelated config and Codex's project trust records, removes only receipted Muster declarations and hook groups, prunes Muster-owned hook trust entries, and unregisters the plugin only after the last managed scope is gone. With Codex on `PATH`, install registers `Adnova-Group/muster` and adds `muster@muster` idempotently. Without Codex it installs profiles and hooks, then prints the exact registration follow-up.

Use `$muster` or a mode skill such as `$muster-plan`, `$muster-go`, `$muster-audit`, or `$muster-capture`. Codex users can inspect live Codex capability state with `muster capabilities --codex` and run `muster doctor --codex`.

From an interactive terminal, `muster codex-plan "<outcome>"` starts a new local App Server session, discovers the advertised Plan preset, invokes the installed `muster-plan` skill with `turn/start.collaborationMode`, and reports the effective mode from `thread/settings/updated`. It relays Muster's structured approval question to that terminal, but never overrides the user's approval policy, reviewer, permissions, or sandbox. It cannot switch an already-running desktop/IDE chat. Non-interactive callers and unavailable or unconfirmed App Server control exit nonzero with the safe in-session path: `/plan $muster-plan <outcome>`.

The Codex plugin bundles the deterministic CLI, all pipelines, 30 MCP tools, 27 custom-agent profiles, and 119 skills: 8 public mode/router skills plus 111 internal skills. The Codex lane is frozen: it builds unchanged from the pre-revival lifecycle prose kept in `codex/frozen/`, and receives no new features. The npm installer adds Codex-native lifecycle hooks through the supported project or user `hooks.json` layer, and the Codex plugin itself is deliberately hooks-free so the two never double-fire. These hooks fail open and are diagnostic: they cannot reliably block every unified-shell or subagent action. Todo and spawn enforcement remain advisory, and write-capable waves must use isolated Git worktrees.

### ChatGPT Work (private/local plugin lane)

ChatGPT Work is a private/local, proof-gated plugin lane: it does not inherit Codex Desktop's `AGENTS.md`, skills, hooks, MCP, or `config.toml`. Muster's MCP surface has one neutral core in `mcp/server.mjs` with an explicit Work host adapter; `cowork/chatgpt-work-server.mjs` remains a compatibility shim, and the public Work runtime command stays `runtime/chatgpt-work-server.mjs`. Installing the connection, running Secure MCP Tunnel, choosing a profile (`pro-safe` or `full`), and the native-proof contract are covered in the [ChatGPT Work guide](https://adnova-group.github.io/muster/guides/chatgpt-work).

## The seven modes

| Mode | Command | What it does |
| --- | --- | --- |
| Plan | `/muster:plan <outcome \| backlog ref>` | Approve-first: one preflight call, questions only when the outcome is unclear, then a checked PLAN.md and a stop for Approve & build / Revise / Cancel. |
| Go | `/muster:go <outcome \| backlog ref>` | Hands-off: plans, builds each wave in isolated worktrees, reviews and verifies, merges the waves through `muster merge-wave`, then stops for the merge decision. |
| Diagnose | `/muster:diagnose <symptom>` | Failure-first bug fix: reproduce, find root cause, fix, add a regression test, verify. No symptom-patching. |
| Audit | `/muster:audit [path]` | Breadth-first whole-codebase review and fix across six dimensions (seven when the project builds prompts or agents), then fixes everything with tests and verifies. |
| Design | `/muster:design <action>` | Resolve canonical `DESIGN.md` context and digest receipts, initialize it with an attended hold, inspect bounded design evidence/provider state, or run one of 24 pinned design workflows. |
| Capture | `/muster:capture [hint]` | Conversation-to-backlog generator: mines the session's discussion (findings, decisions, review residuals, an explicit directive) into backlog items, gated by your approval before anything is written. Writes only `.muster/backlog.md` -- it never runs work itself. |
| Init | `/muster:init [dir]` | Prepare a repository profile and receipt, hand native instruction work to the active runtime, and finalize only after positive evidence or an acknowledged unavailable handoff. |

Plan and Go run on Claude Code's native Workflow tool. The main thread makes one `muster preflight` call (scope, clarity, per-seat models, candidate specialists), asks up to four questions only when the outcome is unclear and records the answers in the run's `CONTEXT.md`, then calls `Workflow({name:"muster:plan"})`. Plan stops there for approval. Go continues: `muster build-args` writes the build arguments from PLAN.md and the main thread commits them, `Workflow({name:"muster:build"})` runs parallel executors in isolated worktrees with a capped review loop and one verifier, and `muster merge-wave` re-checks every claimed commit before merging the waves in plan order. Go then reports the verification result and asks how to merge. That is about five main-session turns before the first executor, against about 14 + 2N before. Workflow consent is asked per run in manual and accept-edits modes; add the allow rules `Workflow(muster:plan)`, `Workflow(muster:build)` and `Workflow(muster:backlog)` to skip it. Each run's record lives in `.muster/runs/<runId>/` on the work branch, and `muster next --run <runId>` re-derives its position after a compaction or an interruption.

The mechanics behind this table are documented in the [mode reference](https://adnova-group.github.io/muster/reference/modes). Design mode's context resolution, attended initialization, bounded detector, provider contract, and complete workflow list are documented in the [Design reference](https://github.com/Adnova-Group/muster/blob/main/docs/design.md).

Plan and Go accept a GitHub issue reference (a bare number, `#123`, or an issues URL) as the outcome, or a backlog (`.muster/backlog.md` or another backlog `.md` path). For a backlog, each item gets its own preflight and plan, `Workflow({name:"muster:backlog"})` builds the items sequentially, and `merge-wave` integrates them in backlog order before one merge decision. Three generators fill the backlog so you never hand-write one: the interview's decomposition check, `/muster:audit backlog [path]` (a read-only sweep), and `/muster:capture [hint]` (the conversation's findings and decisions).

Unattended runs (a Claude Code Routine, `claude -p`, or a cloud scheduled task) use `/muster:go` with one outcome or one backlog item: no questions, gaps recorded as assumptions, and the run ends at a pull request instead of merging into your base branch.

## Initialize a repository

Use Init before the greenfield workflow or when adopting Muster in a cloned repository:

```sh
/muster:init [dir]
# or
npx -y @adnova-group/muster init [dir]
```

Init performs bounded, read-only project learning and writes only the owned pair `.muster/project-profile.json` and `.muster/init-receipt.json`. Both are schema-versioned canonical JSON files. The profile records classification, repository facts, and a SHA-256 state fingerprint. It is provider/model-neutral: it never stores provider IDs, concrete model names, resolved roles, capability inventories, or timestamps. Same-state reruns return the same receipt without rewriting bytes. A pending bare rerun only observes expected native artifacts and does not change the baseline or state.

For an empty greenfield directory, preparation may safely initialize `.git` before creating the owned pair. This is the one trust-boundary mutation: Git uses a fresh empty template and controlled built-ins, with no repository hooks or discovered commands. Native instruction generation stays with the active runtime. Claude Code and Codex handoffs use one canonical instruction pair: `AGENTS.md` is authoritative, and `CLAUDE.md` contains exactly:

```md
# Claude Code

@AGENTS.md
```

If conflicting instruction files existed at the preparation baseline, Init does not overwrite or merge them; it leaves a HUMAN-HOLD for the user to reconcile. Init records a `not-requested` state, then the runtime-specific workflow moves it to `handoff` or a proven callable adapter moves it to `attempted`. A native `/init` request, suggestion, command invocation, refusal to overwrite, or existing artifact alone is not completion. Completion requires artifact-delta evidence, an explicit confirmation of a pre-existing artifact, or a bounded call-result receipt. Do not pass `--evidence-file` with `artifact-delta`; that flag is only for `preexisting-confirmed` and `call-result`. If the handoff is unavailable, including Copilot or an unknown runtime without a proven adapter, Init leaves a HUMAN-HOLD; run `muster init acknowledge [dir] --reason unavailable` to permit finalization while the native state remains `handoff`. Never invent a native command for an unavailable runtime.

Greenfield finalization may create only a missing `.gitignore`, `README.md`, and `.gitkeep` files under the `docs/design` and `docs/plan` directories. Brownfield finalization creates none of those seeds and preserves the clone's README, docs, instruction files, hooks, settings, and other user content. Init never executes repository setup instructions, package scripts, hooks, dependency installers, or discovered commands. The explicit legacy `muster setup [dir]` command still scaffolds its older seed set; new greenfield guidance uses Init and keeps the design-before-plan-before-implementation gate.

## How it works

The novel core is a capability and domain router. Muster names a fixed vocabulary of roles (the kinds of work a crew might need), and each role resolves through a ladder, best available first:

1. An installed external provider (a plugin, agent, or MCP server you already have)
2. A Muster built-in agent
3. A Muster built-in skill
4. Inline (the model does it directly)

`muster capabilities` walks this ladder for every role and reports the winner, the full fallback chain, installable recommendations, and the chosen model. Because the chain always ends at inline, every role resolves to something, so Muster works on bare Claude Code and improves as you add tools.

The role set is fixed but the provider set is not. When an outcome does not fit a named role, description-search bridges the gap: `muster match "<task>"` ranks every catalog provider by deterministic token overlap (no model call), so "audit this code for security vulnerabilities" surfaces the security specialist even though it never names a role.

Each role also carries a conceptual tier picked to fit the work. The ladder, from least to most capable, is `scout`, `core`, `prime`, and `apex`. Mechanical roles use scout, routine work defaults to core, and peak-judgment roles use apex with a deterministic fallback to prime. Runtime adapters map those tiers to concrete models. Muster composes the tools you already have and falls back to its own. For the full design, see the [architecture reference](https://adnova-group.github.io/muster/reference/architecture) (or the [architecture source](https://github.com/Adnova-Group/muster/blob/main/docs/architecture.md)).

## Claude Code-only lifecycle hooks

This section describes the plugin-native Claude Code hooks. Codex uses the diagnostic hook layer described above. Other harnesses receive only the lifecycle primitives they actively subscribe to; Muster does not infer an active harness subscription from files on disk.

Muster costs nothing in a Claude Code session that never invokes it: no hook fires on session start or on a prompt, nothing nudges you toward a verb, and the output style is not forced. One plugin-native hook remains, and it acts only during a muster run: `/muster:go` writes `.muster/run-active` and `.muster/forbidden-actions` before it builds and removes both at the merge decision.

- **`PreToolUse`** (exec-form `node` hook, fail-open, matcher `^(Bash|PowerShell|mcp__(?!ccd_turn__(?:update_plan|wrap_up)$).*)$`, which skips exactly the two chatty Claude Desktop turn tools `mcp__ccd_turn__update_plan` and `mcp__ccd_turn__wrap_up`): the action-class fence, the only hard deny on a tool call. While a muster run is active AND `.muster/forbidden-actions` lists a class, a shell command or MCP tool call classified into that class (send/sign/submit/publish/purchase/delete-remote) is denied, honoring `MUSTER_ACTION_GUARD` (`off`/`warn`/deny-by-default). The fence classifies every payload before anything else, so a recognized forbidden external effect stays denied when the call carries `agent_id`. It fails open when run markers are absent or unreadable, classification is ambiguous, or no forbidden class matches. Nothing clears a stale marker automatically: if an interrupted run leaves `.muster/run-active` behind, the next run overwrites it, or delete it by hand.

The hook lives inside the plugin, so it activates when muster is enabled and goes away when muster is disabled. It does not write to your `~/.claude/CLAUDE.md` or `settings.json` and creates no global files. It is fail-safe: any error falls back to an empty result and never blocks a session.

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
your-app --print-agent-prompt | npx -y @adnova-group/muster prompt lint - --agent --tools
```

See the [commands reference](https://adnova-group.github.io/muster/reference/commands) for the full surface.

## Configuration

Muster's runtime behavior can be tuned with environment variables:

| Variable | Default | Semantics |
| --- | --- | --- |
| `MUSTER_MAX_TIER` | _(unset)_ | Caps the conceptual model tier policy. For example, `MUSTER_MAX_TIER=prime` excludes apex and `MUSTER_MAX_TIER=core` enables budget mode; unset means no cap. Static agent frontmatter pins are not affected on direct invocation; in Muster runs the dispatch override honors the cap. |
| `MUSTER_ENABLE_APEX` | _(unset)_ | Enables apex for peak-judgment roles such as the tournament judge, architecture review, improve, and advisor. Unset (or `0`/`false`) degrades apex to prime deterministically; `1`/`true` enables it when the harness can serve it. |
| `MUSTER_ACTION_GUARD` | `deny` | Action-class fence on `PreToolUse` while `.muster/forbidden-actions` is present: `deny` blocks a matching send/sign/submit/publish/purchase/delete-remote tool call, `warn` allows with a reminder, `off` disables the fence. This is the only hard-deny surface left in muster's enforcement stack. |
| `MUSTER_ADVISOR_MAX_CONSULTS` | `3` | Maximum advisor consults per run. Bounds the cost of workers escalating to the advisor role. Set to 0 to disable advisor consults. |
| `MUSTER_FUSE_TOPK` | `3` | Maximum number of tournament candidates passed to the fusion synthesizer. Must be >= 1. |
| `MUSTER_FUSE_MIN_DISAGREEMENT` | `1` | Minimum disagreement score required to activate fusion synthesis. Below this threshold `muster fuse` falls back to the single best candidate. Set to 0 to always fuse when >= 2 candidates pass. |
| `MUSTER_SPRINT_PARALLEL` | `5` | Max concurrent item builds per wave in a `muster sprint-waves` schedule (the Cowork sprint protocol and the frozen Codex lane); hard ceiling `10` (higher values clamp, `0` is invalid; concurrency is never unbounded). |

This table covers the most common controls. See the [full configuration reference](https://adnova-group.github.io/muster/reference/configuration) for model, concurrency, and advanced runtime settings.

<!-- legacy-tier-compat:start -->
Compatibility only: legacy input aliases `haiku`, `sonnet`, `opus`, and `fable` normalize to `scout`, `core`, `prime`, and `apex`; they are not a second conceptual ladder. `MUSTER_ENABLE_FABLE` remains an alias for `MUSTER_ENABLE_APEX`.
<!-- legacy-tier-compat:end -->

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

Contributions are welcome. See the [contribution guide](https://github.com/Adnova-Group/muster/blob/main/CONTRIBUTING.md) to get started.

Muster is licensed under Apache-2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
