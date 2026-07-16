# OpenAI Codex CLI — harness internals, implementation-grade

- **Run:** `harness-internals-research`, wave 1
- **Date:** 2026-07-16
- **Target:** the naked Codex CLI base loop (terminal harness), deep enough to reimplement — and, critically, deep enough that muster rides it instead of fighting it. This is the harness whose first muster integration burned a $100 quota plan in two days by working against its internals; the token-amplification fix (25-step ceilings, `agents.max_threads` respect, 3-heartbeat budget exhaustion) is now baseline and is treated throughout this document as a first-class design input [src: dr-burn].
- **Evidence tags:** `[DOCUMENTED]` = official OpenAI Codex docs (developers.openai.com), `[CODE-VERIFIED]` = read directly from this repository's code, `[DECISION-RECORD]` = a docs/decisions/* retriage encoding verified hard-won behavior, `[INFERRED]` = reasoned from adjacent evidence, marked as such [src: codex-llms-map].
- **Version anchor:** muster's integration was built and verified against Codex CLI 0.144; the official docs cited here are the live set as of 2026-07-16 and in one identified place (plugin-bundled hook execution) describe newer behavior than 0.144 shipped — that divergence is called out explicitly in §5.4 [src: changelog].

---

## 1. What Codex is: the base agent loop

`[DOCUMENTED]` Codex CLI is OpenAI's local coding agent: a Rust harness (`codex-rs` in github.com/openai/codex) that runs a model in a turn loop against local tools, under a sandbox-plus-approvals policy. The interactive TUI (`codex`), non-interactive runner (`codex exec`), IDE extension, and the ChatGPT desktop app are all front-ends over the same core and **share one configuration** (`config.toml`, hooks, MCP servers, skills) [src: codex-config-basic] [src: codex-hooks-doc].

The loop's anatomy, as exposed by `codex exec --json` (JSON Lines event stream), is the authoritative decomposition [src: codex-exec-doc]:

- **Thread** (`thread.started`) — a session; persisted as rollout files unless `--ephemeral` [src: codex-exec-doc].
- **Turn** (`turn.started` / `turn.completed` / `turn.failed`) — one user-prompt-to-final-answer cycle; `turn.completed` carries token usage (`input_tokens`, `cached_input_tokens`, `output_tokens`, `reasoning_output_tokens`) [src: codex-exec-doc].
- **Items** (`item.started` / `item.completed`) — the loop's atomic steps: agent messages, reasoning, command executions, file changes, MCP tool calls, web searches, and plan updates [src: codex-exec-doc].

`[DOCUMENTED]` The tool surface inside a turn: a `shell` tool (feature `shell_tool`), a newer PTY-backed `unified_exec` tool (default on except Windows), `apply_patch` for file edits, `web_search` (default `"cached"` mode serving an OpenAI-maintained index; `"live"`, `"indexed"`, `"disabled"` selectable), MCP tools, skills, and — with `multi_agent` (default on) — subagent collaboration tools [src: codex-config-basic] [src: codex-hooks-doc] [src: codex-subagents-doc].

`[DOCUMENTED]` Standing context comes from an **AGENTS.md instruction chain** built once per run: global scope first (`$CODEX_HOME/AGENTS.override.md`, else `AGENTS.md`), then project scope walking from the Git root down to the cwd (per directory: `AGENTS.override.md`, then `AGENTS.md`, then `project_doc_fallback_filenames`; at most one file per directory), concatenated root-down so closer files override, capped at `project_doc_max_bytes` (32 KiB default). There is no cache to clear; the chain is rebuilt every run [src: codex-agents-md].

`[DOCUMENTED]` Safety posture: commands run inside a sandbox (`sandbox_mode` = `read-only` | `workspace-write` | `danger-full-access`; Linux sandbox is `bubblewrap` since 0.115), with `approval_policy` (`untrusted` | `on-request` | `never`) governing escalation prompts. `codex exec` defaults to a read-only sandbox and requires a Git repository unless `--skip-git-repo-check`. `.git`/`.codex` paths are protected inside writable roots [src: codex-config-basic] [src: codex-exec-doc] [src: codex-wsl-doc].

`[DOCUMENTED]` Non-interactive contract worth reimplementing exactly: `codex exec "<prompt>"` streams progress to stderr and prints only the final agent message to stdout; piped stdin becomes additional context when a prompt argument is present, or the whole prompt with `codex exec -`; `--output-schema <json-schema>` constrains the final message; `-o/--output-last-message` tees it to a file; `codex exec resume --last` / `resume <SESSION_ID>` continues a prior session; `--ignore-user-config` skips `$CODEX_HOME/config.toml` for hermetic automation [src: codex-exec-doc]. muster's build pipeline translates every `claude -p` instruction in ported workflows to `codex exec` on exactly this contract [src: build-codex].

---

## 2. Models and the reasoning-effort ladder

`[DOCUMENTED]` The current first-party family is GPT-5.6 in three cost/capability lanes — `gpt-5.6-sol` (flagship, "detail and polish"), `gpt-5.6-terra` (everyday workhorse), `gpt-5.6-luna` (fast/cheapest, "clear, repeatable work") — plus `gpt-5.4`, `gpt-5.4-mini`, `gpt-5.5`, and the Pro-only text-only preview `gpt-5.3-codex-spark`. Default model is set with top-level `model = "..."` in `config.toml` [src: codex-models-doc].

`[DOCUMENTED]` Reasoning effort is a separate axis, `model_reasoning_effort`, with the full ladder: `none` / `minimal` (lowest-latency, model-dependent), `low`, `medium` (balanced default), `high`, `xhigh` ("Extra High"), and — model-dependent — `max` and `ultra`. **Ultra is not a bigger single-agent budget: it fans work out to subagents.** Max gives the selected model more single-task reasoning time. Higher effort costs latency and tokens; the docs' explicit guidance is "use the lowest reasoning effort that produces the result you need" [src: codex-subagents-doc] [src: codex-models-doc].

`[CODE-VERIFIED]` muster does not maintain a second tier system for Codex; it keeps Claude-conceptual tiers and translates only at the adapter boundary. `CODEX_MODEL_POLICY` in `src/codex.js:5-24` maps: `haiku → gpt-5.6-luna/high`, `sonnet → gpt-5.6-luna/xhigh`, `opus → gpt-5.6-sol/high`, `fable → gpt-5.6-sol/high` (deliberately never routine max effort), plus an added cost-based lane `luna-xhigh → gpt-5.6-luna/xhigh` [src: codex-js].

`[CODE-VERIFIED]` The `luna-xhigh` lane is evidence-backed, not aesthetic: DeepSWE v1.1 measured **luna/low at 1.5% pass@1 vs luna/xhigh at 56.9% pass@1 at $1.54/task** — i.e. on the cheap model, effort is where the capability lives, and xhigh on luna is still cheap. The reservation clause is therefore cost-based: xhigh is allowed on luna; terra (any effort) and xhigh on any non-luna model stay reserved for `muster-strategist` (fable tier, sol/high) [src: codex-js] [src: manifest-json].

`[CODE-VERIFIED]` Per-agent assignments live in the frozen `codex/agents.manifest.json` (27 agents): mechanical/narrow Sonnet-sourced roles (`muster-surgeon`, `wsh-api-documenter`, `wsh-tutorial-engineer`) ride `luna-xhigh`; judgment-heavy Sonnet roles get per-agent `model: gpt-5.6-sol` overrides at `medium`/`high`; Opus-tier builders run sol at `medium`; DeepSWE evidence summary is embedded in the manifest's own description field [src: manifest-json].

`[INFERRED]` Reimplementation rule of thumb distilled from the above: model choice sets the price floor, effort sets the capability realized; on Codex, downgrading effort to save quota is the false economy (1.5% pass@1 does not save money, it spends it on failed runs), whereas downgrading model while holding effort high is the real lever [src: codex-js].

---

## 3. `config.toml`: the global configuration system

`[DOCUMENTED]` Codex resolves configuration across layers, highest precedence first [src: codex-config-basic]:

1. CLI flags and `-c`/`--config key=value` one-off overrides [src: codex-config-basic]
2. Project config: `.codex/config.toml` files from project root down to cwd (closest wins; **trusted projects only** — untrusted projects skip the whole project `.codex/` layer including hooks and rules) [src: codex-config-basic]
3. Profile files selected with `--profile <name>` (`~/.codex/<name>.config.toml`) [src: codex-config-basic]
4. User config: `~/.codex/config.toml` [src: codex-config-basic]
5. System config: `/etc/codex/config.toml` on Unix [src: codex-config-basic]
6. Built-in defaults; on managed machines, enterprise `requirements.toml` (system/MDM/cloud) additionally *constrains* what any layer may set (e.g. disallow `approval_policy = "never"`), and `managed_config.toml` defaults merge on top of user config, taking precedence even over `--config` overrides [src: codex-config-basic] [src: codex-managed-config].

`[DOCUMENTED]` The `[features]` table gates capabilities: `hooks` (default true; canonical key, `codex_hooks` deprecated alias), `multi_agent` (true), `unified_exec` (true except Windows), `shell_tool`, `shell_snapshot`, `remote_plugin`, `goals`, `memories` (experimental, false), etc. Toggle with `codex --enable <feature>` or `[features] key = true` [src: codex-config-basic].

`[DOCUMENTED]` Thread-limit settings — the exact keys muster's thread-limits item targets — live under `[agents]` [src: codex-subagents-doc]:

| Key | Default | Meaning |
|---|---|---|
| `agents.max_threads` | `6` | Cap on concurrently open agent threads [src: codex-subagents-doc] |
| `agents.max_depth` | `1` | Spawn nesting depth (root = 0): root can spawn children, children cannot recurse. Docs explicitly warn raising it turns broad delegation into repeated fan-out, multiplying tokens/latency [src: codex-subagents-doc] |
| `agents.job_max_runtime_seconds` | 1800 (per-call default) | Default per-worker timeout for `spawn_agents_on_csv` batch jobs [src: codex-subagents-doc] |
| `agents.interrupt_message` | `true` | Record a model-visible message when an agent turn is interrupted [src: codex-subagents-doc] |

`[DECISION-RECORD]` **Thread-limits gap, verified live:** nothing in muster currently writes `[agents] max_threads`/`max_depth` at install time — `grep -rn "max_threads\|max_depth" src/*.js` returns zero hits in any install/config-writing path; the only occurrences in the tree are generated *prose* telling the runtime to "Respect `agents.max_threads`; neither lower nor raise it". The module that would have done it (`src/codex-thread-limits.js`, `ensureCodexThreadLimits`/`restoreCodexThreadLimits`, writing `max_threads >= 12` / `max_depth >= 2`) died on the never-merged burn branch commit `f2da066`. The item is re-opened as `codex-thread-limits-enforcement` with explicit success criteria including: install **fails outright** with exact remediation if the `config.toml` write cannot complete **or the written config fails strict validation**, plus a separate doctor-side drift check [src: dr-install] [src: dr-audit].

`[DOCUMENTED]` Other config-file facts a reimplementation needs: `CODEX_HOME` (default `~/.codex`) is the root for config, auth (`auth.json` — treat as a password), logs, sessions, skills, and package metadata, and **must already exist if overridden**; `CODEX_SQLITE_HOME`/`sqlite_home` relocates SQLite-backed state (agent jobs, exported CSV results); `log_dir` opts into the plaintext `codex-tui.log`; `RUST_LOG` controls diagnostics; `CODEX_API_KEY` is honored only by `codex exec` [src: codex-env-doc] [src: codex-subagents-doc].

---

## 4. Lifecycle hooks: the contract, and the advisory-by-design line

### 4.1 Discovery, trust, and layering

`[DOCUMENTED]` Hooks are discovered next to every active config layer, as `hooks.json` or inline `[hooks]` tables in `config.toml` — in practice: `~/.codex/hooks.json`, `~/.codex/config.toml`, `<repo>/.codex/hooks.json`, `<repo>/.codex/config.toml`, plus enabled plugins' bundled hooks. **All matching hooks from all layers run; higher-precedence layers do not replace lower-layer hooks**; a layer holding both representations gets merged with a startup warning. Project-local hooks load only in trusted projects [src: codex-hooks-doc].

`[DOCUMENTED]` Trust model: non-managed command hooks are **skipped until the user reviews and trusts the exact definition**, recorded against the hook's current hash — any change re-quarantines it. `/hooks` in the CLI is the review/trust/disable surface. Managed hooks (system/MDM/cloud/`requirements.toml`) are trusted by policy; `allow_managed_hooks_only = true` suppresses user/project/session/plugin hooks entirely. `--dangerously-bypass-hook-trust` exists for pre-vetted automation [src: codex-hooks-doc]. muster's install flow depends on this: hooks provide value only "after the user trusts their exact definitions in `/hooks`" [src: skill-adapter].

`[DOCUMENTED]` Handler shape: `{ "type": "command", "command": "...", "timeout": <seconds, default 600>, "statusMessage": "...", "commandWindows"/"command_windows": "..." }` under event → matcher-group → hooks. Only `type: "command"` runs today (`prompt` and `agent` handlers are parsed but skipped; `async` parsed but unsupported). Commands run with the **session cwd** as working directory — the docs explicitly recommend git-root-anchored paths because Codex may start in a subdirectory [src: codex-hooks-doc]. muster's hook resolves its own state by walking up to the git root for exactly this reason [src: hooks-src].

### 4.2 Events and payloads

`[DOCUMENTED]` Every command hook receives one JSON object on stdin with shared fields `session_id` (subagent hooks report the *parent* session id), `transcript_path` (unstable format), `cwd`, `hook_event_name`, `model` (Codex extension), and for most events `permission_mode` (`default`/`acceptEdits`/`plan`/`dontAsk`/`bypassPermissions`) and `turn_id`. Exact wire schemas are generated in-repo at `codex-rs/hooks/schema/generated` [src: codex-hooks-doc].

| Event | Scope | Matcher filters | Event-specific input | Can it change behavior? |
|---|---|---|---|---|
| `SessionStart` | thread | `startup\|resume\|clear\|compact` | `source` | context injection only (`additionalContext` / plain stdout) [src: codex-hooks-doc] |
| `UserPromptSubmit` | turn | none | `prompt` | context injection; **can block the prompt** (`decision: "block"` or exit 2 + stderr) [src: codex-hooks-doc] |
| `PreToolUse` | turn | tool name (`Bash`, `apply_patch` aliased `Edit`/`Write`, `mcp__server__tool`) | `tool_name`, `tool_use_id`, `tool_input` | **can deny or rewrite SUPPORTED calls** (`permissionDecision: "deny"` / `"allow"` + `updatedInput`); `ask`, `continue:false` unsupported → hook marked failed, tool call proceeds [src: codex-hooks-doc] |
| `PermissionRequest` | turn | tool name | `tool_input(.description)` | allow/deny/abstain on approval prompts; any `deny` wins; only runs when approval would be asked [src: codex-hooks-doc] |
| `PostToolUse` | turn | tool name | `tool_input`, `tool_response` | can't undo; `decision:"block"` replaces the tool result with feedback and continues [src: codex-hooks-doc] |
| `PreCompact` / `PostCompact` | turn | `manual\|auto` | `trigger` | `continue:false` stops before/after compaction [src: codex-hooks-doc] |
| `SubagentStart` | subagent | `agent_type` | `agent_id`, `agent_type` | context injection for the subagent; **`continue:false` is parsed but does NOT stop the subagent** [src: codex-hooks-doc] |
| `SubagentStop` | turn | `agent_type` | `agent_transcript_path`, `stop_hook_active`, `last_assistant_message` | `decision:"block"` continues the subagent; JSON-only stdout [src: codex-hooks-doc] |
| `Stop` | turn | none | `stop_hook_active`, `last_assistant_message` | `decision:"block"` doesn't reject the turn — it spawns a continuation prompt from `reason`; JSON-only stdout [src: codex-hooks-doc] |

`[DOCUMENTED]` Output conventions: exit 0 + no output = success/continue; exit 2 + stderr = block/feedback where the event supports it; JSON on stdout for the structured contract (`continue`, `stopReason`, `systemMessage`, `suppressOutput` (parsed, unimplemented), `hookSpecificOutput.{hookEventName, additionalContext, permissionDecision, ...}`). Matching hooks across files all launch **concurrently** — one hook cannot prevent another from starting [src: codex-hooks-doc].

### 4.3 The advisory-by-design line — THE Codex lesson

`[DOCUMENTED]` The official docs say it themselves: `PreToolUse` "is still a **guardrail rather than a complete enforcement boundary** because Codex can often perform equivalent work through another supported tool path," and interception is explicitly incomplete — the PTY-backed `unified_exec` shell path is only partially intercepted, and `WebSearch` and other non-shell/non-MCP tools are not intercepted at all [src: codex-hooks-doc].

`[CODE-VERIFIED]` muster's shipped hook encodes the same truth in its own advisory strings: "Codex PreToolUse hooks surface this warning but do not reliably block every unified-shell or subagent action" (`codex/hooks/muster-hook.mjs:82`), "Codex PreToolUse hooks cannot reliably deny every subagent or unified-shell action" (`:84`), and the terminal rule "Hooks are diagnostic and fail open. Never break a Codex session." (`:103-105`) — the whole file is wrapped in a try/catch that swallows everything [src: hooks-src].

`[DECISION-RECORD]` This is why the `codex-efficiency-enforcement` contract was **retired, not rescoped**: its fail-closed clauses (block on missing profiles, model fallback, tier mismatch; disable recursive delegation; enforce budgets/timeouts/retries) are "architecturally unreachable against Codex's own dispatch: Codex hooks are advisory and fail-open by explicit design… the teardown did not remove a working fail-closed mechanism, **it never existed**." Every Codex-side enforcement clause hit the same root constraint; the record's standing consequence is that any future enforcement-flavored item must be "scoped explicitly against what Codex's hook/dispatch model can actually enforce (advisory diagnostics, not blocking control)" [src: dr-efficiency].

`[INFERRED]` Precise reimplementation framing: Codex hooks can **hard-block a narrow, enumerated set of interception points** (simple `Bash`, `apply_patch`, MCP tool calls, prompt submission, approval prompts) but the loop as a whole routes around any single point (unified_exec, subagent tool work, non-shell tools, concurrent hook launch, trust-gated activation, fail-open error handling). Therefore any *policy* built on hooks is advisory by construction; deterministic enforcement must live where muster puts it — in the orchestrator's own dispatch, manifests, worktree receipts, and post-hoc repository-state verification [src: dr-efficiency] [src: build-codex].

### 4.4 What muster actually installs

`[CODE-VERIFIED]` `muster install codex` merges seven owned hook groups (SessionStart, UserPromptSubmit, PreToolUse matching `Bash|apply_patch|Edit|Write|NotebookEdit|mcp__.*`, PostToolUse, SubagentStart, SubagentStop, Stop — all `timeout: 10`, all pointing at one `muster-hook.mjs`) into the selected layer's `hooks.json`, tracked by an ownership manifest (`<configDir>/muster/.muster-managed.json` with `format`, `owner: "muster"`, file list, `packageVersion`, SHA-256 `hookHash`, and the exact owned `hookGroups`); reinstall removes exactly the owned groups and errors on any modified-in-place Muster hook rather than clobbering user edits [src: hooks-template] [src: install-src].

`[CODE-VERIFIED]` The hook's runtime behavior is pure context/diagnostics keyed off muster's own marker files (`.muster/run-active`, `.muster/wave-active`, `.muster/forbidden-actions`) and a worktree heuristic (`gitdir: …/worktrees/…` in the `.git` file): SessionStart injects orchestration routing context, PreToolUse emits `systemMessage` *warnings* for forbidden action classes and out-of-worktree writes, SubagentStart injects read-only-vs-worktree policy per agent type, Stop/PostToolUse emit stale-state diagnostics [src: hooks-src].

---

## 5. Plugins, skills, marketplaces — the distribution layer

### 5.1 Plugin anatomy

`[DOCUMENTED]` A plugin is a directory with a required manifest at `.codex-plugin/plugin.json` (`name` kebab-case = identifier/namespace, `version`, `description`, publisher metadata, an `interface` object for install surfaces) plus root-level components the manifest points at with `./`-prefixed, root-confined paths: `skills` → `./skills/`, `mcpServers` → `./.mcp.json` (direct or `mcp_servers`-wrapped server map), `apps` → `./.app.json`, `hooks` → path(s) or inline object(s), defaulting to `./hooks/hooks.json` if present [src: codex-build-plugins].

`[DOCUMENTED]` Marketplaces are JSON catalogs read from `$REPO_ROOT/.agents/plugins/marketplace.json` (repo), `~/.agents/plugins/marketplace.json` (personal), a legacy-compatible `$REPO_ROOT/.claude-plugin/marketplace.json`, and the official directory. Each `plugins[]` entry carries `name`, `source` (`local` path relative to the marketplace root; or `url` / `git-subdir` with `ref`/`sha`; or `npm` package — downloaded **without running lifecycle scripts**), a required `policy` (`installation`: `AVAILABLE`/`INSTALLED_BY_DEFAULT`/`NOT_AVAILABLE`; `authentication`: `ON_INSTALL`/first-use), and `category`. Unresolvable entries are skipped, not fatal. CLI management: `codex plugin marketplace add|list|upgrade|remove` (Git shorthand, HTTPS/SSH URLs, `--ref`, `--sparse`) [src: codex-build-plugins].

`[DOCUMENTED]` **Plugin cache topology:** installs land at `~/.codex/plugins/cache/$MARKETPLACE_NAME/$PLUGIN_NAME/$VERSION/` (`$VERSION` = `local` for local plugins) and Codex loads the *installed copy from the cache*, not the marketplace source — so editing plugin source requires refresh/reinstall (restart the app so the local install picks up new files). Per-plugin on/off state is stored in `~/.codex/config.toml`; per-plugin MCP policy lives under `plugins."<plugin>".mcp_servers.<server>` [src: codex-build-plugins]. muster's coordination preflight treats this cache as "not a Git checkout" — it fingerprints installed behavior files with SHA-256 instead of `git log`, because there is no authoritative history inside the cache [src: build-codex].

### 5.2 Skills

`[DOCUMENTED]` A skill is a directory with `SKILL.md` (frontmatter `name` + `description` required; optional `scripts/`, `references/`, `assets/`, `agents/openai.yaml` for UI metadata, invocation policy `allow_implicit_invocation`, and tool dependencies), following the open agent-skills standard. Activation is explicit (`$skill-name`, `/skills`) or implicit via description matching. **Progressive disclosure with a hard context budget:** the initial skills list gets at most 2% of the context window (8,000 chars fallback) — descriptions get shortened, then skills get omitted with a warning; the full SKILL.md loads only on selection [src: codex-build-skills].

`[DOCUMENTED]` Discovery scopes: repo `.agents/skills` scanned in every directory from cwd up to the repo root, user `~/.agents/skills`, admin `/etc/codex/skills`, system (bundled: `skill-creator`, `plan`, `skill-installer`, `plugin-creator`). Same-name skills are not merged — both appear. `[[skills.config]]` entries (`path` + `enabled = false`) disable without deleting; symlinked skill folders are followed [src: codex-build-skills].

### 5.3 What muster's build-codex generates

`[CODE-VERIFIED]` `scripts/build-codex.mjs` materializes the complete plugin: 12 public mode skills (`$muster-plan`, `$muster-go`, `$muster-plan-backlog`, `$muster-go-backlog`, `$muster-diagnose`, `$muster-audit`, `$muster-runner`, `$muster-capture`, legacy `run`/`autopilot`/`sprint`, plus the root `muster` router skill), 62 internal skills (ported with mode-name/tool-name/plugin-path rewrites and a "Codex harness binding" section pointing at `runtime/codex-skill-adapter.md`), commands, catalog, pipelines, vendor tree, an esbuild-bundled CLI (`runtime/muster.mjs`) and MCP server (`runtime/muster-mcp.mjs`), `.mcp.json` wiring that server, 27 generated `agents/*.toml` profiles, `.codex-plugin/plugin.json`, and a local-source `marketplace.json` template — enforced counts live in `CODEX_COUNTS` (`src/codex.js:38-48`) and were re-verified three independent ways in the install retriage [src: build-codex] [src: codex-js] [src: dr-install].

`[CODE-VERIFIED]` Generation is install-time, never committed: wave 2 of the teardown deleted the committed `.agents/plugins` payload (with its content-addressed releases, selection log, and reader leases) because nothing shares a hot git tree anymore — profiles regenerate fresh from the frozen manifest on every build/install [src: release-src]. Generation stages on native tmpfs and copy-publishes rather than renaming, working around a confirmed WSL2 drvfs rename-after-write-burst ENOENT pathology (A/B-tested; not a Node bug) [src: build-codex].

### 5.4 Plugin-bundled hooks: docs vs 0.144 ground truth

`[DOCUMENTED]` Current docs state enabled plugins' hooks load alongside other layers (default `hooks/hooks.json`, manifest-overridable), receive `PLUGIN_ROOT`/`PLUGIN_DATA` (plus `CLAUDE_PLUGIN_ROOT`/`CLAUDE_PLUGIN_DATA` for compatibility), and go through the same trust review [src: codex-hooks-doc] [src: codex-build-plugins].

`[DECISION-RECORD]` muster's verified 0.144 behavior disagrees: "Codex 0.144 does not execute plugin-bundled hooks, so the plugin manifest must not be treated as hook activation evidence" — which is why `muster install codex` merges hooks into the supported project/user `hooks.json` layer instead of relying on the plugin bundle, and why `doctor --codex` checks the hooks layer, not the manifest [src: skill-adapter] [src: changelog]. `[INFERRED]` Treat plugin-bundled hooks as a version-gated capability: keep the hooks.json-layer install as the portable path until a floor Codex version that provably executes bundled hooks is established [src: skill-adapter].

---

## 6. Subagents and thread orchestration

`[DOCUMENTED]` Multi-agent is native and default-on (`features.multi_agent`). Codex ships three built-in agents — `default` (general fallback), `worker` (execution), `explorer` (read-heavy) — and spawns subagents when asked directly or when AGENTS.md/skill instructions request it; the harness itself handles orchestration: spawning, routing follow-ups, waiting, and closing threads, returning one consolidated response when all requested results are in. Subagents inherit the parent's sandbox/permission mode unless their profile overrides it; each subagent does its own model+tool work, so fan-out multiplies token spend [src: codex-subagents-doc].

`[DOCUMENTED]` **Custom agents** are standalone TOML files, one per agent, at `~/.codex/agents/` (personal) or `.codex/agents/` (project). Required: `name` (the source of truth, not the filename), `description`, `developer_instructions`. Optional: `nickname_candidates` (presentation-only display names), and any session config key — notably `model`, `model_reasoning_effort`, `sandbox_mode`, `mcp_servers`, `skills.config` — because each file is loaded as a full **config layer for spawned sessions**; omitted fields inherit from the parent session; a custom agent name shadows a same-named built-in [src: codex-subagents-doc].

`[CODE-VERIFIED]` muster's `profileToml()` emits exactly that schema per role: `name`, `description` (lifted from the agent markdown frontmatter), `model`, `model_reasoning_effort` (validated against `medium|high|xhigh`), `sandbox_mode` (`read-only` for `readOnly` roles, else `workspace-write`), and `developer_instructions` = the full agent body plus an isolation clause ("verify the task is running in an isolated git worktree; do not write directly on a base branch") — the profile TOML is treated as "the authoritative model, reasoning, and sandbox boundary" for a dispatched role [src: release-src] [src: build-codex].

`[CODE-VERIFIED]` Dispatch mechanics muster verified against the live runtime (not in the public docs; names from the working integration): the collaboration tool surface is `collaboration.spawn_agent` (fields: `task_name`, `message`, `fork_turns`, and the runtime extension `agent_type: "<profile name>"`), `collaboration.wait_agent` (timeout-bounded), and `collaboration.list_agents`. Hard-won contract details: **Codex rejects a named `agent_type` combined with a full-history context fork** (`fork_turns: "all"`) because full-history agents inherit the parent's type/model/effort — so muster always spawns `fork_turns: "none"`; `agent_type` may be missing from the simplified displayed tool signature but must be sent anyway; only an actually-rejected call proves a profile unavailable, and the correct response is failing closed with a registration diagnostic, never silently degrading to a generic agent (which loses the pinned model policy) [src: skill-adapter].

`[CODE-VERIFIED]` **There is no cwd field on subagent dispatch.** Worktree-scoped briefs must carry the absolute `WORKTREE CWD` and absolute manifest/STATE paths and instruct the child to use that workdir for every tool call — the harness will not scope the child's filesystem for you [src: skill-adapter].

`[DOCUMENTED]` Recursive delegation is governed by `agents.max_depth` (default 1: children cannot spawn); concurrency by `agents.max_threads` (default 6). Batch fan-out exists as the experimental `spawn_agents_on_csv` tool (one worker per CSV row, `instruction` templating with `{column}` placeholders, optional `output_schema`, per-worker `report_agent_job_result` contract, SQLite-backed job state, single-line stderr progress under `codex exec`) [src: codex-subagents-doc].

`[CODE-VERIFIED]` muster's quota discipline on top of this loop — written in blood from the two-day burn — is baked into every generated skill as the "Agent watch invariant": retain every spawned agent id, immediately `wait_agent` with ≤60s timeout, process mailbox receipts then `list_agents` exactly once per wake, never tight-poll; three consecutive heartbeats without a receipt = budget exhausted → interrupt, record, escalate; every brief sets a 25-step ceiling, at most one follow-up, focused tests only, broad suites deferred to final verification; respect `agents.max_threads`, never raise or lower it [src: build-codex] [src: dr-burn].

---

## 7. MCP integration (Codex as client — and as server)

`[DOCUMENTED]` Codex is a full MCP client; configuration lives in `config.toml` (`[mcp_servers.<name>]` tables), shared across CLI/IDE/desktop, project-scopable in trusted repos. STDIO servers: `command`, `args`, `env`, `env_vars` (allow/forward, with `source = "local"|"remote"`), `cwd`, `experimental_environment = "remote"`. Streamable HTTP servers: `url`, `auth` (`oauth` default, `chatgpt` session auth for first-party), `bearer_token_env_var`, `http_headers`, `env_http_headers`; `codex mcp login <server>` runs OAuth, with `mcp_oauth_callback_port`/`mcp_oauth_callback_url` overrides. Codex reads the MCP `instructions` field at initialization as server-wide guidance — with the first 512 characters treated as the always-available core [src: codex-mcp-doc].

`[DOCUMENTED]` Governance knobs per server: `enabled`, `required` (startup fails if it can't initialize — `codex exec` exits with an error rather than continuing), `enabled_tools` / `disabled_tools` (deny applied after allow), `default_tools_approval_mode` (`auto`/`prompt`/`writes`/`approve`), per-tool `tools.<tool>.approval_mode`, `startup_timeout_sec` (10), `tool_timeout_sec` (60). Plugin-bundled MCP servers launch from the plugin; users control only policy via `plugins.<plugin>.mcp_servers.<server>` [src: codex-mcp-doc].

`[CODE-VERIFIED]` muster rides this as a plugin-bundled server: the generated `.mcp.json` runs `node ./runtime/muster-mcp.mjs` from the plugin root, exposing 21 deterministic tools (routing, capabilities `--codex`, assess, manifest validation, wave computation, scoring) — verified end-to-end by `doctor --codex`'s live `initialize` + `tools/list` handshake reporting 21/21 [src: build-codex] [src: dr-install]. MCP tool calls are also a hook-interceptable and matcher-addressable surface (`mcp__server__tool`), making the muster MCP the *most* governable part of the integration [src: codex-hooks-doc].

`[DOCUMENTED]` The inverse direction exists too: Codex can run **as** an MCP server for the Agents SDK ("Invoke Codex as an MCP server to build multi-agent development workflows"), which is the sanctioned embedding path when an outer orchestrator wants Codex as a callable tool rather than a host [src: codex-llms-map].

---

## 8. Config/cache topology: CODEX_HOME, WSL/Windows split-state, desktop-vs-CLI

`[DOCUMENTED]` One `CODEX_HOME` (default `~/.codex`) is the state root shared by CLI, IDE extension, app-server, and installers: `config.toml`, `auth.json`, logs, session rollouts, skills, `plugins/cache/...`, `packages/standalone`, `agents/`, `hooks.json`. The desktop app and CLI deliberately share config, MCP setup, and plugin enable-state — configure once, use everywhere [src: codex-env-doc] [src: codex-mcp-doc] [src: codex-build-plugins].

`[DOCUMENTED]` On Windows the supported topologies are: native Windows with the elevated sandbox (`[windows] sandbox = "elevated"`), or WSL2 (Codex runs fully inside Linux; WSL1 dead since 0.115/bubblewrap). The docs' performance guidance is to keep repos in the Linux filesystem, not `/mnt/c` [src: codex-config-basic] [src: codex-wsl-doc].

`[CODE-VERIFIED]` The split-state reality muster's installer handles — the practical WSL-vs-Windows boundary a reimplementation must respect [src: install-src]:

- **Dual command emission:** every installed hook gets both `command` (POSIX, single-quoted) and `commandWindows` (drive-letter form), with `/mnt/<drive>/…` ⇄ `<Drive>:/…` translation in `formatCodexWindowsPath` — because one `hooks.json` may be executed from either side of the boundary (`src/codex-install.js:501-513`) [src: install-src].
- **Case-insensitivity:** on `/mnt/c` (DrvFS) `realpath` does not canonicalize casing, so muster recovers on-disk casing by walking parent directory listings (`canonicalDiskCasing`), and reconciles duplicate scope-registry entries by `dev:ino` physical identity rather than string compare — the same `.codex` dir registered under two casings collapses to one survivor (`src/codex-install.js:94-144`) [src: install-src].
- **Scope registry:** muster tracks every install scope in `$CODEX_HOME/muster/install-scopes.json` (`owner: "muster"`, validated, deduplicated, pruned when a configDir vanishes — with the documented ambiguity that an unmounted `/mnt/*` drive is indistinguishable from a deleted one) so uninstall/doctor can enumerate user- and project-scope installs across hosts (`src/codex-install.js:26,66-83,121-144`) [src: install-src].
- **Path-leak lesson:** `.codex/hooks.json` and `.codex/muster/.muster-managed.json` are untracked by policy because installs bake absolute, machine-specific (and previously case-duplicated Windows/WSL) paths into every hook command — they are regenerated per checkout by `muster install codex --scope project` [src: changelog] [src: dr-burn].
- **DrvFS rename pathology:** renaming a directory right after a large write burst on a `/mnt/c` mount can return persistent spurious ENOENT; muster stages generation on native tmpfs and copy-publishes instead of renaming hot trees across that mount (`scripts/build-codex.mjs` top-of-file analysis) [src: build-codex].

`[CODE-VERIFIED]` Install scoping mirrors Codex's own layers: user scope writes `$CODEX_HOME/agents/*.toml` + `$CODEX_HOME/hooks.json`; project scope writes `<repo>/.codex/agents/*.toml` + `<repo>/.codex/hooks.json` (active only in trusted projects); the plugin registers via `codex plugin marketplace add <repoRoot>` + `codex plugin add muster@muster`, with a trust check that the existing "muster" marketplace resolves to the same physical local root before reuse (`src/codex-install.js:603-629`) [src: install-src] [src: codex-config-basic].

---

## 9. Augmentation surface: how muster rides Codex (and where the advisory line sits)

`[INFERRED]` Governing rule, restated from the retired-enforcement record: **on Codex, muster owns judgment and verification; Codex owns dispatch and execution.** Anything phrased as "muster blocks X at runtime" is a design error on this harness — every enforcement ambition below is marked advisory unless it is muster's own deterministic code path (manifest validation, receipts, repository-state checks) running outside Codex's loop [src: dr-efficiency].

| Native primitive | What it's for | How muster RIDES it | Advisory vs enforcement |
|---|---|---|---|
| Agent loop + `codex exec` (JSONL events, `--output-schema`, resume) | The base autonomous turn loop; scriptable automation | Ported workflows call `codex exec` where Claude used `claude -p`; STATE receipts are the evidence contract [src: build-codex] | Loop is Codex's; muster's gates run before/after it, deterministically — **enforcement only outside the loop** [src: dr-efficiency] |
| `config.toml` layers + `[agents]` limits | Global model/sandbox/approval/thread policy | Respect `agents.max_threads`/`max_depth`, never lower nor raise at runtime; re-opened item raises the floor (≥12/≥2) at **install time** with fail-loud strict-validation semantics [src: skill-adapter] [src: dr-install] | Install-time write is enforceable (muster's own code); runtime thread policing is **advisory-only** — no attachment point exists [src: dr-install] |
| Lifecycle hooks (`hooks.json`, trust review) | Deterministic scripts on session/prompt/tool/subagent/stop events | Seven owned hook groups injecting orchestration context + policy *warnings* keyed off `.muster` markers; fail-open by design [src: hooks-template] [src: hooks-src] | **Advisory-only, by Codex design**: PreToolUse can deny some calls but unified_exec/subagent/non-shell paths route around it; muster must never claim hook-based hard gates [src: codex-hooks-doc] [src: dr-efficiency] |
| Custom agent TOML profiles (`.codex/agents/`) | Pin model, reasoning effort, sandbox, instructions per role | 27 generated profiles from the frozen manifest; profile = authoritative model/effort/sandbox boundary; dispatch by exact `agent_type` [src: release-src] [src: manifest-json] | `sandbox_mode = "read-only"` in a profile IS harness-enforced isolation; model/effort pinning holds only while dispatch uses the named type — silent generic-agent fallback loses it, so muster fails closed on rejection (its own advisory discipline) [src: skill-adapter] |
| Subagent collaboration (`spawn_agent`/`wait_agent`/`list_agents`, `fork_turns`) | Native parallel fan-out, per-call model override via profiles, consolidated results | Wave dispatch through named profiles, `fork_turns: "none"`, minimal dispatch packets, absolute worktree cwd in every brief, 60s-heartbeat watch protocol, 25-step ceilings [src: skill-adapter] [src: build-codex] | Thread caps/depth are harness-enforced; ceilings, one-follow-up, budget-exhaustion interrupts are **advisory prompt contracts** muster verifies via receipts, not blocks [src: dr-efficiency] |
| Skills (progressive disclosure, `$` invocation, 2% list budget) | Reusable workflows loaded on demand | 12 mode skills + 62 internal skills; explicit `$muster-*` routing; per-role capability lookups (`--role`) to stay inside the context budget [src: build-codex] [src: codex-build-skills] | Skill selection is model judgment — **advisory**; determinism comes from the skills shelling out to the bundled CLI/MCP brain [src: build-codex] |
| Plugins + marketplaces + cache | Versioned distribution of skills/MCP/hooks/profiles | Local marketplace + `codex plugin add muster@muster`; install-time generation into the cache; SHA-256 standing-context fingerprinting because the cache has no git history [src: install-src] [src: build-codex] | Install/registration is enforceable (muster code + Codex CLI exit codes); *cache-content integrity at runtime* is check-and-halt (HUMAN-HOLD), not prevention [src: build-codex] |
| MCP client (`[mcp_servers]`, approval modes, `required`) | Deterministic external tools with per-tool approval policy | Bundled muster MCP server (21 tools) is the deterministic brain: routing, manifest validate, waves, scoring; MCP calls are also the one fully hook-matchable tool class [src: build-codex] [src: codex-mcp-doc] | Strongest governable surface: `required = true`, allow/deny tool lists, and approval modes are **harness-enforced**; use MCP (not hooks) when a gate genuinely must gate [src: codex-mcp-doc] |
| Sandbox + approvals (`sandbox_mode`, `approval_policy`, PermissionRequest) | Filesystem/network containment and escalation prompts | Read-only profiles for reviewer/investigator roles; workspace-write plus muster's own worktree-isolation rule for builders [src: release-src] [src: hooks-src] | Sandbox is real harness enforcement; **worktree isolation is not** — Codex has no per-dispatch cwd, so isolation is muster's dispatch discipline verified by path/base-SHA receipts [src: skill-adapter] |
| AGENTS.md chain | Persistent per-repo/per-user working agreements | Standing context injection lives in SessionStart hooks + skills instead of AGENTS.md (muster stays silent below its border); AGENTS.md remains user-owned [src: hooks-src] | Pure context — advisory by definition [src: codex-agents-md] |

**What CANNOT be enforced on Codex (canonical list):** universal PreToolUse denial (unified_exec/subagent/non-shell gaps), fail-closed profile/model/tier mismatch blocking, todo-before-spawn and dispatch-not-inline blocking, runtime thread/depth policing, per-worker token budgets/timeouts/retries, and telemetry-triggered halts — each retired with evidence in the efficiency-enforcement record; the shipped substitutes are hook *diagnostics*, `doctor --codex` fail-loud checks, and the orchestrator's own deterministic receipts [src: dr-efficiency].

---

## Sources

- codex-hooks-doc: https://developers.openai.com/codex/hooks.md
- codex-subagents-doc: https://developers.openai.com/codex/agent-configuration/subagents.md
- codex-config-basic: https://developers.openai.com/codex/config-file/config-basic.md
- codex-managed-config: https://developers.openai.com/codex/enterprise/managed-configuration.md
- codex-build-plugins: https://developers.openai.com/codex/build-plugins.md
- codex-build-skills: https://developers.openai.com/codex/build-skills.md
- codex-models-doc: https://developers.openai.com/codex/models.md
- codex-mcp-doc: https://developers.openai.com/codex/extend/mcp.md
- codex-exec-doc: https://developers.openai.com/codex/non-interactive-mode.md
- codex-agents-md: https://developers.openai.com/codex/agent-configuration/agents-md.md
- codex-env-doc: https://developers.openai.com/codex/config-file/environment-variables.md
- codex-wsl-doc: https://developers.openai.com/codex/windows/wsl.md
- codex-llms-map: https://developers.openai.com/codex/llms.txt
- hooks-src: codex/hooks/muster-hook.mjs:13-105
- hooks-template: codex/hooks/hooks.json:1-88
- codex-js: src/codex.js:5-48
- manifest-json: codex/agents.manifest.json:3-31
- build-codex: scripts/build-codex.mjs:13-453
- skill-adapter: codex/skill-adapter.md:5-24
- install-src: src/codex-install.js:15-629
- release-src: src/codex-release.js:10-190
- changelog: CHANGELOG.md:13-19
- dr-efficiency: docs/decisions/retriage-codex-efficiency-enforcement.md:44-98
- dr-install: docs/decisions/retriage-install-items.md:108-144
- dr-audit: docs/decisions/retriage-audit-hardening.md:31
- dr-burn: docs/decisions/retriage-burn-salvage.md:33-34
