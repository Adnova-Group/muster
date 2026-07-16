# Research: Hermes Agent (Nous Research) — harness internals for a muster port

Implementation-grade teardown of the Hermes Agent harness, produced for the
harness-internals-research run. Evidence tags: [DOCUMENTED] = official docs/README,
[CODE-VERIFIED] = local file:line or a live API query run during research,
[INFERRED] = judgment from documented facts, [AMBIGUOUS] = conflicting/thin evidence.

## Disambiguation (resolved)

Resolved by the user mid-run: "Hermes" = **Hermes Agent by Nous Research**, canonical
source https://hermes-agent.nousresearch.com/ [src: hermes-home]. The user's original
directive ("we want to create a version of muster HErmes agents can lean on as well")
is on record locally [src: local-history]. [CODE-VERIFIED]

Other "Hermes" candidates encountered and set aside:

- **Nous "Hermes" model series** (Hermes 4 etc.) — same org, different artifact: the LLM
  family the agent is named after. Hermes Agent the harness is model-agnostic ("Use any
  model you want — Nous Portal, OpenRouter, OpenAI, your own endpoint")
  [src: hermes-readme]. [DOCUMENTED]
- **hermes-labs-ai** GitHub org — referenced from muster's own source as the home of
  `lintlang` [src: local-promptlint]; unrelated to Nous Research. [CODE-VERIFIED]
- **"Hermes Agent" as an install target in third-party skills tooling** — the GSD skills
  installer lists it alongside Claude Code/Cursor/Cline with a `--hermes` flag and a
  `HERMES_HOME` env var [src: local-codex-session]; same Nous product, confirming
  ecosystem adoption, not a separate project. [CODE-VERIFIED]

No local Hermes install exists on this machine (no `~/.hermes`, no `hermes` binary)
[src: local-env-check]; everything below is sourced from the official docs site, the
GitHub repo README, and the GitHub API. [CODE-VERIFIED]

## 1. Identity and shape

- Repo: `NousResearch/hermes-agent`, MIT license, primary language Python (~58 MB Python,
  ~10 MB TypeScript), default branch `main` [src: gh-api]. [CODE-VERIFIED]
- Scale/velocity: 215,942 stars (implausibly high for a v0.18.2 project; not yet verified
  against the live repo), 40,332 forks, created 2025-07-22, pushed 2026-07-16; latest
  release v0.18.2 (tag `v2026.7.7.2`, 2026-07-08) [src: gh-api]. [UNVERIFIED-SUSPECT]
- Positioning: "The self-improving AI agent built by Nous Research… the only agent with a
  built-in learning loop — it creates skills from experience, improves them during use,
  nudges itself to persist knowledge, searches its own past conversations, and builds a
  deepening model of who you are across sessions" [src: hermes-readme]. [DOCUMENTED]
- GitHub topics place it explicitly in the OpenClaw/Clawdbot/Moltbot lineage space, and it
  ships `hermes claw migrate` plus a migrate-from-openclaw guide [src: gh-api]
  [src: hermes-readme]. [DOCUMENTED]
- Install: `curl -fsSL https://hermes-agent.nousresearch.com/install.sh | bash` (Linux/
  macOS/WSL2/Termux) or a PowerShell one-liner on native Windows; installs under
  `~/.hermes` (Linux) / `%LOCALAPPDATA%\hermes` (Windows); bundles uv, Python 3.11,
  Node.js, ripgrep, ffmpeg [src: hermes-readme]. [DOCUMENTED]
- Entry points: CLI/TUI (`hermes`), messaging gateway (20 platform adapters: Telegram,
  Discord, Slack, WhatsApp, Signal, Matrix, email, SMS, webhook, api_server, …), ACP
  server for IDEs, batch runner, HTTP API server, and direct Python import
  [src: hermes-arch]. [DOCUMENTED]
- Test surface: "~25,000 tests across ~1,250 files" [src: hermes-arch]. [DOCUMENTED]
- Research tail: batch trajectory generation in ShareGPT format for training tool-calling
  models — the harness doubles as a data factory [src: hermes-arch]. [DOCUMENTED]

## 2. The naked base loop

The core engine is the `AIAgent` class in `run_agent.py` — one synchronous orchestration
class serving every entry point (CLI, gateway, ACP, batch, API server); platform
differences live in the entry point, not the agent [src: hermes-arch]. [DOCUMENTED]

- Two entry methods: `agent.chat(msg)` (returns final string) and
  `agent.run_conversation(user_message=…, system_message=None, conversation_history=None,
  task_id=…)` (returns dict with messages, metadata, usage) [src: hermes-agent-loop]. [DOCUMENTED]
- Three API execution modes, all converging on OpenAI-style `role`/`content`/`tool_calls`
  message dicts internally: `chat_completions` (OpenAI-compatible), `codex_responses`
  (OpenAI Responses), `anthropic_messages` (native Anthropic via adapter). Resolution
  order: explicit `api_mode` arg → provider detection → base-URL heuristic → default
  `chat_completions` [src: hermes-agent-loop]. [DOCUMENTED]
- Turn lifecycle (documented order): generate task_id → append user msg → build/reuse
  cached system prompt (`prompt_builder.py`) → preflight compression check (>50% context)
  → build API messages per mode → inject ephemeral layers (budget warnings, context
  pressure) → Anthropic cache markers → interruptible API call → parse: tool_calls loop
  or final text → persist session, flush memory [src: hermes-agent-loop]. [DOCUMENTED]
- Strict role alternation enforced (never two assistant or two user messages in a row;
  only `tool` role may repeat) [src: hermes-agent-loop]. [DOCUMENTED]
- Interruptibility is structural: HTTP calls run on a background thread while the main
  thread waits on response/interrupt/timeout; an interrupt abandons the API thread and no
  partial response enters history [src: hermes-agent-loop]. [DOCUMENTED]
- Tool execution: single call runs inline; multiple calls run concurrently via
  `ThreadPoolExecutor` (interactive tools like `clarify` force sequential); results are
  re-ordered to original call order [src: hermes-agent-loop]. [DOCUMENTED]
- Four "agent-level tools" are intercepted before registry dispatch because they mutate
  agent state: `todo`, `memory`, `session_search`, `delegate_task`
  [src: hermes-agent-loop]. [DOCUMENTED]
- Budgets: default 90 iterations per agent (`agent.max_turns`); subagents get independent
  budgets capped at `delegation.max_iterations` (default 50); at 100% the agent stops and
  returns a summary. Mid-task pressure warnings were removed (April 2026) for causing
  premature abandonment; exhaustion now gets one wrap-up message + a single grace call
  [src: hermes-agent-loop] [src: hermes-config]. [DOCUMENTED]
- Fallback: on 429/5xx/auth errors, walk `fallback_providers` in order (credential
  refresh on 401/403); vision/compression/web-extraction each have independent fallback
  chains under `auxiliary.*` [src: hermes-agent-loop]. [DOCUMENTED]
- Compression: preflight at >50% of context, gateway auto-compression at >85%; memory is
  flushed to disk first; middle turns summarized; last N messages preserved
  (`compression.protect_last_n`, default 20); tool call/result pairs never split;
  compression creates a child session in the lineage [src: hermes-agent-loop]. [DOCUMENTED]
- Eight callback surfaces (`tool_progress_callback`, `thinking_callback`,
  `reasoning_callback`, `clarify_callback`, `step_callback`, `stream_delta_callback`,
  `tool_gen_callback`, `status_callback`) are how CLI/gateway/ACP render progress — the
  loop itself is UI-free [src: hermes-agent-loop]. [DOCUMENTED]

Prompt assembly is a first-class subsystem: the cached system prompt is three ordered
tiers — stable (identity from `~/.hermes/SOUL.md` or fallback, tool guidance, skills
index, platform hints) → context (caller `system_message` + project context files) →
volatile (frozen `MEMORY.md`/`USER.md` snapshots, timestamp/session line). Project
context files resolve first-match-wins, only ONE type loads: `.hermes.md`/`HERMES.md`
(walks up to git root) → `AGENTS.md` (CWD + progressive subdirectory discovery) →
`CLAUDE.md` → `.cursorrules`. All context files are security-scanned for prompt
injection and truncated at `context_file_max_chars` (default 20,000)
[src: hermes-prompt-assembly]. [DOCUMENTED]

## 3. Tool dispatch and the permission/approval model

### Registry and dispatch

- Central singleton registry (`tools/registry.py`); each `tools/*.py` file self-registers
  at import via a top-level `registry.register(name=…, toolset=…, schema=…, handler=…,
  check_fn=…, requires_env=…, is_async=…, description=…, emoji=…)` call; discovery
  AST-parses `tools/*.py` for top-level register calls, then imports — no manual import
  list [src: hermes-tools-runtime]. [DOCUMENTED]
- ~70+ tools across ~28 toolsets; after builtin discovery, MCP tools
  (`tools.mcp_tool.discover_mcp_tools()`) and plugin tools
  (`hermes_cli.plugins.discover_plugins()`) are appended [src: hermes-arch]
  [src: hermes-tools-runtime]. [DOCUMENTED]
- Availability gating is code, not prompt: optional `check_fn` per tool (env key present,
  service running, binary installed); a failing/erroring check drops the tool from the
  schema list entirely; results cached per collection pass
  [src: hermes-tools-runtime]. [DOCUMENTED]
- Toolset resolution in `model_tools.get_tool_definitions(enabled_toolsets,
  disabled_toolsets, quiet_mode)`: explicit enabled list wins; else all-minus-disabled;
  else everything. Post-filter, `execute_code` and `browser_navigate` schemas are patched
  to reference only tools that survived — an anti-hallucination measure
  [src: hermes-tools-runtime]. [DOCUMENTED]
- Dispatch flow: `handle_function_call()` → agent-level tools short-circuit → plugin
  `pre_tool_call` hook → `registry.dispatch()` → plugin `post_tool_call` hook → tool-role
  message. Two layers of error wrapping guarantee the model always receives well-formed
  JSON errors [src: hermes-tools-runtime]. [DOCUMENTED]
- Common toolsets: `web`, `terminal`, `file`, `browser`, `vision`, `skills`, `todo`,
  `memory`, `session_search`, `cronjob`, `code_execution`, `delegation`, `clarify`,
  `messaging`, `safe`, plus platform presets (`hermes-cli`, `hermes-telegram`) and
  dynamic `mcp-<server>` toolsets [src: hermes-tools-user]. [DOCUMENTED]

### Approval model

The permission model is **dangerous-command interception, not rule-based allowlisting of
every call** [src: hermes-tools-runtime]. [DOCUMENTED]

- `tools/approval.py` holds `DANGEROUS_PATTERNS` — regex/description tuples covering
  recursive deletes, `mkfs`/`dd`, destructive SQL (`DROP TABLE`, `DELETE FROM` without
  `WHERE`), writes to `/etc/`, `systemctl stop`, `curl | sh`, fork bombs, process kills
  [src: hermes-tools-runtime]. [DOCUMENTED]
- `detect_dangerous_command()` runs before every terminal command. On match: CLI prompts
  approve/deny/allow-permanently; gateway raises an async approval callback in the chat
  platform; "smart approval" mode has an auxiliary LLM auto-approve low-risk matches
  (e.g. `rm -rf node_modules/`) [src: hermes-tools-runtime]. [DOCUMENTED]
- `approvals.mode: smart` (default) | `manual` | `off` (`off` ≡ `HERMES_YOLO_MODE=true`);
  `approvals.deny: [globs]` are unconditional blocks that survive even yolo/off mode
  [src: hermes-config]. [DOCUMENTED]
- Approvals are per-session by pattern category; "allow permanently" persists into
  `command_allowlist` in `config.yaml` [src: hermes-tools-runtime]. [DOCUMENTED]
- Adjacent safety machinery: `security.redact_secrets: true` (default), a Tirith command
  scanner (`tirith_enabled: true`, fail-open), a website blocklist for web/browser tools,
  tool-loop guardrails (`warn_after` / `hard_stop_after` thresholds for repeated
  failures), and a file-mutation verifier that footnotes files the model claimed to edit
  but didn't [src: hermes-config]. [DOCUMENTED]
- Everything not matching a dangerous pattern executes without approval — the default is
  permissive inside whatever terminal backend you chose; isolation (Docker/SSH/sandbox
  backends) is the real containment story, and the docs recommend SSH "so the agent
  can't modify its own code" [src: hermes-tools-user]. [INFERRED from the documented
  pattern list + backend guidance]
- Fleet control is separate: **managed scope** (`/etc/hermes/config.yaml` +
  `/etc/hermes/.env`, root-owned) pins specific config keys/env values that user config,
  user `.env`, and even the shell environment cannot override — leaf-level merge,
  enforced purely by filesystem permissions; explicitly "a management-convenience
  boundary against a normal user, not an un-escapable sandbox" (v1)
  [src: hermes-managed-scope]. [DOCUMENTED]

## 4. Planning and task primitives

- `todo` tool: agent-local task state, intercepted at the agent-loop level
  [src: hermes-agent-loop]. [DOCUMENTED]
- `/goal` — a standing-objective loop ("our take on the Ralph loop", credited to Codex
  CLI's `/goal`): after every turn a `goal_judge` auxiliary model returns strict JSON
  `{"done": bool, "reason": …}`; `continue` feeds a continuation prompt back into the
  same session; default budget 20 continuation turns (`goals.max_turns`); fail-open (a
  broken judge means continue; the budget is the backstop) [src: hermes-goals]. [DOCUMENTED]
- **Completion contracts** on goals: optional structured fields `outcome`,
  `verification`, `constraints`, `boundaries`, `stop_when`; the judge may only declare
  done "when the verification criterion is met with concrete evidence"; `/subgoal`
  appends acceptance criteria mid-loop; state persists in `SessionDB.state_meta` and
  survives `/resume`. The judge can also park the loop on background processes
  (`wait_on_session`/`wait_on_pid`/`wait_for_seconds`) instead of burning turns polling
  CI [src: hermes-goals]. [DOCUMENTED]
- A protected built-in `plan` skill powers a `/plan` slash-command flow (hardcoded
  never-archivable) [src: hermes-curator]. [DOCUMENTED]
- Cron is first-class (agent tasks, not shell tasks): jobs in JSON, multiple schedule
  formats, attach skills/scripts, deliver to any platform; each job runs a fresh
  `AIAgent` with no history. Skills can carry a `metadata.hermes.blueprint` block that
  registers a *suggested* cron job on install (never auto-scheduled)
  [src: hermes-arch] [src: hermes-creating-skills]. [DOCUMENTED]

### Kanban — the durable multi-agent work queue

Hermes ships a whole second orchestration lane besides `delegate_task`: a durable task
board in `~/.hermes/kanban.db` (SQLite, WAL) where **every worker is a full OS process
with its own profile identity** (`hermes -p <profile> chat -q` subprocesses)
[src: hermes-kanban]. [DOCUMENTED]

- Statuses: `triage | todo | ready | running | blocked | done | archived`; dependency
  links promote `todo → ready` when all parents are `done`; comments are the documented
  inter-agent protocol; append-only `task_events` log (claimed, heartbeat, reclaimed,
  crashed, protocol_violation, gave_up, …) [src: hermes-kanban]. [DOCUMENTED]
- Workspaces per task: `scratch` (temp dir, artifacts must be declared to survive),
  `dir:<path>` (absolute only — relative rejected as a confused-deputy vector), or
  `worktree` (git worktree under `.worktrees/<id>/`, `--branch` supported)
  [src: hermes-kanban]. [DOCUMENTED]
- Dispatcher runs inside the gateway on a 60s tick: reclaims stale claims and crashed
  workers (PID gone), promotes, atomically claims (`BEGIN IMMEDIATE`), spawns workers;
  `kanban.failure_limit` consecutive spawn failures auto-block a task
  [src: hermes-kanban]. [DOCUMENTED]
- Worker tool surface (enabled by `HERMES_KANBAN_TASK` env): `kanban_show`,
  `kanban_complete(summary, metadata, result, artifacts)`, `kanban_block(reason, kind ∈
  dependency|needs_input|capability|transient)` (dependency blocks auto-resume; repeated
  same-kind blocks escalate to triage), `kanban_heartbeat`, `kanban_comment`,
  `kanban_create`, `kanban_link`, `kanban_unblock` [src: hermes-kanban]. [DOCUMENTED]
- Structured handoff: each attempt is a `task_runs` row with `summary` (human) +
  `metadata` (JSON with convention keys: changed_files, verification, dependencies,
  blocked_reason, retry_notes, residual_risk); children read parents' latest run
  [src: hermes-kanban]. [DOCUMENTED]
- Auto-decomposition: `kanban.auto_decompose: true` — an `auxiliary.kanban_decomposer`
  model turns triage tasks into a JSON task graph against the profile roster; an
  orchestrator profile judges completion. Goal-mode cards run the Ralph loop per card
  [src: hermes-kanban]. [DOCUMENTED]
- `hermes kanban swarm "<goal>" --workers a,b,c --verifier r --synthesizer w` builds a
  one-shot root/blackboard graph: N parallel workers + verifier + synthesizer; the docs
  catalog fan-out, pipeline, voting/quorum, and human-in-the-loop patterns
  [src: hermes-kanban]. [DOCUMENTED]
- Multi-board isolation (separate DB/workspaces/logs per board), single-host by design
  (PID-based crash detection) [src: hermes-kanban]. [DOCUMENTED]

## 5. Subagent / multi-agent orchestration and model override

`delegate_task` spawns child `AIAgent` instances with isolated context, restricted
toolsets, and their own terminal sessions; only the final summary enters the parent's
context [src: hermes-delegation]. [DOCUMENTED]

- Call shape: `delegate_task(goal=…, context=…, toolsets=[…], max_iterations=…, role=…)`
  or `delegate_task(tasks=[…])` for a parallel batch [src: hermes-delegation]. [DOCUMENTED]
- Children start with a **completely fresh conversation** — zero parent history; the
  parent must pass everything in `goal`/`context` [src: hermes-delegation]. [DOCUMENTED]
- Parallelism: default 3 concurrent children (`delegation.max_concurrent_children`, env
  `DELEGATION_MAX_CONCURRENT_CHILDREN`, floor 1, no hard ceiling); oversize batches
  return a tool error rather than truncate; results sorted to input order; interrupting
  the parent interrupts all children [src: hermes-delegation]. [DOCUMENTED]
- Depth: flat by default (`delegation.max_spawn_depth: 1`); `role="orchestrator"`
  children retain the `delegation` toolset when depth is raised (2 = grandchildren, 3+
  deeper); `delegation.orchestrator_enabled: false` is a global kill switch. Documented
  cost warning: depth 3 × concurrency 3 = up to 27 concurrent leaves
  [src: hermes-delegation]. [DOCUMENTED]
- Blocked toolsets for children: `delegation` (leaf only), `clarify` (no user
  interaction), `memory` (no shared-memory writes), `code_execution`; orchestrator
  children regain only `delegation` [src: hermes-delegation]. [DOCUMENTED]
- **Model override is config-level, not per-call**: `delegation.model` +
  `delegation.provider` (or `base_url`/`api_key`/`api_mode`) route ALL subagents to one
  alternate model; "if omitted, subagents use the same model as the parent". No
  documented per-call model parameter on `delegate_task`
  [src: hermes-delegation]. [DOCUMENTED — absence noted as a port constraint in §11]
- Budgets/timeouts: per-child `max_iterations` (default 50); **no wall-clock timeout by
  default** (`delegation.child_timeout_seconds: 0`, opt-in hard cap, floor 30s); a
  heartbeat staleness monitor catches wedged children; zero-API-call timeouts write a
  structured diagnostic log [src: hermes-delegation]. [DOCUMENTED]
- Durability: `background=true` children survive the parent turn but not process restart;
  completed-but-undelivered results are restored from `state.db` after restart via a
  durable claim; interrupted children return `status="interrupted"`. Docs point to cron
  or `terminal(background=True)` for durable execution — or kanban (§4) for resumable
  multi-agent work [src: hermes-delegation] [src: hermes-kanban]. [DOCUMENTED]
- Observability: `/agents` overlay (TUI) shows a live tree of subagents grouped by
  parent, per-branch cost/token/file rollups, kill/pause per child, post-hoc replay
  [src: hermes-delegation]. [DOCUMENTED]
- Children inherit the parent's API key, provider config, and credential pool
  [src: hermes-delegation]. [DOCUMENTED]
- There is no named-agent-definition system (no `.claude/agents/*.md` analog): subagents
  are ad-hoc goal/context/toolsets bundles; durable role identity lives in kanban
  *profiles* instead (own HERMES_HOME, config, model, memory, skills)
  [src: hermes-kanban] [src: hermes-arch]. [INFERRED from the documented delegate_task
  surface + kanban profile design]

## 6. Session, persistence, isolation

- Session store: SQLite at `~/.hermes/state.db` (WAL), source `hermes_state.py`; tables
  `sessions`, `messages`, `messages_fts` (FTS5 over content + tool_name + tool_calls),
  `messages_fts_trigram`, `state_meta` K/V, `schema_version` (currently v21)
  [src: hermes-session-storage]. [DOCUMENTED]
- `sessions` carries lineage (`parent_session_id` — compression creates child sessions),
  source tagging (`cli`, `telegram`, …), and full token/cost accounting columns
  (`input_tokens`, `cache_read_tokens`, `estimated_cost_usd`, `pricing_version`, …)
  [src: hermes-session-storage]. [DOCUMENTED]
- Write contention is engineered: 1s SQLite timeout + app-level retry with 20–150ms
  jitter up to 15 retries, `BEGIN IMMEDIATE`, PASSIVE WAL checkpoint every 50 writes
  [src: hermes-session-storage]. [DOCUMENTED]
- `session_search` is an agent-callable FTS5 tool with source/role filters and
  match-marked snippets — the agent queries its own past conversations
  [src: hermes-session-storage] [src: hermes-tools-user]. [DOCUMENTED]
- Memory: `MEMORY.md` / `USER.md` flushed before context loss, frozen snapshots in the
  volatile prompt tier; pluggable memory providers (e.g. Honcho dialectic user modeling),
  single-select via `memory.provider` [src: hermes-prompt-assembly]
  [src: hermes-plugins]. [DOCUMENTED]
- Profile isolation: `hermes -p <name>` gives each profile its own HERMES_HOME (config,
  memory, sessions, skills, gateway PID); profiles run concurrently
  [src: hermes-arch] [src: hermes-config]. [DOCUMENTED]
- Execution isolation: six terminal backends — local, Docker, SSH, Singularity, Modal,
  Daytona. Docker: one persistent hardened container per Hermes process (`--cap-drop
  ALL`, `no-new-privileges`, `--pids-limit 256`, read-only root, `--network=none`
  option, explicit env allowlist `docker_forward_env`); remote backends sync modified
  files back to `~/.hermes/cache/remote-syncs/<session-id>/` on teardown
  [src: hermes-tools-user] [src: hermes-config]. [DOCUMENTED]
- Git worktrees are first-class: `hermes -w` creates a disposable worktree under
  `.worktrees/` with an isolated `hermes/hermes-<hash>` branch and runs the session
  inside it (clean worktrees removed on exit, dirty kept); `worktree: true` in config is
  the permanent equivalent; `worktree_sync: true` branches from the fetched remote tip;
  `.worktreeinclude` copies gitignored files in. Parallel agents = multiple terminals
  each running `hermes -w`; kanban `worktree` workspaces give the same isolation per
  task [src: hermes-worktrees] [src: hermes-kanban]. [DOCUMENTED]
- Checkpoints: each worktree gets its own Checkpoint Manager history for `/rollback`
  (shadow repo keyed by worktree path, data under `~/.hermes/checkpoints/`); config
  `checkpoints.{enabled: false, max_snapshots: 20}` [src: hermes-worktrees]
  [src: hermes-config]. [DOCUMENTED]

## 7. Extension model

### Skills (agentskills.io-compatible)

- Skills are on-demand knowledge docs with progressive disclosure: `skills_list()` →
  name/description/category index (~3k tokens in prompt); `skill_view(name)` → full
  SKILL.md; `skill_view(name, path)` → reference file. Source of truth `~/.hermes/skills/
  <category>/<skill>/SKILL.md` + optional `references/`, `templates/`, `scripts/`,
  `assets/`; explicitly "compatible with the agentskills.io open standard"
  [src: hermes-skills]. [DOCUMENTED]
- Every installed skill is automatically a slash command (`/skill-name args`; up to 5
  stack in one message) [src: hermes-skills]. [DOCUMENTED]
- Frontmatter: `name`, `description`, `version`, `platforms`, `category`,
  `requires_toolsets`/`requires_tools` (hide when unavailable),
  `fallback_for_toolsets`/`fallback_for_tools` (hide when the real tool IS available),
  `metadata.hermes.config` (declared config keys stored under `skills.config.*`),
  `required_environment_variables`, `required_credential_files` (auto-mounted read-only
  into sandboxes), `metadata.hermes.blueprint` (cron suggestion)
  [src: hermes-skills] [src: hermes-creating-skills]. [DOCUMENTED]
- External skill dirs: `skills.external_dirs: [~/.agents/skills, …]` — fully integrated
  (prompt index + slash commands), local dir wins collisions [src: hermes-skills]. [DOCUMENTED]
- Skills Hub: sources include `official`, agentskills directory, `/.well-known/skills/`
  convention, GitHub taps (defaults: openai/skills, anthropics/skills,
  huggingface/skills, NVIDIA/skills), Claude-compatible marketplace manifests, direct
  URL. All installs are security-scanned (exfiltration, prompt injection, destructive
  commands); provenance in `skills/.hub/lock.json` (source URL, content hash, scanner
  version, findings); trust ladder builtin > official > trusted > community
  [src: hermes-skills]. [DOCUMENTED]
- Agent-editable: `skill_manage` (create/patch/edit/delete/write_file/remove_file); the
  agent creates skills after complex tasks; `skills.write_approval: true` stages writes
  under `~/.hermes/pending/skills/` for human review; `/learn <anything>` authors a
  skill from dirs/URLs/conversation [src: hermes-skills]. [DOCUMENTED]

The learning loop closes with the **curator**: usage telemetry per skill
(`~/.hermes/skills/.usage.json` — use/view/patch counts), lifecycle `active → stale
(30d) → archived (90d)`, opt-in LLM consolidation pass, tar.gz snapshots + rollback
before every mutating run, pinning, per-run `run.json`/`REPORT.md` receipts. Trigger
discipline: 7-day interval + 2h idle gate, first run deferred a full interval, dry-run
mode, never auto-deletes. Only skills created by the background self-improvement review
fork (write origin `background_review` via `tools/skill_provenance.py`, ~every 10 agent
turns) count as agent-created; foreground creates are user-directed and exempt
[src: hermes-curator]. [DOCUMENTED]

### Plugins

- Plugin = `~/.hermes/plugins/<name>/` with `plugin.yaml` + `__init__.py` exposing
  `register(ctx)`. Discovery: bundled (repo `plugins/`), user (`~/.hermes/plugins/`),
  project (`.hermes/plugins/`), pip entry points
  (`[project.entry-points."hermes_agent.plugins"]`). Plugins are opt-in
  (`hermes plugins enable` / `plugins.enabled`) [src: hermes-plugins]. [DOCUMENTED]
- Context API: `register_tool(…, override=True to shadow builtins)`,
  `register_hook(event, callback)`, `register_command` (slash), `register_cli_command`
  (`hermes <plugin>` subcommand tree), `register_skill` (namespaced read-only),
  `register_platform`, `register_memory_provider`, `register_context_engine`,
  image/video/web-search/browser/secret-source providers, and
  `ctx.dispatch_tool(name, args)` which routes through the normal
  approval/redaction/budget pipelines [src: hermes-plugins]. [DOCUMENTED]
- Handler contract: `def handler(args: dict, **kwargs) -> str` — return JSON string,
  never raise; a crashing `register()` disables the plugin without crashing Hermes
  [src: hermes-plugins]. [DOCUMENTED]
- Manifest declares `requires_env` (missing vars disable gracefully; install prompts and
  saves to `.env`) and `kind` (`platform`, `model-provider`, `backend`, exclusive memory
  providers) [src: hermes-plugins]. [DOCUMENTED]

### Hooks (three systems, all non-blocking on error)

- **Plugin hooks** (in-process Python, CLI + gateway) and **shell hooks** (`hooks:` block
  in config.yaml, any language, subprocess JSON stdin/stdout) share one `invoke_hook()`
  dispatcher; Python hooks run first; first valid block wins. **Gateway hooks**
  (`HOOK.yaml` + `handler.py` under `~/.hermes/hooks/<name>/`) cover gateway lifecycle
  events [src: hermes-hooks]. [DOCUMENTED]
- Event surface: `pre_tool_call` (→ `{"action": "block", "message": …}` vetoes the
  call), `post_tool_call`, `pre_llm_call` (→ `{"context": …}` injected into the current
  user message — never the system prompt, preserving prompt cache; 10k-char cap with
  spill files), `post_llm_call`, `pre_verify` (fires when the agent edited code this
  turn; can force continuation; bounded by `agent.max_verify_nudges`, default 3),
  session lifecycle (`on_session_start/end/finalize/reset`), `subagent_start`/
  `subagent_stop` (observers), `pre_gateway_dispatch` (skip/rewrite/allow inbound
  messages), `pre_approval_request`/`post_approval_response` (observers),
  `transform_tool_result`/`transform_terminal_output`/`transform_llm_output` (rewrite
  surfaces), kanban task lifecycle events [src: hermes-hooks]
  [src: hermes-plugins]. [DOCUMENTED]
- **Claude Code compatibility is explicit**: shell-hook block responses accept the
  Claude-Code Stop shape `{"decision": "block", "reason": …}` alongside the
  Hermes-canonical `{"action": "block", "message": …}`, and Claude Code's
  `UserPromptSubmit` deliberately maps to `pre_llm_call`. Shell hook config supports
  per-hook `matcher` regex (pre/post_tool_call), 60s default timeout, JSON payload
  `{hook_event_name, tool_name, tool_input, session_id, cwd, extra}`
  [src: hermes-hooks]. [DOCUMENTED]
- Consent: first-use prompt per `(event, command)` pair persisted to
  `~/.hermes/shell-hooks-allowlist.json`; unattended runs need `--accept-hooks`,
  `HERMES_ACCEPT_HOOKS=1`, or `hooks_auto_accept: true` or hooks silently stay
  unregistered; `hermes hooks doctor` flags script mtime drift
  [src: hermes-hooks]. [DOCUMENTED]

### MCP

- Config under `mcp_servers.<name>` in config.yaml: stdio (`command`/`args`/`env`) or
  HTTP (`url`/`headers`); OAuth with discovery/DCR/PKCE/refresh (tokens at
  `~/.hermes/mcp-tokens/`, 0600); mTLS client certs; idle/lifetime recycling for stdio
  [src: hermes-mcp]. [DOCUMENTED]
- Tools register prefixed `mcp_<server>_<tool>`; each server becomes a runtime toolset
  `mcp-<server>`; `tools.include`/`exclude` filtering; `/reload-mcp` plus automatic
  re-registration on `notifications/tools/list_changed`; stdio servers get only explicit
  env + a safe baseline, not the full shell env [src: hermes-mcp]. [DOCUMENTED]
- Curated catalog (`hermes mcp install <name>`, Nous-reviewed manifests in repo
  `optional-mcps/`); MCP sampling supported with per-server caps; and Hermes can run AS
  an MCP server (`hermes mcp serve`) exposing 10 messaging-bridge tools
  [src: hermes-mcp]. [DOCUMENTED]

## 8. Config and auth topology

- `~/.hermes/` layout: `config.yaml`, `.env` (secrets), `auth.json` (OAuth creds),
  `SOUL.md`, `memories/` (MEMORY.md, USER.md), `skills/`, `cron/`, `sessions/`, `logs/`
  [src: hermes-config]. [DOCUMENTED]
- Precedence: CLI args > `config.yaml` > `.env` > built-in defaults; `hermes config set`
  auto-routes API keys to `.env` and everything else to `config.yaml`; `${VAR}`
  substitution inside config values [src: hermes-config]. [DOCUMENTED]
- Managed scope (org deployments) sits above all of it for pinned keys
  [src: hermes-managed-scope]: `/etc/hermes/config.yaml` and `/etc/hermes/.env` beat
  user files, defaults, and shell env — the one place env vars do NOT win. [DOCUMENTED]
- Provider resolution is a shared runtime resolver used by CLI, gateway, cron, ACP, and
  auxiliary calls: maps `(provider, model)` → `(api_mode, api_key, base_url)`; 18+
  providers, OAuth flows, credential pools (per-provider strategies: fill_first,
  round_robin, least_used, random), alias resolution [src: hermes-arch]
  [src: hermes-config]. [DOCUMENTED]
- Nous Portal is the bundled subscription path: `hermes setup --portal` wires OAuth, the
  provider, and a Tool Gateway (Firecrawl search, FAL image gen, OpenAI TTS, Browser Use
  cloud browser) under one subscription; per-backend opt-out, BYO keys always possible
  [src: hermes-readme]. [DOCUMENTED]
- Auxiliary model slots (`auxiliary.<task>.{provider, model, base_url, timeout,
  reasoning_effort, fallback_chain}`) cover vision, compression, approval,
  title_generation, goal_judge, kanban_decomposer, triage_specifier, curator,
  background_review, monitor, MoA reference/aggregator — every side-task independently
  routable to a cheaper model; `auto` = main chat model [src: hermes-config]
  [src: hermes-goals]. [DOCUMENTED]
- Reasoning control: `agent.reasoning_effort` (none→ultra ladder) with per-model
  overrides and per-session `/reasoning`; model hot-swap everywhere via `/model`
  (`hermes_cli/model_switch.py`) [src: hermes-config]
  [src: hermes-prog-integration]. [DOCUMENTED]

## 9. Programmatic integration surfaces

Three external protocols, all driving the same `AIAgent`
[src: hermes-prog-integration]. [DOCUMENTED]

| Surface | Transport | Notes [src: hermes-prog-integration] |
| --- | --- | --- |
| ACP (`hermes acp`) | JSON-RPC/stdio | VS Code, Zed, JetBrains; sessions, streaming, tool-call events, permission requests, fork, cancel |
| TUI gateway (`tui_gateway/server.py`) | JSON-RPC/stdio or WebSocket | Full control-plane: `prompt.submit`, `session.steer`, `session.branch`, `approval.respond`, `clarify.respond`, `sudo.respond`, `command.dispatch`, `delegation.status`, `subagent.interrupt`, `spawn_tree.save/list/load` |
| API server | HTTP + SSE | OpenAI-compatible `/v1/chat/completions` and `/v1/responses`, plus a run-lifecycle API: `POST /v1/runs`, `GET /v1/runs/{id}/events` (SSE), `POST /v1/runs/{id}/approval`, `POST /v1/runs/{id}/stop`, `GET /v1/capabilities`; session headers `X-Hermes-Session-Id`/`X-Hermes-Session-Key` |

In-process Python embedding is `import run_agent.AIAgent` directly
[src: hermes-prog-integration]. [DOCUMENTED]

## 10. Augmentation-surface table (muster-for-Hermes)

How each surface muster rides on Claude Code maps onto Hermes
[src: hermes-skills] [src: hermes-hooks] [src: hermes-delegation] [src: hermes-kanban]:

| muster surface (Claude Code today) | Hermes equivalent | Fit |
| --- | --- | --- |
| Skills (`SKILL.md` plugin skills) | agentskills.io-compatible skills; `skills.external_dirs`; hub tap (`hermes skills tap add <repo>`) | **Direct** — muster's skills are already SKILL.md; distribution via a tap or external dir |
| Slash commands (`/muster:go`) | every skill is a slash command; plugin `register_command`; `quick_commands` | **Direct** |
| Hook gates (PreToolUse deny) | `pre_tool_call` block hooks — shell hooks accept the Claude-Code `{"decision":"block","reason"}` shape verbatim [src: hermes-hooks]; `approvals.deny` globs for hard denies | **Direct** — muster's existing hook scripts port nearly unchanged; consent allowlist needs `--accept-hooks` in unattended runs |
| CLAUDE.md / AGENTS.md run charter | `.hermes.md` > `AGENTS.md` > `CLAUDE.md` first-match-wins | **Direct** — muster's AGENTS.md is already honored; `.hermes.md` wins if present |
| muster deterministic CLI (`npx @adnova-group/muster`) via Bash | `terminal` tool (Node.js bundled by the installer on the local backend) | **Direct** on local backend; container backends need Node in the image |
| Subagent fan-out (Agent tool, parallel waves) | `delegate_task` batches (3 concurrent default, configurable); `role="orchestrator"` + `max_spawn_depth: 2` for wave-of-waves | **Good** — flat by default; depth is one config key |
| Named agent roles + per-call model override | none on `delegate_task` (config-global `delegation.model` only); durable roles = kanban **profiles** (own config/model/memory/skills per profile) | **Partial** — per-role model routing rides kanban profiles, not in-session delegation |
| Worktree isolation per wave/item | `hermes -w`, `worktree: true`, kanban `worktree` workspaces + Checkpoint Manager `/rollback` | **Direct** |
| Run STATE / receipts / coordination protocol (CLAIM, RECEIPTS, BLOCKED, heartbeat LEDGER) | kanban: atomic claims, `task_runs` structured handoff metadata, `kanban_block(kind)` with auto-resume, `kanban_heartbeat`, append-only `task_events` | **Direct and native** — kanban is muster's coordination protocol already implemented as harness machinery |
| Backlog batch runs (`/muster:go-backlog`, runner mode) | kanban dispatcher + dependency links + auto-decompose; cron for the standing runner | **Direct** |
| Success criteria + verification gates | `/goal` completion contracts (`outcome`/`verification`/`constraints`/`stop_when`), `pre_verify` hook, goal-mode kanban cards | **Good** — judge-based, fail-open; muster's code-over-model gates should still ride `pre_tool_call`/CLI checks |
| Review-gate fan-out / tournaments | `delegate_task` batch; `kanban swarm --workers … --verifier … --synthesizer` | **Good** — swarm gives the scaffold; muster's `tally`/`fuse` CLI stays the deterministic judge plumbing |
| Interview / AskUserQuestion | `clarify` tool (CLI prompt or gateway interactive message); blocked for subagents | **Partial** — orchestrator-level only, no structured multi-choice UI documented |
| Plan mode (blocking approve-first) | `/plan` built-in skill; no documented blocking plan-approval mode | **Partial** — approve-first must be enforced by muster's own skill flow + clarify |

## 11. Verdict — is Hermes a muster harness target?

**Yes — first-class.** [INFERRED from everything above] Hermes is a real harness (not a
model): a tool-calling agent loop with skills, hooks, MCP, subagents, worktrees, cron,
and a durable multi-agent queue, at 215k stars [UNVERIFIED-SUSPECT — implausibly high for
a v0.18.2 project, needs verification against the live repo] and weekly-release velocity
[src: gh-api].
It is unusually well-shaped for muster because three of muster's load-bearing surfaces
exist natively and two of them are Claude-Code-compatible on purpose:

1. **Skills port near-verbatim.** Hermes speaks agentskills.io SKILL.md, reads AGENTS.md
   and even CLAUDE.md, and can consume muster's skills via an external dir or a GitHub
   tap [src: hermes-skills] [src: hermes-prompt-assembly]. [DOCUMENTED]
2. **Hooks port near-verbatim.** Shell hooks take JSON on stdin and accept Claude Code's
   block-decision shape; `UserPromptSubmit` maps to `pre_llm_call`
   [src: hermes-hooks]. [DOCUMENTED]
3. **Kanban ≈ muster's coordination protocol, natively.** Claims, receipts, blocked-with-
   question, heartbeats, and an append-only event ledger are built in
   [src: hermes-kanban]; muster's coordination skill would gain a fourth binding
   (kanban) beside GitHub issues, backlog.md, and Linear. [INFERRED]

**What a muster-for-Hermes port would ride** (in order): (a) muster's skills shipped as
a Hermes skills tap/external dir — slash commands come free [src: hermes-skills]; (b) a
thin `muster` Hermes plugin (Python shim shelling to `npx @adnova-group/muster`)
registering `register_cli_command` + `pre_tool_call` gate hooks + the run-charter skill
[src: hermes-plugins]; (c) `delegate_task` with `max_spawn_depth: 2` for in-session
waves/tournaments [src: hermes-delegation]; (d) kanban boards + profiles for durable
backlog runs, per-role model routing, and the coordination protocol
[src: hermes-kanban]; (e) cron for the standing runner; (f) `/goal` completion contracts
to encode each item's success criteria [src: hermes-goals]; (g) `hermes -w` / kanban
worktree workspaces for isolation [src: hermes-worktrees]. [INFERRED]

**Port constraints to design around:** no per-call model override on `delegate_task`
(per-role model routing degrades to one subagent model in-session — use kanban profiles
when role-model routing matters) [src: hermes-delegation]; subagents cannot `clarify`
(muster's advisor escalation must stay orchestrator-mediated, which matches its
advice-request design) [src: hermes-delegation]; the approval model is
dangerous-pattern-based and permissive by default (muster's enforcement must be added as
hooks + `approvals.deny`, and unattended runs must pre-accept the shell-hook consent
gate) [src: hermes-tools-runtime] [src: hermes-hooks]; the plugin surface is Python
while muster is Node (the shim stays thin; all judgment stays in muster's CLI and
skills). [INFERRED]

One cultural note: Hermes has its own opinionated self-improvement loop (agent-created
skills + curator). A muster port should pin or namespace its skills so the curator and
`skill_manage` never mutate them — bundled/hub skills are already exempt from curation,
and hand-written skills are not curated, but pinning is the documented belt-and-braces
[src: hermes-curator]. [DOCUMENTED]

## 12. Sourcing gaps

- Every internals claim is docs-sourced ([DOCUMENTED]), not verified against the Python
  source: no local checkout was made. The developer guide is unusually specific (file
  names, constants, schema versions), so confidence is high, but defaults and numbers
  can drift with the weekly release cadence (docs are "current"-channel Docusaurus;
  release v0.18.2 at research time) [src: gh-api]. [AMBIGUOUS risk, low]
- The absence of a per-call model parameter on `delegate_task` is inferred from the
  delegation page's config-only override section, not from reading
  `tools/delegate_tool.py` [src: hermes-delegation]. [INFERRED]
- Not scraped (lower relevance or time): checkpoints-and-rollback detail page, ACP
  internals, gateway internals, memory page, mixture-of-agents, batch-processing,
  provider-runtime detail, tool-gateway, TUI page. Section 6's checkpoint facts come
  from the worktrees + configuration pages only [src: hermes-worktrees]
  [src: hermes-config].
- No hands-on run: Hermes is not installed locally [src: local-env-check], so no claim
  here is behavior-verified; a follow-up spike should install it, run `hermes -w`, a
  `delegate_task` batch, a kanban board, and a ported muster gate hook end-to-end.

## Sources

- hermes-home: https://hermes-agent.nousresearch.com/
- hermes-readme: https://github.com/NousResearch/hermes-agent (README.md, fetched 2026-07-16)
- gh-api: https://api.github.com/repos/NousResearch/hermes-agent (queried 2026-07-16)
- hermes-arch: https://hermes-agent.nousresearch.com/docs/developer-guide/architecture
- hermes-agent-loop: https://hermes-agent.nousresearch.com/docs/developer-guide/agent-loop
- hermes-tools-runtime: https://hermes-agent.nousresearch.com/docs/developer-guide/tools-runtime
- hermes-tools-user: https://hermes-agent.nousresearch.com/docs/user-guide/features/tools
- hermes-delegation: https://hermes-agent.nousresearch.com/docs/user-guide/features/delegation
- hermes-session-storage: https://hermes-agent.nousresearch.com/docs/developer-guide/session-storage
- hermes-prompt-assembly: https://hermes-agent.nousresearch.com/docs/developer-guide/prompt-assembly
- hermes-prog-integration: https://hermes-agent.nousresearch.com/docs/developer-guide/programmatic-integration
- hermes-goals: https://hermes-agent.nousresearch.com/docs/user-guide/features/goals
- hermes-curator: https://hermes-agent.nousresearch.com/docs/user-guide/features/curator
- hermes-managed-scope: https://hermes-agent.nousresearch.com/docs/user-guide/managed-scope
- hermes-skills: https://hermes-agent.nousresearch.com/docs/user-guide/features/skills
- hermes-creating-skills: https://hermes-agent.nousresearch.com/docs/developer-guide/creating-skills
- hermes-plugins: https://hermes-agent.nousresearch.com/docs/developer-guide/plugins
- hermes-hooks: https://hermes-agent.nousresearch.com/docs/user-guide/features/hooks
- hermes-mcp: https://hermes-agent.nousresearch.com/docs/user-guide/features/mcp
- hermes-config: https://hermes-agent.nousresearch.com/docs/user-guide/configuration
- hermes-kanban: https://hermes-agent.nousresearch.com/docs/user-guide/features/kanban
- hermes-worktrees: https://hermes-agent.nousresearch.com/docs/user-guide/git-worktrees
- local-history: /home/ryan/.claude/history.jsonl (user directive naming Hermes, timestamp 1784235033511)
- local-promptlint: /home/ryan/dev/muster/src/prompt-lint.js:14
- local-codex-session: /home/ryan/.codex/sessions/2026/07/13/rollout-2026-07-13T00-51-53-019f59d1-3fcb-7322-bd9d-89f23d07f8b1.jsonl
- local-env-check: shell checks run 2026-07-16 (`ls ~/.hermes`, `which hermes`, `rg -il hermes /home/ryan/dev`)
