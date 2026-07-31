# Muster

Glass-box, multi-domain agentic orchestrator for Claude Code, Codex, Kimi, and Cowork. Give it an outcome; it assembles the right crew and shows its reasoning before it acts.

[![License: Apache-2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](LICENSE)
[![Node >= 20](https://img.shields.io/badge/node-%3E%3D20-brightgreen.svg)](package.json)
[![npm](https://img.shields.io/npm/v/@adnova-group/muster.svg)](https://www.npmjs.com/package/@adnova-group/muster)
[![Docs](https://img.shields.io/badge/docs-adnova--group.github.io%2Fmuster-6d5ce7.svg)](https://adnova-group.github.io/muster/)

**Documentation: [adnova-group.github.io/muster](https://adnova-group.github.io/muster/)**

## What it is

Muster turns an outcome into finished work. It detects your project, discovers the capabilities you already have installed, picks the best tool for each piece of the job, and runs a crew of specialists toward your success criteria. Every decision is inspectable: which role resolved to which provider, on which model, and why.

It runs on Claude Code, Codex, Kimi, or Cowork with no separate model API, and it gets better as you install more tools. Runtime support differs: Claude Code and Codex expose the full native command surface, Kimi uses namespaced native skills, and Cowork's verified MCP lane has a seven-mode protocol subset. ChatGPT Work is a separate, conditional local/private MCP lane: configuration alone is not proof that the active Work host invoked Muster. The work is not limited to code. Product, business, content, and operations are first-class.

## Quickstart

```sh
npx -y @adnova-group/muster@0.5.0 install
```

Pin the reviewed release in automation and copy the current version from `package.json` when updating. `npx` uses npm's execution path and may download the named package from the configured registry before running it. Review the package provenance and release notes before changing the pin.

`install` mutates nothing in your `~/.claude`. It only prints the steps it cannot do for you, because registering a plugin is a Claude Code action:

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
npx -y @adnova-group/muster@0.5.0 install codex --scope project
```

`--scope project` writes Muster-owned profiles and declarations under the project's `.codex/` layer, installs the hook runtime under `.codex/muster/`, and merges owned hook groups into `.codex/hooks.json`. The install also records ownership receipts and registers the plugin. Existing unrelated profiles, configuration, and hook groups are preserved.

Codex CLI, Desktop, and the IDE share `$CODEX_HOME/config.toml`. Even for `--scope project`, the installer ensures the canonical `agents.max_concurrent_threads_per_session` setting exists, defaulting it to `12` only when the user has not configured a canonical or legacy ceiling. Existing positive user ceilings are preserved. A receipt lets the last managed-scope uninstall restore only values Muster changed, including cleanup of legacy `max_threads`/`max_depth` values only when an older Muster receipt proves ownership. The user scope is canonical for hooks: a healthy user install makes a project install skip its own hook merge, avoiding duplicate events. Use `--dry-run` to inspect the complete write, merge, registration, and cleanup plan first:

```sh
npx -y @adnova-group/muster@0.5.0 install codex --scope project --dry-run
```

On Windows, install from the same host that runs Codex. Native Windows and WSL have different home directories, Node installations, plugin caches, and normally different `CODEX_HOME` values; an install under `~/.codex` in WSL does not configure native Codex Desktop under `%USERPROFILE%\.codex`. If you switch hosts, rerun the scoped install and `muster doctor --codex` in the new host. Do not point native Desktop at a WSL-only path or assume that a `/mnt/c/...` checkout makes the two user scopes identical.

Codex requires a new trust review when installed hook definitions change. Inspect exact definitions with `/hooks`; update-sensitive trust means a previously trusted hash does not authorize changed code. To remove only Muster-owned project state, preview and then run:

```sh
npx -y @adnova-group/muster@0.5.0 uninstall codex --scope project --dry-run
npx -y @adnova-group/muster@0.5.0 uninstall codex --scope project
```

Uninstall preserves unrelated config and Codex's project trust records, removes only receipted Muster declarations and hook groups, prunes Muster-owned hook trust entries, and unregisters the plugin only after the last managed scope is gone. With Codex on `PATH`, install registers `Adnova-Group/muster` and adds `muster@muster` idempotently. Without Codex it installs profiles and hooks, then prints the exact registration follow-up.

Use `$muster` or a mode skill such as `$muster-plan`, `$muster-go`, `$muster-audit`, or `$muster-capture`. The three legacy aliases (`run`, `autopilot`, `sprint`) remain skills. Codex users can inspect live Codex capability state with `muster capabilities --codex` and run `muster doctor --codex`.

From an interactive terminal, `muster codex-plan "<outcome>"` starts a new local App Server session, discovers the advertised Plan preset, invokes the installed `muster-plan` skill with `turn/start.collaborationMode`, and reports the effective mode from `thread/settings/updated`. It relays Muster's structured approval question to that terminal, but never overrides the user's approval policy, reviewer, permissions, or sandbox. It cannot switch an already-running desktop/IDE chat. Non-interactive callers and unavailable or unconfirmed App Server control exit nonzero with the safe in-session path: `/plan $muster-plan <outcome>`.

The Codex plugin bundles the deterministic CLI, all pipelines, 31 MCP tools, 27 custom-agent profiles, and 77 skills: 14 public mode/router/alias skills plus 63 internal skills (12 native orchestration skills and 51 capability skills). The npm installer adds Codex-native lifecycle hooks through the supported project or user `hooks.json` layer, and the Codex plugin itself is deliberately hooks-free so the two never double-fire. These hooks fail open and are diagnostic: they cannot reliably block every unified-shell or subagent action. Todo and spawn enforcement remain advisory, and write-capable waves must use isolated Git worktrees.

### Kimi

Kimi installs the same ten primary modes as namespaced `/muster-*` skills. In-session native subagents are the supported execution path. `kimi-process-dispatch` remains descriptor-only, and the attended `kimi-process-run` lane is report-only on every platform until Muster can bootstrap a trusted immutable, kernel-bound broker. Filesystem dispatch receipts and worktree paths are diagnostic only; they never authorize signaling a process.

### ChatGPT Work (private/local plugin lane)

Muster's MCP surface has one neutral implementation in `mcp/server.mjs` with explicit host adapters in `mcp/codex-server.mjs`, `mcp/chatgpt-work-server.mjs`, and `cowork/mcp-server.mjs`. The legacy `cowork/chatgpt-work-server.mjs` path remains a compatibility shim for existing Work configurations. Codex and Work bundles build their explicit adapters directly; they do not string-rewrite Cowork source. The public Work runtime command remains `node runtime/chatgpt-work-server.mjs`.

ChatGPT Work supports plugins on the web and in the ChatGPT desktop app (select ChatGPT → Work). Codex Desktop is a separate surface: Work does not inherit Codex `AGENTS.md`, skills, hooks, MCP, or `config.toml` configuration. Muster's Work lane is a private/local development path through the universal Plugins Directory format and a registered MCP connection; it is not a public plugin submission. Secure MCP Tunnel is explicitly a private transport and cannot make a tunnel-backed plugin eligible for public distribution. The local/repo Plugins Directory source is the documented desktop proof lane: restart or refresh ChatGPT Desktop, select the local/repo marketplace source, and install the plugin there. Do not generalize that local source to Work web; use Work web only when an independently supported source is available. A connection, tool scan, tunnel-health result, or assistant claim is not a native invocation receipt. Support for a particular Work build is demonstrated only when that host renders the completed Muster tool card and the nonce-bound server evidence passes the proof contract below.

Install the connection mapping into the project or user scope with the exact command below. The technical ID copied from ChatGPT may begin with `plugin_`; Muster strips only that initial prefix and persists the canonical, non-secret `asdk_app_...` ID. The dry run writes nothing:

```sh
muster install chatgpt-work --connection-id plugin_asdk_app_... --profile pro-safe --scope project --dry-run
muster install chatgpt-work --connection-id plugin_asdk_app_... --profile pro-safe --scope project
# user scope: --scope user
# full deterministic surface: --profile full --allow-full-actions
```

`--profile` is mandatory; `pro-safe` is the recommended Pro-compatible profile. The installer returns `pluginPath`: `<cwd>/.agents/plugins/muster-chatgpt-work` for project scope or `<home>/.agents/plugins/muster-chatgpt-work` for user scope. It atomically merges a distinct `muster-chatgpt-work` entry into the scope's `.agents/plugins/marketplace.json`, preserving the Codex `muster` entry. Its receipt is `.git/muster/chatgpt-work.json` for project scope or `<home>/.muster/chatgpt-work.json` for user scope. Inspect those returned/receipt paths rather than assuming a different plugin copy.

The generated Work plugin contains minimal `.mcp.json` wiring and this `.app.json` mapping; it does not inherit Codex configuration. The plugin manifest points `apps` at `./.app.json`:

```json
{"apps":{"muster":{"id":"asdk_app_<normalized-id>"}}}
```

In the generated plugin root, run the local STDIO server through OpenAI Secure MCP Tunnel (outbound-only; no inbound listener):

```sh
export CONTROL_PLANE_API_KEY="sk-..." # OpenAI Platform runtime key; keep it secret
tunnel-client init --sample sample_mcp_stdio_local --profile muster-chatgpt-work \
  --tunnel-id tunnel_... --mcp-command "node runtime/chatgpt-work-server.mjs"
tunnel-client doctor --profile muster-chatgpt-work --explain
tunnel-client run --profile muster-chatgpt-work
```

For the nonce-bound proof server, use an existing private probe directory and a new `server-attestation.json` path. Export the probe variables before `tunnel-client init` so they are inherited by the `--mcp-command` child. The generated runtime accepts only this explicit probe configuration (it strips unrelated environment credentials, allows exactly one exact call, and writes the attestation):

```sh
export MUSTER_CHATGPT_WORK_PROFILE=pro-safe
export MUSTER_CHATGPT_WORK_PROBE_NONCE=<32-lowercase-hex-nonce>
export MUSTER_CHATGPT_WORK_PROBE_ATTESTATION_PATH=/absolute/private/probe-dir/server-attestation.json
export MUSTER_CHATGPT_WORK_CONNECTION_ID=asdk_app_...
export MUSTER_CHATGPT_WORK_APP_JSON_PATH=/absolute/path/to/installed/.app.json
export MUSTER_CHATGPT_WORK_PLUGIN_VERSION=0.5.0
export MUSTER_CHATGPT_WORK_CONNECTION_LABEL="Muster ChatGPT Work"
tunnel-client init --sample sample_mcp_stdio_local --profile muster-chatgpt-work \
  --tunnel-id tunnel_... --mcp-command "node runtime/chatgpt-work-server.mjs"
tunnel-client run --profile muster-chatgpt-work
```

On POSIX, the probe directory must already exist, be owned by the current user, and have no group/world permissions (for example `0700`); the attestation file must be a new `0600` file. Windows native proof is always `HUMAN-HOLD`: there is no usable Windows attestation claim. On every platform, an attestation collision is `HUMAN-HOLD`, never an overwrite.

For `pro-safe`, set `MUSTER_CHATGPT_WORK_PROFILE=pro-safe`; exactly one tool (`muster_prioritize`) is exposed with title **Prioritize backlog items**, `readOnlyHint=true`, `destructiveHint=false`, and `openWorldHint=false`. Pro's custom MCP path is read/fetch; claim Pro support only after a successful native **Scan Tools** gate in Work. Full MCP (including write/modify actions) is a Business/Enterprise/Edu rollout, not a Pro entitlement. Muster's `full` profile is the existing 31-tool deterministic surface, not a write-action surface: it requires both `--profile full --allow-full-actions` at install and `MUSTER_CHATGPT_WORK_SERVER_ALLOW_FULL_ACTIONS=1` at server startup, plus the ChatGPT workspace's full-MCP entitlement. Treat those as a deliberate double opt-in.

The tunnel's `CONTROL_PLANE_API_KEY` is an OpenAI Platform runtime credential and is billed under Platform API usage; it is not supplied by, or interchangeable with, a ChatGPT Pro subscription. Associate the tunnel with the personal Platform organization for a personal test, or with both the Platform organization and target ChatGPT workspace for workspace use. A connection ID is an identifier, not a secret; never record the runtime key, tunnel ID, screenshots, or raw app contents in a receipt.

ChatGPT can cache a frozen tool snapshot. After changing tool titles, annotations, schemas, or profile metadata, use **Refresh** where the workspace UI offers it; otherwise recreate the developer connection/app and install a fresh local plugin copy, then start a new Work chat. The nonce-bound native proof in [`scripts/chatgpt-work-native-probe.mjs`](scripts/chatgpt-work-native-probe.mjs) requires the operator-observed completed Work `muster_prioritize` card *and* a separate server attestation with the exact nonce request/result, identity, `serverInstanceId`, and `invocationCount=1`; UI evidence alone is not cryptographic provenance. Windows native proof is always `HUMAN-HOLD` because the probe issues no usable Windows attestation claim. Stop the tunnel and verify before/during/after inventories before grading, and remove only provably probe-owned artifacts.

For the identity-bound native proof, supply the normalized connection and exact installed `.app.json` bytes so the run sheet and grader can recompute both identity hashes (the plugin version and connection label are non-secret metadata):

```sh
node scripts/chatgpt-work-native-probe.mjs \
  --connection-id asdk_app_... --app-json /path/to/installed/.app.json \
  --plugin-version 0.5.0 --connection-label "Muster ChatGPT Work"
node scripts/chatgpt-work-native-probe.mjs --grade receipt.json --nonce <nonce> \
  --server-attestation attestation.json --connection-id asdk_app_... \
  --app-json /path/to/installed/.app.json --plugin-version 0.5.0 \
  --connection-label "Muster ChatGPT Work" \
  --snapshot-out /private/retained/grade-snapshot.json \
  --owned-plugin-path /exact/owned/plugin-path \
  --owned-temp-path /exact/owned/probe-temp-path
```

Grading is two-phase. Phase 1 keeps the attestation and probe inventory present, writes a private retained grade snapshot outside the owned plugin and probe trees, and returns `evidence-graded`; do not delete the attestation before this command. Both owned directories must be placed beneath current-user-owned parent directories with no group/world write bits. After grading, stop the tunnel, remove the connection/marketplace/cache/UI entries, and leave the two exact snapshot-bound plugin and probe directories in place. There is no invented uninstall command: if ownership or a path collides, stop and record `HUMAN-HOLD`. Write the cleanup record with the returned `gradeDigest` and identical `ownedPaths`; phase 2 rechecks the parent boundary, atomically renames each identity-checked directory to a random direct-sibling quarantine path, rechecks the retained identity, deletes each quarantined directory, and verifies all paths are absent. Direct siblings avoid an intermediate symlink target and support different filesystems:

```sh
node scripts/chatgpt-work-native-probe.mjs --finalize-cleanup cleanup.json \
  --grade-snapshot /private/retained/grade-snapshot.json
```

## The ten modes

| Mode | Command | What it does |
| --- | --- | --- |
| Plan | `/muster:plan <outcome \| backlog text>` | Approve-first entry point. Detects whether the invocation is one outcome or a backlog and confirms via AskUserQuestion whenever the signals are anything but a clear single item -- scope is never inferred silently -- then announces the artifact it's about to produce. For a single outcome: assembles the crew and shows the glass-box Crew Manifest for approval (tasks may carry `owns`/`frozen`/`forbiddenActions` fences and the manifest an overall `mergeDisposition`); Approve & run chains into `/muster:go` in-session, Adjust loops the router, Cancel stops. A confirmed backlog scope delegates to `/muster:plan-backlog` for the batch form. |
| Go | `/muster:go <outcome \| backlog text>` | Hands-off entry point: the same scope detection and confirm as Plan, then -- for a single outcome -- plans and runs end to end: branch, route, run waves, commit per wave, present the merge. Stops only for the scope confirmation, the merge decision, or an escalation. A confirmed backlog scope delegates to `/muster:go-backlog`. |
| Plan-backlog | `/muster:plan-backlog <backlog ref \| raw intent>` | The declared-scope batch planner: routes every item in a backlog up front and renders ONE batch plan (per-item crew summaries, run order, cross-item conflict flags), stopping for approval before anything runs. Given a raw intent instead of an existing backlog ref, it decomposes the intent into backlog items behind a capture-style approval gate first. Approve & clear chains into `/muster:go-backlog`. |
| Go-backlog | `/muster:go-backlog <backlog ref>` | The batch clearer. Plain backlogs run sequentially. An annotated `{id}`/`{deps}` backlog builds and reviews every ready item in dependency waves, concurrently when the runtime can dispatch safely, then performs disposition/integration in emitted order after the wave barrier. It has one attended stop at the end; an escalated item never aborts the batch. |
| Diagnose | `/muster:diagnose <symptom>` | Failure-first bug fix: reproduce, find root cause, fix, add a regression test, verify. No symptom-patching. |
| Audit | `/muster:audit [path]` | Breadth-first whole-codebase review and fix across six dimensions (seven when the project builds prompts or agents), then fixes everything with tests and verifies. |
| Design | `/muster:design <action>` | Resolve canonical `DESIGN.md` context and digest receipts, initialize it with an attended hold, inspect bounded design evidence/provider state, or run one of 23 pinned design workflows. |
| Runner | `/muster:runner [source]` | Unattended one-cycle work-picker for a Claude Code Routine or cron: resumes an answered blocked item or claims exactly one available item, drives it through the full Go lifecycle force-coerced to a `pr` disposition, leaves a receipt, and stops. The schedule provides the loop, not the verb. |
| Capture | `/muster:capture [hint]` | Conversation-to-backlog generator: mines the session's discussion (findings, decisions, review residuals, an explicit directive) into backlog items via the same extract/validate/dedupe/write machinery, gated by your approval before anything is written. Writes only `.muster/backlog.md` -- it never assembles a crew or runs work itself. |
| Init | `/muster:init [dir]` | Prepare a repository profile and receipt, hand native instruction work to the active runtime, and finalize only after positive evidence or an acknowledged unavailable handoff. |

`/muster:run`, `/muster:autopilot`, and `/muster:sprint` still work: each prints a one-line heads-up, then runs its replacement (`plan`, `go`, and `go-backlog`, respectively) unchanged. Deprecated as of 2026-07-17 and retiring in muster 0.7.0 -- migrate to the replacement verb before then; behavior stays unchanged for the rest of the window.

Design mode's context resolution, attended initialization, bounded detector, provider contract, and complete workflow list are documented in [docs/design.md](docs/design.md).

Plan and Go accept a GitHub issue reference (a bare number, `#123`, or an issues URL) as the outcome; both also accept the same backlog refs as Plan-backlog and Go-backlog (a backlog `.md` path, `issues:<label>`, or `linear:<key>`) and confirm the scope before planning a whole batch. A thin outcome gets refined first: `muster assess` does a deterministic gap-check, and if the outcome is vague, an interview skill asks one question at a time behind an approval gate before any crew is assembled. An outcome that decomposes into independent parts can instead be written to a backlog (`.muster/backlog.md`) for `/muster:go-backlog` to clear as a batch, or for `/muster:plan-backlog` to batch-plan first; `/muster:audit backlog [path]` fills the same backlog from audit's findings, sweeping read-only instead of fixing them inline; `/muster:capture [hint]` fills it a third way, mining a conversation's findings and decisions instead of an audit sweep or an interview decomposition.

An item annotated with `{id}`/`{deps}` switches `/muster:go-backlog` into wave mode. Every ready item is eligible for an isolated build and review regardless of whether its eventual disposition is `pr`, `keep`, `merge-local`, or `merge-push`. Concurrency is bounded by the declared environment and wave size (`MUSTER_SPRINT_PARALLEL`, default 5 and hard ceiling 10), not by a fixed three-runner rule. After every worker wake, the orchestrator drains all available completion receipts, reconciles once, dispatches every newly eligible action, and reconciles again before it may wait. The wave-wide build/review barrier must pass before ordered disposition/integration begins, and the next dependency wave waits for that ordered lane. A harness without safe parallel dispatch executes the same schedule sequentially without changing dependency or integration order. Go-backlog and Runner share a **coordination** skill (claim/receipt/ledger discipline) so a scheduled Runner and an attended Go-backlog clear can safely work the same backlog or `issues:<label>` at once.

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

Each role also carries a conceptual tier picked to fit the work. The ladder, from least to most capable, is `scout`, `core`, `prime`, and `apex`. Mechanical roles use scout, routine work defaults to core, and peak-judgment roles use apex with a deterministic fallback to prime. Runtime adapters map those tiers to concrete models. Muster composes the tools you already have and falls back to its own. For the full design, see the [architecture reference](https://adnova-group.github.io/muster/reference/architecture) (or [docs/architecture.md](docs/architecture.md) in-repo).

## Claude Code-only lifecycle hooks

This section describes the plugin-native Claude Code hooks. Codex uses the diagnostic hook layer described above. Other harnesses receive only the lifecycle primitives they actively subscribe to; Muster does not infer an active harness subscription from files on disk.

Claude Code receives four plugin-native hooks. Enforcement follows the run's external effects, not the orchestrator's own in-repo edits: the only hard deny on a tool call is the action-class fence, scoped to a live run that declared a forbidden action. The fence fails open when run markers are absent or unreadable, classification is ambiguous, or no forbidden class matches. Calls inside a subagent carry `agent_id` and are exempt because ownership and worktree checks happen at the wave barrier. This means the fence cannot police a forbidden external effect performed by a subagent; the dispatch brief and review gate remain required. A second, narrower block lives on `TaskCompleted`, gating the native task board's own completion tick rather than a tool call. Everything else is a warn-only border invitation.

- **`SessionStart`**: injects a one-line pointer (muster available; `/muster:plan` for orchestration-scale work) at the start of every session, and clears stale `.muster/run-active`/`wave-active` markers and per-session drift state so a new session never inherits a crashed run's state.
- **`UserPromptSubmit`**: the only prompt-time nudge is the isDirective-triggered border invitation. A directive-shaped prompt is eligible only after inline-file activity corroborates orchestration scale; a cold "fix typo" does not trigger it. One invitation starts a shared 15-minute cooldown. The signal re-arms after a Muster run starts, `SessionStart`, or 60 minutes of inactivity, but the cooldown still prevents rapid repeats.
- **`PreToolUse`**: the action-class fence (the one hard deny) plus the tool-call half of the same border invitation. While a muster run is active AND `.muster/forbidden-actions` lists a class, a tool call classified into that class (send/sign/submit/publish/purchase/delete-remote) is denied, honoring `MUSTER_ACTION_GUARD` (`off`/`warn`/deny-by-default). Independently, a cumulative counter of distinct inline-edited files (across turns, with no muster run active) crossing `MUSTER_INLINE_SCALE` (default 3) warns once per crossing with the same value-toned copy -- never denies. Writes into `.muster/` and `.claude/` (in-cwd repo) are always exempt.
- **`TaskCompleted`**: the second block surface. The orchestrator writes `.muster/task-board.json` (one entry per native task muster created) and flips an entry to `reviewGate: "pass"` only once the review gate actually passes that task. This hook denies (exit 2) a completion tick on a tracked task that has no recorded PASS, so a task cannot be marked done before it has been reviewed; it fails open for anything the board does not track. `MUSTER_TASK_GATE=off` disables it.

All four hooks live inside the plugin, so they activate when muster is enabled and go away when muster is disabled. They do not write to your `~/.claude/CLAUDE.md` or `settings.json` and create no global files. Each hook is fail-safe: any error falls back to an empty result and never blocks a session from starting.

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
| `MUSTER_INLINE_SCALE` | `3` | The border-invitation threshold: the Nth distinct file edited inline across turns, with no muster run active, crosses the border and warns once per crossing (never denies). |
| `MUSTER_MAX_TIER` | _(unset)_ | Caps the conceptual model tier policy. For example, `MUSTER_MAX_TIER=prime` excludes apex and `MUSTER_MAX_TIER=core` enables budget mode; unset means no cap. Static agent frontmatter pins are not affected on direct invocation; in Muster runs the dispatch override honors the cap. |
| `MUSTER_ENABLE_APEX` | _(unset)_ | Enables apex for peak-judgment roles such as the tournament judge, architecture review, improve, and advisor. Unset (or `0`/`false`) degrades apex to prime deterministically; `1`/`true` enables it when the harness can serve it. |
| `MUSTER_ACTION_GUARD` | `deny` | Action-class fence on `PreToolUse` while `.muster/forbidden-actions` is present: `deny` blocks a matching send/sign/submit/publish/purchase/delete-remote tool call, `warn` allows with a reminder, `off` disables the fence. This is the only hard-deny surface left in muster's enforcement stack. |
| `MUSTER_ADVISOR_MAX_CONSULTS` | `3` | Maximum advisor consults per run. Bounds the cost of workers escalating to the advisor role. Set to 0 to disable advisor consults. |
| `MUSTER_FUSE_TOPK` | `3` | Maximum number of tournament candidates passed to the fusion synthesizer. Must be >= 1. |
| `MUSTER_FUSE_MIN_DISAGREEMENT` | `1` | Minimum disagreement score required to activate fusion synthesis. Below this threshold `muster fuse` falls back to the single best candidate. Set to 0 to always fuse when >= 2 candidates pass. |
| `MUSTER_SPRINT_PARALLEL` | `5` | Max concurrent item-runner subagents per wave in `/muster:go-backlog` wave mode; hard ceiling `10` (higher values clamp, `0` is invalid; concurrency is never unbounded). Read by go-backlog's orchestration protocol, not by library code. |

This table covers the most common controls. See the [full configuration reference](https://adnova-group.github.io/muster/reference/configuration) for hook cooldown, model, concurrency, and advanced runtime settings.

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

Contributions are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) to get started.

Muster is licensed under Apache-2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
