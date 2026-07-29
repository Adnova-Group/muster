# Kimi Code CLI — harness internals, implementation-grade

Research for a candidate muster harness binding, gathered 2026-07-23 from Moonshot AI's own
docs (`www.kimi.com/code/docs`, `moonshotai.github.io/kimi-code`, `www.kimi-cli.com`), the
DeepWiki index of `MoonshotAI/kimi-cli`, PyPI, and the Moonshot Open Platform pricing pages.
Same frame as `codex-cli.md` and `hermes.md`: reduce the harness to the six primitives
`docs/binding-interface.md` defines (Dispatch, Ask, Enforce, Isolate, Receipts, Capability
scan), bind each to its exact Kimi mechanism, and state the degradation ladder. Capability tags
below use the `kc-` prefix, parallel to `cc-`/`cx-`/`hermes-` in
`docs/research/reference-harness-design.md`.

**Headline.** Of every non-Anthropic harness muster has evaluated, Kimi Code is the closest
structural clone of Claude Code — deliberately so. It ships `Agent`/`AgentSwarm` subagent
dispatch, a Claude-Code-format agent-`.md` loader, a near-1:1 hook lifecycle, an
`SKILL.md`-convention skill system, a plugin marketplace with a readable on-disk registry, and
even a built-in `/import-from-cc-codex` skill. Four of the six primitives bind **natively**;
only Isolate drops to the Codex floor, and Ask is native-shaped-but-narrow. The single real
friction for muster is model routing: gen2 has **no per-subagent model and no fast/router
tier** — the tier→model map resolves to one model per launch, not per role.

---

## 0. Two generations — keep them separate

`kimi` is the command name for **two distinct products from the same team**. Muster targets
gen2; gen1 is winding down but its docs are more complete on shared internals, so it is the
better source for how the agent loop actually works.

| | **Gen1 — `kimi-cli`** | **Gen2 — Kimi Code CLI (`kimi-code`)** |
|---|---|---|
| Language | Python ≥3.12 | TypeScript on Node.js ≥22.19 |
| Distribution | PyPI `kimi-cli` (v1.49.0, 2026-07-16); `uv tool install`; PyInstaller binaries | npm `@moonshot-ai/kimi-code`; `curl …/install.sh \| bash`; PS1 on Windows |
| Command | `kimi` (alias `kimi-cli`) | `kimi` |
| Data root | `~/.kimi/` (`KIMI_SHARE_DIR`) | `~/.kimi-code/` (`KIMI_CODE_HOME`) |
| Built on | `kosong` (LLM layer) + `pykaos` (system layer) | `pi` (earendil-works) — `pi-ai`/`pi-agent-core`/`pi-tui` *(inferred from stack; not named in a Moonshot-authored page)* |
| Status | winding down; auto-migrates config+sessions into gen2 | current |

"Single binary" for gen2 is a Node bundle + install script, not a compiled static binary. The
DeepWiki wiki titled "Kimi Code CLI" actually documents the **Python gen1** (indexed 2026-04-26)
— treat its internals as gen1 truth, gen2 as an analogous re-implementation on `pi`.

**One service, three surfaces, one quota.** CLI + VS Code extension + third-party clients (incl.
Claude Code) all draw on a single Kimi-membership quota that refreshes every 7 days on a rolling
5-hour rate window. This matters for muster the way Codex's shared-pool burn does: a muster run
that fans out subagents spends the *user's* Kimi quota, not a separate API budget.

---

## 1. The base agent loop (`kc-loop`)

Gen1 is documented concretely (DeepWiki); gen2 mirrors it on `pi-agent-core`.

- **`KimiSoul`** implements a `Soul` protocol as nested **Turn → Agent Loop → Step**. `_step()`
  runs one streamed LLM inference wrapped in `tenacity` retry (backoff on
  connection/status/timeout, `max_retries_per_step`). `_agent_loop()` loads MCP tools, pipes
  approvals, iterates to completion or a step cap.
- **Steer**: user interjections queue in `_steer_queue` and inject *between steps* without
  ending the turn (TUI `Ctrl-S`; Wire `steer`; ACP mid-turn). Muster's "inject correction
  without restarting" pattern has a native seam here.
- **D-Mail / BackToTheFuture**: checkpoint-revert that re-injects an edited past as a system
  message — native context-rollback muster does not have on any current harness.
- **Compaction** is model-internal, auto-triggered at `context_tokens + reserved >=
  max_context_size` or `>= max_context_size * compaction_trigger_ratio` (gen1 default 0.85).
  There is **no separate summarizer/router model** — compaction uses the main model.

---

## 2. Models and the reasoning ladder (`kc-models`)

Provider-agnostic by construction (kosong / pi-ai drive Kimi, OpenAI legacy+Responses,
Anthropic, Google GenAI/Vertex behind one interface). Current Moonshot catalog
(`api.moonshot.ai`, intl / `api.moonshot.cn`, CN):

| Model id | Context | Thinking | API $/M in → out | Note |
|---|---|---|---|---|
| `kimi-k3` | **1,048,576 (1M)** | always-on | $3.00 → $15.00 (cache-in $0.30) | flagship, 2026-07-16 |
| `kimi-k2.7-code` | 262,144 | toggle | $0.95 → $4.00 (cache-in $0.19) | dedicated coding, multimodal |
| `kimi-k2.6` | 262,144 | toggle | $0.95 → $4.00 | general, open-weight (self-hostable) |
| `kimi-k2.5` | 262,144 | shared | $0.60 → $3.00 | value tier |
| `kimi-k2` (legacy) | 131,072 | — | $0.60 → $2.50 | |
| `moonshot-v1-*`, `kimi-latest` | 8k/32k/128k | — | — | classic gen, **sunset ~2026-08-31** |

Reasoning is a per-model **capability/effort toggle**, not a separate model id: capabilities are
a union set `thinking / always_thinking / image_in / video_in / audio_in / tool_use`; effort
ladder `low / medium / high / xhigh / max` via `[thinking].effort` or `KIMI_MODEL_THINKING_EFFORT`.

**Subscription vs API key.** Kimi Code is bundled into Kimi membership (quota, not per-token):
Moderato $19 / Allegretto $39 / Allegro $99 / Vivace $199 monthly, at 1× / 5× / 15× / 30×
"Kimi Code credits." API-key billing is the per-token table above. Which tier unlocks K3 vs
K2.7 is not published.

**Reverse path — Claude Code (and muster) driving Kimi models.** Confirmed end-to-end:
```sh
export ANTHROPIC_BASE_URL="https://api.moonshot.ai/anthropic"
export ANTHROPIC_AUTH_TOKEN="<MOONSHOT_API_KEY>"
export ANTHROPIC_MODEL="kimi-k3[1m]"          # or kimi-k2.7-code, kimi-k2.6
export ENABLE_TOOL_SEARCH="false"             # endpoint has no tool-search
export CLAUDE_CODE_AUTO_COMPACT_WINDOW="1048576"   # K3's 1M window
```
So muster-on-Claude-Code can already *use Kimi as its model* today with zero Kimi-CLI binding —
distinct from binding Kimi Code as a *harness*. Two different integrations; don't conflate them.

---

## 3. `config.toml` — the configuration system (`kc-config`)

Gen2: single **user-level** `~/.kimi-code/config.toml` (TOML; relocate with `KIMI_CODE_HOME`;
validate via `kimi doctor config`). Companion `~/.kimi-code/tui.toml` for theme/editor/notify.

**There is no project-level `config.toml` override** — stated verbatim in the docs. Per-project
isolation is only by pointing `KIMI_CODE_HOME` at a different dir. But two project-local files
*do* exist and merge:
- `<repo>/.kimi-code/local.toml` — currently only `[workspace] additional_dir = [...]` (written
  by `/add-dir`; recommend `.gitignore`).
- `<repo>/.kimi-code/mcp.json` — project MCP servers, **merged** with the user `mcp.json`.

Top-level schema (gen2):
```
default_model              string   → must name a [models.<alias>]
default_permission_mode    "manual" | "yolo" | "auto"   (default manual)
default_plan_mode          bool
extra_skill_dirs / extra_agent_dirs   array<string>
merge_all_available_skills bool     telemetry bool
[providers.<name>]  type=kimi|anthropic|openai|openai_responses|google-genai|vertexai
                    base_url  api_key  env{}  custom_headers{}  oauth{}
[models.<alias>]    provider  model  max_context_size  capabilities[]  support_efforts[]
                    default_effort  display_name  reasoning_key(openai)  adaptive_thinking(anthropic)
                    [models."<alias>".overrides]  ← value fields survive catalog refresh; identity fields rejected
[thinking]     enabled effort keep          [loop_control] max_steps_per_turn max_retries_per_step reserved_context_size
[background]   max_running_tasks print_background_mode="steer"|"drain"|"exit" …
[subagent]     timeout_ms (default 7_200_000 = 2h)
[tools]        enabled[]  disabled[]         ← global tool gating, glob-matched
[permission]   [[permission.rules]]          ← see §4
[[hooks]]      event matcher command timeout ← see §4
```
MCP servers live in a **separate `mcp.json`**, not in `config.toml`.

---

## 4. Enforce — hooks + declarative permission rules (`kc-hooks`, `kc-permrules`)

Kimi's enforcement surface is **stronger than Claude Code's**: a hook lifecycle that is nearly
identical to Claude Code's, *plus* a config-level declarative deny that no hook is needed for.

### 4.1 Lifecycle hooks (`kc-hooks`) — near-1:1 with Claude Code

`[[hooks]]` array in `config.toml`; each rule is `{event, matcher(regex, optional), command,
timeout(1–600s, default 30)}`. Only those four fields; extras fail the load. Contract:

- Event details are packaged as JSON on **stdin**: `{hook_event_name, session_id, cwd, …}` plus
  event-specific fields (`tool_input.command`, tool name). snake_case throughout.
- Response by **exit code**: `0` allow (stdout may append to context), `2` block (stderr is the
  block reason), any other non-zero or timeout/crash → **fail-open (allow)**. Or block via stdout
  JSON `{"hookSpecificOutput":{"permissionDecision":"deny","permissionDecisionReason":"…"}}`.
- **Multiple matching rules run in parallel; identical `command` values run once** — the exact
  dedupe that the Codex hook-bombardment fight was about, native here.
- cwd = session project dir; non-Windows hooks get their own process group, SIGTERM-then-kill on
  timeout.

Event table — **the three blockable events are exactly muster's Enforce set**:

| Event | Matcher | Blockable | |
|---|---|---|---|
| `UserPromptSubmit` | submitted text | ✓ | returned text appended to context; block skips the turn |
| `PreToolUse` | tool name | ✓ | fires *before* permission checks; block prevents execution |
| `Stop` | (empty) | ✓ | block appends a message and lets the model continue |
| `PostToolUse` / `PostToolUseFailure` | tool name | — | observe |
| `PermissionRequest` / `PermissionResult` | tool name | — | observe |
| `SessionStart` (`startup`/`resume`) / `SessionEnd` | — | — | observe |
| `SubagentStart` / `SubagentStop` | subagent name | — | observe |
| `Interrupt` / `StopFailure` | — | — | observe (Interrupt fires when Stop can't) |
| `PreCompact` / `PostCompact` (`manual`/`auto`) | — | — | observe |
| `Notification` (e.g. `task.completed`) | notification type | — | observe |

Fail-open is explicit and documented as a reason **not** to treat hooks as the sole security
barrier — same advisory caveat muster already internalized from Codex, but weaker here than
Claude Code because even the blockable events sit behind a fail-open default.

### 4.2 Declarative permission rules (`kc-permrules`) — the harder deny

Independent of hooks, ordered first-match-wins:
```toml
[[permission.rules]]
decision = "allow" | "deny" | "ask"
pattern  = "Read"  |  "Bash(rm -rf*)"      # ToolName or ToolName(arg-glob); AgentSwarm/MCP/custom = name-only
scope    = "turn-override" | "session-runtime" | "project" | "user"   # default user
reason   = "…"
```
Plus global `[tools] enabled=[…] disabled=["mcp__github__*", …]` gating (enforced at
tool-list-shaping *and* re-checked before execution). Critically: **`deny` rules and `[tools]`
gating survive `--yolo` and `-p`** — a deterministic hard-deny that does not depend on a hook
firing. For muster's action-class fence this is a cleaner bind than a `PreToolUse` script:
express the forbidden classes as `deny` patterns in config, no fail-open gap.
**Implemented 2026-07-26** (`src/kimi-install.js`): `muster install kimi` emits exactly this — a
marker-delimited `[[permission.rules]]` deny block covering send/sign/submit/publish/purchase/
delete-remote over Bash globs + `mcp__*` name globs, merged non-destructively into `config.toml`.

Permission **modes**: `manual` (prompt each side-effecting call), `yolo`/`-y` (auto-approve
regular calls, still asks on sensitive files + plan-exit, agent may still ask questions), `auto`
(fully unattended, never asks). These map directly onto muster's attended vs Unattended(Routine)
branch — `auto` is the Routine floor.

---

## 5. Plugins, skills, marketplace — the distribution layer (`kc-registry`, `kc-skills`)

### 5.1 Plugins + the readable registry (Capability scan)

A plugin = a dir/zip with `kimi.plugin.json` (or `.kimi-plugin/plugin.json`). It bundles
**skills, MCP servers, slash commands, hooks, and a sessionStart skill** — *not* agents. Install
via `/plugins install <path|github-url>`, `/plugins marketplace`; GitHub URL forms resolve to
release/branch/tag/commit; only `github.com` + `codeload.github.com` are hit.

**The capability-scan bind:** `$KIMI_CODE_HOME/plugins/installed.json` records every installed
plugin, its enabled state, and per-server MCP enable/disable — a readable on-disk registry
exactly analogous to Claude Code's `installed_plugins.json` that `src/plugin-inventory.js`
already walks. Managed copies live at `plugins/managed/<id>/`. **Per-user scope only, no project
plugin scope yet.** Trust badges `kimi-official` / `curated` / `third-party`; any non-official
install prompts with **Cancel as default**.

Marketplace catalog defaults to `https://code.kimi.com/kimi-code/plugins/marketplace.json`,
overridable by `KIMI_CODE_PLUGIN_MARKETPLACE_URL` (accepts `http`/`file`/local path) — so muster
could publish its own catalog the way it does a Claude Code marketplace.

### 5.2 Skills — the `SKILL.md` convention, verbatim

`SKILL.md` (dir form, needs `name`+`description`) or flat `<name>.md`. Frontmatter `name`,
`description`, `type=prompt|inline|flow`, `whenToUse`, `disableModelInvocation`, `arguments`;
body placeholders `$ARGUMENTS`, `$0`, `${KIMI_SKILL_DIR}`. Discovery **Project > User > Extra >
Built-in**: `.kimi-code/skills/`, `.agents/skills/`, `~/.kimi-code/skills/`, `~/.agents/skills/`,
`extra_skill_dirs`, `--skills-dir`. Invoke `/skill:<name>`, shorthand `/<name>`, sub-skills
`/<parent>.<child>` (≤3 levels). This is the Anthropic Agent-Skills format — muster's builtin
`SKILL.md` payloads are portable with near-zero change. The `~/.agents/` lane is a cross-tool
home that does *not* move with `KIMI_CODE_HOME`, i.e. a shared skills/agents pool.

### 5.3 Custom slash commands

No standalone user `commands/` dir. Custom verbs come from **plugin `commands`** (Markdown +
frontmatter `{description, name?}`, `$ARGUMENTS`, namespaced `/<plugin>:<command>`) or from
**skills**. So muster's verbs land as either a plugin-bundled command set or a skill set.

---

## 6. Dispatch — subagents and swarms (`kc-subagents`)

Muster's strongest bind after hooks. Two dispatch tools, both model-invoked, both auto-allowed:

- **`Agent`** — params `prompt` (req), `description` (req, 3–5 words), `subagent_type` (default
  `coder`), `resume` (existing agent id; mutually exclusive with `subagent_type`),
  `run_in_background` (default false → parent waits; true → returns a task id, result delivered
  back as a synthetic user message). Nearly the Claude Code `Agent` signature.
- **`AgentSwarm`** — item-based fan-out from a `prompt_template` + `items[]` (and/or
  `resume_agent_ids`), one subagent per item, `subagent_type` for all. **≤128 subagents**, ramp
  **5 immediate then +1 every 700 ms, no default concurrency cap** (`KIMI_CODE_AGENT_SWARM_MAX_CONCURRENCY`
  to cap), aggregated report, must be the sole tool call in its response. This is a
  ready-made wave engine — muster's `sprint-waves` maps onto a swarm per wave.

Built-in subagents: **`coder`** (read/write/exec, full toolset, can maintain todos, enter Plan
mode, nest subagents), **`explore`** (read-only), **`plan`** (no shell, no write). Custom agents
are **Claude-Code-compatible `.md`**: frontmatter `name`, `description`, `whenToUse`, `override`,
`tools` (allowlist; MCP globs `mcp__github__*`; `[]`=none, omit/`*`=all), `disallowedTools`,
`subagents` (delegation allowlist); body = system prompt, template-rendered with `${base_prompt}`
and context vars. Discovery **Explicit(`--agent-file`) > Project(`.kimi-code/agents/`,
`.agents/agents/`) > Extra(`extra_agent_dirs`) > User(`~/.kimi-code/agents/`, `~/.agents/agents/`)
> Built-in**; `override:true` to replace a built-in. Docs state explicitly: the comma-separated
`tools` form keeps **Claude Code agent files loadable**, and Claude Code's `model` / OpenCode's
`mode` fields are **ignored** — so muster's `plugin/agents/muster-*.md` load almost as-is.

Return contract = the subagent's **final message is the whole handoff** ("only the final result
appears in the main Agent's context"; custom delegated agents lose the built-in framing, so the
body must say "your last message is the complete result") — muster's Return-contract discipline
already matches. **No documented size cap** on the handoff (unlike muster's 2000/1500-char
convention — muster's cap still applies as its own prose discipline).

**Two constraints muster must plan around:**
1. **~~No per-subagent model (gen2).~~ CORRECTED 2026-07-25 — there IS a per-agent model
   selector; it is just not Claude Code's field.** Claude Code's `model:` *is* ignored (that part
   held), but Kimi has its own: agent frontmatter takes **`model_preference: primary | secondary`**,
   where "`primary` selects the caller's main model, while `secondary` selects `[secondary_model]
   model`" — and `[secondary_model]` is "a second model pointer next to the primary
   `default_model`" in config.toml, with its own `model` **and `default_effort`**. An explicit
   tool-call `model` on `Agent`/`AgentSwarm` overrides both ("An explicit tool-call `model` wins").
   So Kimi gives **two models per launch, selectable per agent**, not one model per launch.
   Caveats: the feature is **experimental and off by default** (`KIMI_CODE_EXPERIMENTAL_SECONDARY_MODEL=1`
   under `kimi web`; `KIMI_CODE_EXPERIMENTAL_FLAG=1` under `kimi -p`), and **"The TUI currently
   ignores this field."** Critically, omission is not neutral: with a secondary model configured,
   an agent that omits `model_preference` **defaults to secondary** — so un-annotated judgment
   agents silently demote to the cheap lane. muster therefore stamps the field on every installed
   agent (§11.8). *This entry is the standing example of why this doc quotes primary sources: the
   original claim was asserted from memory and disproven by one reading of the agents page.*
2. **Nesting is version-contradictory.** Gen2 says `coder` can nest subagents (`subagents`
   allowlist); gen1 says only the root agent may use `Agent`. Assume gen2 nests, gen1 does not.

Runtime state persists to the session's `agents/<id>/wire.jsonl` + background `tasks/` — see §8.

---

## 7. Isolate — context-only, no sandbox (`kc-isolate`)

The one primitive that drops to the **Codex floor**. Subagent isolation is **context-window
only**: each has a fully independent context, cannot see the main history, and only its final
result flows back. There is **no git-worktree, no per-subagent cwd, and no OS sandbox** (no
Seatbelt/Landlock/container) documented anywhere; subagents share the project cwd. The security
model is approval-gate + workspace-scope (`--add-dir` extends it) + sensitive-file filtering
(`.env`, SSH keys, cloud creds always filtered from Read/Grep), and Bash runs **locally,
unsandboxed** (`--dangerous-bypass-auth` on `kimi web` removes even the server auth). Absence of
a sandbox is inferred from the enumerated model, not an explicit "there is none" statement.

**Degradation = exactly muster's Codex path:** muster supplies git worktrees itself
(`git worktree add .worktrees/<item-branch>` before dispatch, verify the branch/base from the
runner receipt), because Kimi's dispatch — like Codex's `spawn_agent` — carries no cwd/worktree
parameter to pin a subagent to. Isolation of the base checkout holds via git; only the
parallel-execution guarantee narrows if run sequentially.

---

## 8. Receipts — transcripts, todos, stream-json (`kc-receipts`)

Rich and machine-readable. Session tree under `~/.kimi-code/sessions/<workDirKey>/<sessionId>/`:
```
state.json                     title / lastPrompt / timestamps / forkedFrom
session_index.jsonl            (at home root) sessionId → sessionDir → workDir
agents/main/wire.jsonl         main transcript (prompts, message history, final state, tool schemas)
agents/main/plans/<id>.md      plan-mode plans
agents/<subagentId>/wire.jsonl per-subagent transcript
tasks/<task_id>.json + tasks/<id>/output.log   background tasks
logs/kimi-code.log             session log
```
Plus native **todo lists** inside subagents (the Receipts "task board" primitive, like Claude
Code's `TodoWrite`). Resume via `--continue`/`-c`, `--session [id]`/`-S`, hidden `-r`; TUI
`/sessions`, `/fork`. Programmatic transcript: **`kimi -p --output-format stream-json`** emits
one JSON object per stdout line (assistant → `tool_calls` → tool → assistant; thinking and tool
progress go to stderr). `kimi export <sessionId>` → ZIP; `kimi web` serves `GET /openapi.json`
+ `/asyncapi.json`.

**CONFIRMED 2026-07-27 (probe against the installed v0.29.1 binary; re-confirmed 2026-07-29
against the installed v0.30.0 binary — token usage lives in the wire files, NOT in stream-json).** Two real `kimi -p` runs from a scratch cwd (one trivial
prompt, one dispatching an `explore` subagent via the Agent tool):
- `kimi -p "Reply with exactly: ok" --output-format stream-json` stdout carried **no usage
  fields** — only `{"role":"assistant",...}` and `{"role":"meta","type":"session.resume_hint",...}`
  objects; stderr was empty.
- `agents/main/wire.jsonl` (and the subagent's own `agents/agent-0/wire.jsonl`) carried, per
  LLM step, both a `context.append_loop_event`/`step.end` event embedding `usage` and a
  top-level record of the exact shape:
  `{"type":"usage.record","model":"kimi-code/k3","usage":{"inputOther":3157,"output":24,
  "inputCacheRead":19200,"inputCacheCreation":0},"usageScope":"turn","time":1785118793157}`
  (one `usage.record` per step; `step.end` adds `turnId`/`step`/latency fields).
- Per-dispatch attribution is structural: `state.json`'s `agents` map records each agent's
  `type` (`main`|`sub`) and `parentAgentId`, so summing one subagent's wire `usage.record`s IS
  that dispatch's token consumption. Sample per-dispatch sums from the probe: the explore
  dispatch cost `{inputOther:2403, output:443, inputCacheRead:26624, inputCacheCreation:0}`.
  Parsed by `src/kimi-receipts.js`; trimmed real captures pinned in
  `test/fixtures/kimi-session-usage/` + `test/kimi-receipts.test.js`. Re-probed 2026-07-29 on
  v0.30.0 (one trivial run, one explore-dispatch run, two thinking-effort runs): all shapes
  unchanged — stream-json stdout still carries no usage fields, `usage.record` keeps the same
  four-field `usage` object, `state.json`'s agents map still records `type` + `parentAgentId`,
  and `llm.request` still carries the effective `thinkingEffort`. This is the verified
  per-call consumption mechanism `docs/fast-path-token-gap.md` records as absent in Claude
  Code and Codex — on Kimi the token-gap measurement is runnable.

**Degradation:** STATE.md + git notes are harness-agnostic and unchanged; the native-todo receipt
folds into STATE if absent — but it is present, so muster's task-board can bind to it, same as
Claude Code.

---

## 9. Ask, and the programmatic driving surfaces (`kc-approval`, `kc-acp`, `kc-wire`)

**Ask (`kc-approval`).** The TUI approval panel is structured (arrow keys or `1`/`2`/`3`,
"Approve for this session"), and Plan mode is an approve/reject/revise gate — both native, but
shaped around *tool approval*, not muster's arbitrary multi-choice `AskUserQuestion`. A true
question-elicitation channel exists only at the **protocol** layer: ACP `session/request_permission`
("shared channel for tool approval and question elicitation") and Wire `QuestionRequest` (gated
on `capabilities.supports_question`). So muster's `ask` degrades the way the binding-interface
already documents for a no-structured-UI harness: attended → conversational Q&A honoring the
one-question rule; unattended → `/auto` mode + record-the-gap-to-STATE default.

**How muster would actually drive Kimi non-interactively:**
- **`kimi -p "<prompt>" --output-format stream-json`** — one-shot, JSONL out, permission auto,
  static `deny` still enforced; exit `0` complete / `3` blocked / `6` paused. `--prompt` can't
  combine with `--yolo`/`--auto`/`--plan`. (`KIMI_CODE_EXPERIMENTAL_FLAG=1` + `--agent`/`--agent-file`
  to bind a custom main agent under `-p`.)
- **ACP (`kimi acp`, `kc-acp`)** — JSON-RPC over stdio; stable 10/12 agent-side: `initialize`,
  `authenticate`, `session/new` (create, accepts cwd + mcpServers), `session/load`/`resume`,
  `session/prompt` (streams `agent_message_chunk`), `session/cancel`, `session/list`,
  `session/set_mode`, `session/set_config_option`; reverse-RPC `session/update`,
  `session/request_permission`, `fs/read|write_text_file`. `session/set_model` exists but is
  unstable; `terminal/*` not implemented (shell stays local). This is the cleanest programmatic
  agent API — muster could drive Kimi through ACP the way it drives Cowork through MCP.
- **Wire (`kc-wire`, gen1 only)** — JSON-RPC-2.0 over stdio: `initialize` (declares
  `external_tools`, `hooks`, `supports_question`/`supports_plan_mode`), `prompt`, `steer`,
  `replay` (re-emit `wire.jsonl`), `set_plan_mode`, `cancel`; outbound `event`/`request` unions
  incl. `QuestionRequest`, `ApprovalRequest`, `HookRequest`, and **client-implemented
  `external_tools`** the agent can call back into — a genuine bidirectional orchestration hook.
  Gen2 replaces Wire with ACP + `kimi web`. `MoonshotAI/kimi-agent-rs` is a Rust Wire-only
  server (Kimi-provider-only).
- **MCP (`kc-mcp`)** — **client only**; Kimi is not an MCP server. `mcp.json` map form (`command`
  → stdio, `url` → http, `transport:"sse"` → sse), tool names `mcp__<server>__<tool>`, OAuth via
  `/mcp-config login`. ACP forwards IDE-supplied MCP servers into Kimi. So muster's cowork MCP
  tools attach to Kimi as a client the same way they do elsewhere.

---

## 10. How muster would ride Kimi Code — the six-primitive verdict

| Primitive | Claude Code | **Kimi Code CLI** | Tag | Fit |
|---|---|---|---|---|
| **Dispatch** | Agent + `subagent_type` | `Agent` + `AgentSwarm` (≤128), CC-format agent `.md` | `kc-subagents` | **native, superset** — but **one model per launch** |
| **Ask** | AskUserQuestion | approval panel + Plan mode; question elicitation only via ACP/Wire | `kc-approval` | native-shaped, narrow |
| **Enforce** | `hooks.json` ×3 | `[[hooks]]` (same 3 blockable, dedupes) **+ declarative `[[permission.rules]]` deny that survives yolo/-p** | `kc-hooks` `kc-permrules` | **native, stronger** |
| **Isolate** | git worktree/subagent | context-window only; no worktree, no sandbox | `kc-isolate` | **floor** (muster supplies worktrees) |
| **Receipts** | todo + git notes | native todos + `wire.jsonl` + `stream-json` + `state.json` | `kc-receipts` | **native** |
| **Capability scan** | `installed_plugins.json` | `plugins/installed.json` + `SKILL.md` + `mcp.json`, trust tiers | `kc-registry` `kc-skills` | **native** |

**What muster can utilize directly, little-to-no new code:**
- Agent `.md` files (its `plugin/agents/muster-*.md`) load as Kimi custom agents — `model` field
  ignored, everything else honored.
- `SKILL.md` builtins port as Kimi skills verbatim (Anthropic convention).
- The hook lifecycle takes muster's `PreToolUse`/`SessionStart`/`UserPromptSubmit` scripts with
  a stdin-contract shim (snake_case fields, exit 0/2) — and the action-class fence is better
  expressed as a `[[permission.rules]] deny` (no fail-open gap).
- Capability scan reads `plugins/installed.json` + `mcp.json` the way `readInstalled()` reads the
  Claude registry — a `readInstalledKimi()` sibling to `readInstalledCowork()`.
- `AgentSwarm` is a native wave engine for `sprint-waves`; `-p --output-format stream-json` or
  ACP is the headless driver.

**What muster must build or accept as a floor:**
- **Model routing (the real work).** No per-subagent model, no fast/router tier. muster's
  tier→model map resolves per *launch*: either run one Kimi model for a whole run, or spawn
  separate top-level `kimi` invocations per tier (heavier), or ride the unstable ACP
  `session/set_model`. This is the same class of constraint that the parked model-policy
  refactor was meant to make harness-portable — Kimi is the concrete second data point that a
  model-tier abstraction, not tier-names-are-model-names, is the right shape.
- **Worktrees** — supply them itself, exactly as on Codex (`kc-isolate` = `cx-subagents` floor).
- **Ask** — no arbitrary multi-choice tool; use ACP/Wire elicitation or degrade to prose + `/auto`.
- **Config injection** — gen2 ignores shell creds; write `default_model` + `[models.*]` +
  `[[permission.rules]]` into `~/.kimi-code/config.toml` (or `KIMI_CODE_HOME`-scoped copy), or use
  the `KIMI_MODEL_*` env family — the one sanctioned shell channel.

**Parked, not built (mirrors the Codex adapter's staging):** a Kimi binding is a real adapter —
`readInstalledKimi()`, a hook-contract shim (or a permission-rules generator), an agent/skill
install path, and a model-tier resolver that emits one model per launch. Nothing here blocks
0.5.0; it is a post-refactor harness leg, and it is genuinely *closer* to Claude Code than Codex
was, so the adapter is smaller than the Codex one — gated on the model-policy refactor, not on it.

---

## 11. Proposed model-tier mapping — `KIMI_MODEL_POLICY`

The adapter question: translate muster's four conceptual tiers (`src/model.js`) into concrete
Kimi `{model, effort}` the way `src/codex.js`'s `CODEX_MODEL_POLICY` does for Codex. Evidence
below is dated 2026-07-23 (Moonshot platform docs + AA/DeepSWE/vendor benchmarks).

### 11.1 The two hard constraints Kimi imposes on the mapping

1. **Reasoning effort exists on K3 only, and it is 3 rungs, not 5.** K3 takes
   `reasoning_effort ∈ {low, high, max}` (always-thinking, "Preserved Thinking"; API default
   `max`, Kimi Code default `high`). **K2.7-Code and K2.6 expose no effort field** — thinking is
   binary (K2.7-Code always-on; K2.6 on/off). So muster's per-tier *reasoning level* only bites
   on the two K3 tiers; on the workhorse and locator tiers "effort" degenerates to a
   thinking-on/off toggle. This is an asymmetry Claude Code and Codex do not have (there every
   tier carries an effort).
2. **muster's `medium`/`xhigh` efforts are not native.** Kimi Code itself collapses the alias
   ladder: `medium → high`, `xhigh → max`, `low → low`, unset `→ high`, `none → thinking-off
   (routes to K2.6)`. Any muster→Kimi emitter must pre-collapse the same way — you cannot send
   `medium` or `xhigh` to the K3 API.

### 11.2 The mapping (recommended)

Same shape as `CODEX_MODEL_POLICY`, evidence-anchored per lane:

```js
// src/kimi.js (shipped) — Kimi is an adapter target, not a second tier resolver.
// Effort is a K3-only knob (low|high|max); k2.7-code/k2.6 carry a thinking toggle
// instead, so non-K3 tiers use `thinking` ("enabled"/"disabled") not `effort`.
// The shipped policy nests these under `.tiers` and pairs them with an
// `applyEffort` the shared resolver (src/model-policy.js) calls — see the file.
const KIMI_TIERS = Object.freeze({
  scout: Object.freeze({ model: "kimi-code/kimi-for-coding", thinking: "enabled" }), // same as core — NOT highspeed
  core:  Object.freeze({ model: "kimi-code/kimi-for-coding", thinking: "enabled" }),
  prime: Object.freeze({ model: "kimi-code/k3", effort: "high" }),
  apex:  Object.freeze({ model: "kimi-code/k3", effort: "max" }),
});
```

| muster tier | Kimi model | effort / thinking | why (evidence) |
|---|---|---|---|
| **scout** (read-only locate/gather) | `kimi-code/kimi-for-coding` | thinking **on** | The same dedicated coding model as core. The managed coding plan has no cheaper model, and highspeed is the identical K2.7 model at roughly 3× plan usage, so Muster never routes the scout lane there. |
| **core** (bounded execution) | `kimi-code/kimi-for-coding` | thinking **on** (no knob) | The dedicated K2.7 Coding workhorse. No effort field; always-thinking. |
| **prime** (judgment and general high-capability work) | `kimi-code/k3` | effort **high** | Frontier K3 holds quality to long context; `high` is the managed plan's judgment default. A semantic `workhorse` override also resolves to K3/high because K3 has no medium rung. |
| **apex** (rare peak judgment) | `kimi-code/k3` | effort **max** | Same provider model as prime, with `max` reserved for the conceptual peak tier. |

### 11.3 Reasoning-level ladder — muster/Codex effort → Kimi emit

| Muster semantic effort | Kimi model it lands on | Kimi emit | native? |
|---|---|---|---|
| `workhorse` | K3 on prime; K2.7 Coding on core/scout | `reasoning_effort:"high"` on K3; always-thinking on K2.7 | K3 has no medium rung |
| `judgment` | K3 | `reasoning_effort:"high"` | yes |
| `peak` | K3 | `reasoning_effort:"max"` | yes |

Emit rule: collapse `medium→high` and `xhigh→max` before sending; never emit `medium`/`xhigh`
to K3. Pin the effort explicitly (don't rely on defaults — API says `max`, Kimi Code says
`high`).

Read the table as two distinct mappings, not one: the **judgment/peak** rows are a *semantic
effort override* resolving on K3 (the only model with an effort knob); the **mechanical/workhorse**
rows show the *tier default* for the effort-less models, where a semantic effort override is a
**no-op** (`applyEffort` returns the entry unchanged — it never dials k2.6/k2.7-code). The
"Kimi model it lands on" column is the tier's model, not something the effort chose.

### 11.4 Codex-only lanes and per-agent overrides

- **`core`** (the conceptual bounded-work tier used by `muster-surgeon`, doc recipes,
  `wsh-test-automator`, and the content quartet) resolves to Luna/xhigh on Codex
  *because* `luna`'s long-context recall is a 41.3% cliff. Kimi has **no analogous cliff** (K3
  holds 1M; K2.7-Code/K2.6 are 256K but stable), so `core` **collapses into the same model as `scout`**
  (`kimi-k2.7-code`) on Kimi — there is no separate budget model to preserve premium quota, and
  no cheaper family exists on the managed endpoint.
- **`muster-reviewer`'s override** is expressed in `catalog/agents.manifest.json` as
  `{ tier: "prime", effort: "judgment" }`. Codex resolves that neutral profile to Sol/high;
  Kimi resolves it to K3/high.
- **The neutral refactor is implemented.** `catalog/agents.manifest.json` contains only
  canonical tiers (`scout|core|prime|apex`) and optional semantic effort
  (`workhorse|judgment|peak`). `src/model-policy.js` validates the shared shape, and each
  harness adapter resolves it without provider model names leaking into the conceptual layer.

### 11.5 One harness-specific caveat that constrains dispatch

K3 was trained in preserved-thinking-history mode: switching an in-flight session from another
model **into** K3, or dropping historical thinking content, makes generation "highly unstable"
(config-files.html Limitations). Implication for a mixed-tier muster run (k2.7-code workhorse +
k3 judgment): every K3 dispatch must be its **own** session/subagent carrying full thinking
history — which Kimi's context-isolated subagents already give (§6) — and muster must never
*resume* a k2.7-code session into k3. Fresh K3 subagent per judgment call, never a mid-session
model swap.

### 11.6 Install-grounded reconciliation (2026-07-23, verified against a real gen2 install)

§11.1–11.5 above were derived from the model-lineup research (§2). Probing an actual logged-in
gen2 install (`~/.kimi-code/config.toml`, managed OAuth plan) corrected three things, now baked
into `src/kimi.js`:

1. **Model ids are Kimi Code ALIASES, not raw API ids.** The policy emits `kimi-code/k3`,
   `kimi-code/kimi-for-coding`, `kimi-code/kimi-for-coding-highspeed` — the `[models.<alias>]`
   names a live `kimi -m <alias>` / `default_model` resolves — not `kimi-k3`/`kimi-k2.7-code`.
2. **The managed coding plan has no k2.6 and no non-thinking model.** It serves exactly three
   models, all **always-thinking**. `k2.6`/`k2.5` are Open-Platform *general* models on a
   different endpoint (`api.moonshot.ai`), not offered on the managed *coding* endpoint
   (`api.kimi.com/coding/v1`). So the research's "scout → k2.6, thinking-off cheap locator" lane
   **does not exist here**: scout instead rides `kimi-for-coding` — the same dedicated coding model
   as core. (The initial reconciliation pointed scout at `kimi-for-coding-highspeed`; corrected
   2026-07-24 — highspeed is the *identical* K2.7 model that burns ~3× the plan usage for latency,
   so muster never routes the "cheap" read-only lane there.) There is no cost-differentiated cheap
   lane on this plan at all.
3. **K3's effort ladder + default confirmed** exactly: `support_efforts=["low","high","max"]`,
   `default_effort="high"`.

### 11.7 Live `/v1/models` probe + install leg (2026-07-24, Phase E — done)

The deferred probe ran. Against a fresh `kimi login`, `GET https://api.kimi.com/coding/v1/models`
returned **HTTP 200** with exactly four served models — `kimi-for-coding`,
`kimi-for-coding-highspeed`, `k3`, `k3-256k` — every one `supports_thinking_type: "only"`
(always-thinking), and `k3`'s `think_efforts` live-confirmed `{valid_efforts:[low,high,max],
default:high}`. **No k2.6, no k2.5, no non-thinking/general model.** So the "remap scout to a
cheaper alias if the plan serves one" branch resolves to a no-op: there is nothing cheaper on this
plan, and scout rides `kimi-for-coding` — the same model as core. **`kimi-for-coding-highspeed`
is served but never routed to**: it is the identical K2.7 model at ~3× plan usage (a latency
convenience, not a cheaper/better lane), so it stays in the served-set the probe confirms but out of
`KIMI_TIERS`. (One new datum: `k3-256k`, a 256k-context K3 variant with the same effort ladder —
not wanted; prime/apex want full-1M `k3`.)

That probe is now reusable, tested code (`probeKimiModels` in `src/kimi-install.js`, injectable
fetch): `muster install kimi --probe` re-runs it and would flag a cheaper candidate (any served id
that is neither `kimi-for-coding*` nor `k3*`) if the plan ever gains one. The default install stays
hermetic — no network, no token dependency.

**`muster install kimi` / `uninstall kimi`** (`src/kimi-install.js`) copy muster's 27 agents
(`agents/*.md`, verbatim — the `model:` field is inert; Kimi has no per-subagent model) and 11
builtin skills (`skills/<name>/**`, whole tree incl. assets like `review-gate/verdict.schema.json`)
into `$KIMI_CODE_HOME`/`~/.kimi-code`. Hooks-free (unlike the Codex install fortress — Kimi has no
shared trust cache to reconcile). A `.muster-managed.json` manifest scopes uninstall to muster's
own files (a user's co-located agents/skills are never touched); every path is containment-checked
inside the root and a symlinked `agents/`/`skills/` dest is refused. Reinstall is idempotent and
prunes files a prior manifest no longer ships. Verified live: 40 files written to a real
`~/.kimi-code`, read back through `readInstalledKimi` (27 agents + 11 skills), and
`capabilities --kimi` resolves the installed root to `kimi-code/k3`/high.

### 11.8 The two-lane bind — `model_preference` (2026-07-25)

§6's corrected constraint turns the tier map from "resolution only" into a real **dispatch bind**.
Kimi honours `model_preference: primary | secondary` per agent, so muster's four conceptual tiers
fold onto two lanes along the family line `KIMI_TIERS` already draws:

| lane | config.toml | muster tiers | why |
|---|---|---|---|
| **primary** | `default_model = "kimi-code/k3"` | prime, apex | the K3 judgment family |
| **secondary** | `[secondary_model] model = "kimi-code/kimi-for-coding"` | scout, core | the K2.7 Coding execution family |

`apex` collapses into `prime`'s lane — effort is per-launch, not per-agent — which is the **same**
degradation Codex already accepts (both `sol/high`), so nothing new is lost.

Two deliberate design calls:

- **Which lane is primary.** K3 primary / K2.7 secondary means an un-annotated agent fails
  *cheap*. Inverting it (K2.7 primary) would give better orchestrator quota but make an
  un-annotated third-party agent default to frontier K3. Fail-cheap wins.
- **muster does not write the MODEL half of `config.toml`.** It is a shared, user-owned file, and the
  hook-bombardment diagnosis is the standing lesson on muster mutating shared harness config. The
  install *reports* the required delta (`modelPreference.requiredConfig`) and leaves the edit to the
  user. Declining it is safe: with no secondary model configured, every agent inherits the caller's
  model and the stamps are inert. The **preferred** route is the per-process env pair
  `KIMI_CODE_EXPERIMENTAL_FLAG=1` + `KIMI_SECONDARY_MODEL=kimi-code/kimi-for-coding`, which binds
  the lanes for a muster-launched `kimi -p` while mutating nothing and leaving the user's
  interactive sessions untouched. (`KIMI_SECONDARY_EFFORT` sets the lane's effort.) The ONE
  exception to "no config writes" (since 2026-07-26): `muster install kimi` merges a
  marker-delimited `[[permission.rules]]` deny block (the action-class fence, §4.2) into
  `config.toml` — a pure add/remove of muster's own block, never an edit of the user's settings.

The gate is not optional: `model_preference` "applies only to newly spawned subagents when the
secondary-model experiment is enabled", and **"The TUI currently ignores this field."** Lanes bind
under `kimi -p` / `kimi web`, never in the interactive TUI. An explicit `model: "primary"|"secondary"`
on the `Agent`/`AgentSwarm` *call* overrides the profile — so muster can also tier per dispatch, not
just per profile (it is "ignored when resuming"; resumed subagents keep their model).

**IMPLEMENTED 2026-07-27 — the env bind is live, closing the omission §6 flags as "not neutral."**
Until now the stamped lanes were inert on a real run: nothing in the live path set the env pair, so
with a secondary model configured every agent — judgment included — would have ridden the cheap
lane. The bind is now wired end to end: `kimiLaneBinding()` / `kimiLaneEnv()` (`src/kimi.js`) derive
the pair from `KIMI_TIERS` → `KIMI_LANES` as the single source (the lane models are whatever the
prime/core tiers resolve to, checked against `KIMI_LANES` so a hand edit that drifts the two
apart fails loud); `kimiGoalInvocation` (`src/kimi-dispatch.js`) sets it on every muster-launched
`kimi -p "/goal …"` run — the go.md step-6 run loop — so the 27 stamped lanes engage on a real run;
lane-sensitive dispatches carry the per-call `model` override (`kimiAgentCall` derives the lane from
the shared manifest, so a dispatch never contradicts the stamped file); and `muster doctor` reports
the active binding (`kimi-lane-binding`). A config-side bind was rejected on the evidence: the
experiment flag is process-env only (the config schema's `[providers.<name>].env{}` is provider
credentials, not a flag surface), so the only config route is the `default_model`/`[secondary_model]`
edit the design call above already declines — per-process is the complete bind that mutates nothing.

`muster install kimi` stamps every agent's lane from its manifest tier (`kimiPreferenceForAgentId`
→ `stampModelPreference`, a line-scoped frontmatter edit that leaves every other byte untouched).
Verified on the live install: **18 primary / 9 secondary / 0 unstamped.** An agent with no manifest
entry is copied through *unstamped and surfaced* in the result rather than given a lane muster
cannot justify.

### 11.9 Native dispatch — AgentSwarm + `/goal` (2026-07-25)

Where Codex offers only per-agent spawn (muster supplies fan-out, barrier, aggregation), Kimi ships
**both halves natively**, so `src/kimi-dispatch.js` keeps the judgment and hands over the mechanics:

| muster hand-rolls | Kimi native |
|---|---|
| wave fan-out + barrier + result aggregation | **`AgentSwarm`** — one call, ≤128 subagents, waits for all, returns an aggregated report |
| run-until-done loop + escalation signal | **`/goal`** — auto-continuing turns, and `kimi -p` exits **0 complete / 3 blocked / 6 paused** |

**Constants are read from the shipped binary, not the prose.** `~/.kimi-code/bin/kimi` (v0.29.0; the constants below re-verified on v0.30.0, 2026-07-29) is
unstripped, so its own tool schema is readable — which matters, because the published docs say the
`prompt_template` placeholder exists *without ever naming it*, and omit one rule entirely:

- `PROMPT_TEMPLATE_PLACEHOLDER = "{{item}}"` — "The placeholder is exactly `{{item}}`."
- `GOAL_EXIT_CODES = { complete: 0, blocked: 3, paused: 6 }`; `MAX_GOAL_OBJECTIVE_LENGTH = 4000`
- Four rules "rejected before any subagent starts": ≥2 items unless `resume_agent_ids`; template
  required when items present; template must contain `{{item}}`; and — **undocumented** — *"the
  filled-in prompts must be distinct (two items that expand to the same prompt are rejected)"*.

That last one is the one muster would actually trip (two crew members handed the same file), and it
kills the *whole* swarm, so `kimiSwarmCall` validates all four up front rather than paying a wave's
round trip to learn them.

**Wave shape is a real choice, not a preference.** Kimi's own guidance: AgentSwarm is for "the same
kind of task over different inputs"; "For a few differently-shaped tasks, make separate `Agent` calls
in one message instead." A muster wave is usually the second shape — N distinct roles
(builder + test-author + reviewer) — so `resolveKimiWaveDispatch` defaults to **agent-calls** and
selects **swarm** only for a genuinely uniform fan-out (audit N files), which is also the only shape
that satisfies the distinct-prompts rule cleanly.

**`/goal` carries the acceptance criteria.** "`/goal` does not have a separate stop-limit flag. Write
stop conditions into the objective", and goals "work best when the objective names the finish line
and the evidence that proves it" — so muster's assessed acceptance criteria compile straight *into*
the objective string, spent on the harness's own loop instead of a file muster re-reads each turn. A
non-goal exit code is treated as a **fault**, never a clean stop.

**Status: Kimi harness leg complete (Phases A–E).** `src/kimi.js` (`KIMI_MODEL_POLICY`), the
harness-neutral `{tier, effort?}` shape (`src/model-policy.js`) + the Codex adapter's migration onto
it, `readInstalledKimi()`, the `capabilities --kimi` lane + `kimiProfileForAgentId`, the shared
`catalog/agents.manifest.json` path (`src/agent-manifest.js`), and `muster install/uninstall kimi`
are all shipped. Nothing here touches 0.5.0.

### 11.10 Loop/background tuning for long unattended `/goal` runs — binary-probed defaults (2026-07-27; all five defaults and the step-cap failure mode re-probed on 0.30.0, 2026-07-29)

The §3 schema (lines 129–130) names the `[loop_control]` and `[background]` knobs but documents
**no default and almost no semantics** for any of them. Probed against the installed v0.29.1 binary
(`~/.kimi-code/bin/kimi`, unstripped — same evidence style as §11.9 and the §8 usage probe), with
all five defaults **re-probed on v0.30.0 (2026-07-29) — unchanged** (per-value evidence below the
list) and the `max_steps_per_turn` failure mode re-probed live on the 0.30.0 CLI (2026-07-29, below):

- **`loop_control.max_steps_per_turn`** — unset or `0` means **no cap** (the step-budget check
  returns true whenever the cap is undefined or ≤0). Per-process env override:
  `KIMI_LOOP_MAX_STEPS_PER_TURN`. **Failure mode, re-probed on 0.30.0 (2026-07-29):** a tripped
  cap **no longer aborts the goal**. Live probe (`KIMI_LOOP_MAX_STEPS_PER_TURN=2 kimi -p "/goal …"
  -m kimi-code/k3 --output-format stream-json`, ambient config carrying no `[loop_control]` keys,
  objective forcing 3 separate Bash steps): the capped turn ends with a WARN (`turn hit max steps
  turnId=0 steps=2 limit=2`), the goal rolls into a **fresh turn** (wire: `goal.update
  turnsUsed:2`, then `step.begin turnId=1 step=1` — the 0.29.2 "goal pursuit pausing" fix), the
  `-p` print driver then cancels that continuation turn (`turn.cancel`), the goal is persisted
  **`paused`** (`goal.update status:"paused", reason:"Paused after interruption"`), and the process
  exits **1** (not 6) with stderr `error: failed to run prompt: loop.max_steps_exceeded: Turn
  exceeded maxSteps=2. …`. The pause is genuinely resumable: `kimi -p "continue" -S <session>`
  ran the remaining step and completed the goal, exit 0. Operational consequence for muster: a
  capped `-p` run surfaces to `interpretKimiGoalExit` as exit 1 (harness FAULT), not the 6-paused
  code, even though the persisted goal state is paused/resumable — recovery is a resume
  (`kimi -p "continue" -S <session>` as probed; `kimi -r` is the hidden shortcut, sec 8), not a
  restart, but an unattended wave still stops. (The 0.29.2 "goal pursuit pausing" attribution
  cites the official changelog, kimi.com/code/docs/en/kimi-code-cli/release-notes/changelog.html;
  in-repo probes cover v0.29.1 and v0.30.0, not 0.29.2 itself.) *Historical (v0.29.1 binary probe,
  2026-07-27): a tripped cap aborted the turn with `LOOP_MAX_STEPS_EXCEEDED`; that error string no
  longer exists in 0.30.0 — the turn-level error is now `loop.max_steps_exceeded`.*
- **`loop_control.max_retries_per_step`** — built-in default **10** when unset (the step's tenacity
  wrapper falls back with `?? 10`); backoff on connection/status/timeout per §1 (line 55). Env:
  `KIMI_LOOP_MAX_RETRIES_PER_STEP`.
- **`loop_control.reserved_context_size`** — built-in default **50000** when unset
  (`DEFAULT_COMPACTION_CONFIG.reservedContextSize = 5e4`, alongside `triggerRatio 0.85`). This is
  the `reserved` in §1's compaction trigger (lines 62–63): `context_tokens + reserved >=
  max_context_size`, or `>= max_context_size * 0.85`, whichever fires first. No env override.
- **`background.max_running_tasks`** — unset means **no cap**; a configured cap is an admission
  gate that **throws** `"Too many background tasks are already running."` (a hard dispatch error,
  not a queue). Env: `KIMI_CODE_BACKGROUND_MAX_RUNNING_TASKS`.
- **`background.print_background_mode`** (`steer | drain | exit`, §3 line 130) — the `kimi -p`
  end-of-turn policy for pending background tasks. **`steer` is the default when nothing is set**:
  the driver stays alive (`'continue'`) while background tasks are pending so each completion
  `turn.steer`s a new main turn, finishing once quiescent. `drain` waits for tasks but suppresses
  steering (completions cannot start new main turns); `exit` finishes immediately, orphaning legs.
  **Legacy hazard:** a `background.keep_alive_on_exit = true` left in config.toml silently maps the
  effective mode to `drain` when `print_background_mode` itself is unset. No direct env override
  (only `KIMI_CODE_BACKGROUND_KEEP_ALIVE_ON_EXIT` for the legacy boolean).

**0.30.0 re-probe evidence (2026-07-29, binary strings on the installed v0.30.0 binary):** all five
defaults unchanged — `hasStepBudgetRemaining(maxSteps, currentStep)` still returns true whenever
`maxSteps` is `undefined` or ≤0 (unset/0 = no cap); the retry wrapper still falls back
`Math.max(config?.maxRetriesPerStep ?? 10, 1)`; `DEFAULT_COMPACTION_CONFIG.reservedContextSize` is
still `5e4` alongside `triggerRatio: 0.85`; the background admission gate still returns early when
`maxRunningTasks` is `undefined` and still throws `"Too many background tasks are already running."`
on a configured cap; and `resolvePrintBackgroundMode` still returns the configured mode, else
`keepAliveOnExit === true ? "drain" : "steer"`.

**Chosen values for muster's unattended `kimi -p "/goal …"` runs — all left at the binary
defaults, pinned in runner prose (`plugin/commands/go.md` step 6), NOT emitted into config.toml:**
`max_steps_per_turn` unset (no cap — a cap is a second stop rule the objective already covers,
§11.9; since 0.29.2 a tripped cap pauses the goal resumably instead of aborting it, but in `-p`
mode the run still exits 1 as a harness fault rather than auto-continuing — re-probed on 0.30.0,
2026-07-29, above — so unattended runs still leave it unset; and the uncapped-steps concern is
bounded by the binary's own backstops — `handlePrintMainTurnCompleted` finishes a `-p` print run
once quiescent or when `print_wait_ceiling_s`/`print_max_turns` is reached, binary-probed v0.29.1, re-verified on v0.30.0 2026-07-29);
`max_retries_per_step` unset (10 — generous transient-failure absorption on the shared 5-hour rate
window, §0 lines 42–45; raising it further burns shared quota on persistent failures instead of
failing the step so the run can re-plan); `reserved_context_size` unset (50000 — on K3's 1M window,
§2 line 76, the 0.85 ratio fires first at 850k and the 50k reserve is the post-compaction headroom;
shrinking it risks overflow mid-response, growing it discards usable context);
`max_running_tasks` unset (no cap — muster backgrounds only non-barrier-gated read-only legs, a
handful per wave, and AgentSwarm already ramps admission, §6 line 254; a cap converts directly into
dispatch errors the orchestrator must retry); `print_background_mode` `steer` (the default — the
only mode under which a background completion arrives mid-run as a synthetic user message, which
`interpretKimiBackgroundCompletion` in `src/kimi-dispatch.js` is built on; operators must ensure no
legacy `keep_alive_on_exit = true` downgrades it to `drain`).

**Why docs-pin, not emission.** All five chosen values *are* the binary defaults (the four-of-five
count in earlier drafts owed solely to the legacy `keep_alive_on_exit` conditional above, which can
map an unset `print_background_mode` to `drain` — the chosen value itself was never non-default) —
emitting them would write no-op overrides into the user's config that go stale the day Kimi changes a
default, with zero behavioral benefit. And config.toml is user-global only (§3 line 107; "There is
no project-level `config.toml` override", line 110), so a muster-specific run profile written there
leaks into every non-muster interactive session — the exact shared-config-mutation posture
`src/kimi-install.js` declines for the model half, and every knob except `print_background_mode`
has a per-process env override for the one run that wants a non-default. The `[[permission.rules]]`
fence is different in kind: it adds a declarative deny that does not exist by default (a safety
requirement), not a restatement of tuning defaults.

### 11.11 Steer during goal pursuit — live `kimi web` probe (2026-07-29, 0.30.0)

The 0.29.2 changelog entry *"fix messages sent during goal pursuit being rejected"* (same source as
the §11.10 attribution) was verified live on the installed 0.30.0 CLI. Probe setup:
`kimi web --no-open --port 58731` (bearer token from startup output; the server serves its OpenAPI
at `/openapi.json` and mounts the API under `/api/v1`), a session created via
`POST /api/v1/sessions`, a `/goal …` objective submitted via
`POST /api/v1/sessions/{id}/prompts` (HTTP 200, `"status":"running"`), then — mid-pursuit, session
`busy:true` — the two-request steer delivery `src/kimi-steer.js` constructs:

- **Submit** `POST /api/v1/sessions/{id}/prompts` `{"content":[{"type":"text","text":"STEER: skip
  step-c entirely; after step-b go straight to step-d, then report done."}]}` → **HTTP 200**,
  `{"code":0,"data":{"prompt_id":"msg_01KYQJA2XTW806EF7QJXY4HJ2Z","status":"queued",…}}` — the
  message is **accepted and queued, not rejected** (the 0.29.2 fix, confirmed).
- **Steer** `POST /api/v1/sessions/{id}/prompts:steer` `{"prompt_ids":["msg_01KYQJA2XTW806EF7QJXY4HJ2Z"]}`
  → **HTTP 200**, `{"code":0,"data":{"steered":true,"prompt_ids":["msg_01KYQJA2XTW806EF7QJXY4HJ2Z"]}}`.
- **Incorporation:** the goal transcript shows the steer user message injected between steps; the
  run executed `echo step-a`, `echo step-b`, `echo step-d` (step-c skipped) and completed
  (`UpdateGoal status:complete`), the final assistant text reading *"Ran the commands sequentially
  as directed by your steer: echo step-a → echo step-b → echo step-d (step-c skipped)."* Verdict:
  **accepted-and-steered** — a live `/goal` run is steerable over `kimi web`'s HTTP API on 0.30.0.

Two route-shape corrections fall out of the live probe, both now pinned in `src/kimi-steer.js` and
the orchestrator skill prose: the steer route is **`prompts:steer` (single colon)** — the
double-colon form the v0.29.x binary strings suggested is rejected by the live server
(`{"code":40001,"msg":"unsupported action: prompts::steer"}`) — and the API is mounted under
**`/api/v1`** (the module's constants stay mount-relative route templates). Probe-environment
notes, not muster-relevant: an API-created session ignored `agent_config.permission_mode:"yolo"`
(the goal's `CreateGoal` call sat pending until approved via
`POST /api/v1/sessions/{id}/approvals/{approval_id}`), and turns failed silently
(`last_turn_reason:"failed"`) until a model was set via `POST …/profile`. Nothing here changes
muster's run loop: `kimi -p` still holds no live session handle, so `kimiSteerDelivery` remains a
constructor for the driver that does.

### 11.12 Quota/balance fail-fast — 0.30.0 changelog classification (2026-07-29, binary-strings evidence)

The 0.30.0 changelog (same source as the §11.10 attribution): *"Fail fast when account quota or
balance is exhausted instead of silently retrying for ~3 minutes."* Unattended batches no longer pay
dead-retry time — but the failure signature changed, so muster's run interpretation needed a
billing-vs-model distinction. The account quota cannot be exhausted on demand to probe the live
stream shape, so the evidence is the installed 0.30.0 binary itself
(`strings ~/.kimi-code/bin/kimi`, unstripped — same evidence style as §11.9/§11.10):

- **The binary's own quota classifier** (`packages/kosong/src/providers/kimi-errors.ts`,
  `classifyKimiQuotaError`, passed to `convertOpenAIError` as the vendor hook) maps a **429** whose
  body carries a structured code in `KIMI_QUOTA_EXHAUSTED_ERROR_CODES =
  {"exceeded_current_quota_error"}` or whose lowercased message matches one of five verbatim
  patterns — `/exceeded your current (?:token )?quota/`, `/check your account balance/`,
  `/insufficient balance/`, `/recharge your account|please recharge/`, `/account (?:is )?in arrears/`
  — onto a distinct error class, **`APIProviderQuotaExhaustedError`** (a second copy of the chain
  additionally recognizes the OpenAI-style code `insufficient_quota`).
- **Retryable: false, by construction.** Both retry-policy sites read
  `if (error instanceof APIProviderQuotaExhaustedError) return false;`, and the wire serializer
  (`agent-core/src/errors/serialize.ts`) maps the class to `code: "api_error"` (NOT `rate_limit`)
  with `retryable: false` — the in-binary comment: *"the rate_limit code would re-mint a rate-limit
  error across the wire boundary and drive the swarm requeue/suspend loop, which cannot help until
  the account is recharged."* The payload keeps `name: "APIProviderQuotaExhaustedError"`, and the
  stream-json event schema has an `error` event (`kimiErrorPayloadObjectSchema.extend({type:
  "error"})`), so the class name and the provider wording are both matchable on a `-p
  --output-format stream-json` stdout.

**What muster does with it.** `detectKimiQuotaFault(text)` (`src/kimi-dispatch.js`) matches exactly
this evidence — the error class name, the two structured codes, the five wording patterns — and
nothing more. `interpretKimiGoalExit(code, output)` reclassifies any non-complete exit carrying the
signature as `kind: "billing"`, `escalate: true`, `resumable: false` (a BILLING escalation: recharge
first, THEN resume; never an unattended retry); `eval/kimi-reviewer-tier-probe.mjs`'s
`cellNeedsRetry` refuses to spend its single retry on a quota fault. An ordinary 429 rate-limit
stays on the retryable path in both. What is deliberately NOT implemented: any parser for the exact
stream shape of a live quota fault (unobservable without exhausting the account) — the classifier
matches on the binary's own classification inputs, which is the honest subset.

## Sources

Moonshot docs: `www.kimi.com/code/docs/en/kimi-code-cli/{customization/{hooks,agents,skills,
plugins,mcp},guides/{interaction,sessions,ides},reference/{kimi-command,slash-commands,kimi-acp},
configuration/{config-files,data-locations,env-vars,providers,overrides}}`;
`moonshotai.github.io/kimi-code/en/guides/getting-started`; `www.kimi-cli.com/en/*` (gen1);
`kimi.com/code`, `/help/membership/membership-pricing`, `/code/docs/en/kimi-code/membership.html`.
Platform/pricing: `platform.kimi.ai/docs/{guide/claude-code-kimi,pricing/chat}`;
`benchlm.ai/moonshot/api-pricing`. Internals: `deepwiki.com/MoonshotAI/kimi-cli` (Overview, 3.2,
3.5, 6.7–6.9, 9.2, 9.3, 11.x); `pypi.org/project/kimi-cli`; `github.com/earendil-works/pi`;
`github.com/MoonshotAI/Kimi-K2/issues/129`. Gathered 2026-07-23.

**Flagged assumptions:** gen2-on-`pi` is inferred from the TS/npm/Node/TUI stack, not a
Moonshot-authored page; gen2 repo public status unconfirmed; subagent-handoff size cap and
project-scoped permission-rule persistence undocumented; per-membership-tier model unlock
unpublished; gen1↔gen2 subagent-nesting contradiction unreconciled by the docs.
