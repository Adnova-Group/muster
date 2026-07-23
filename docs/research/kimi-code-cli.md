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
1. **No per-subagent model (gen2).** The `Agent` tool has no `model` param and the agent-file
   `model` is ignored; gen1 had `Agent(model=…)` and dropped it. Model is set once per launch
   (`kimi -m <alias>`, `default_model`, or the `KIMI_MODEL_*` env family). muster's tier→role map
   therefore collapses to **one model per Kimi launch**, not per role within a run. To get
   per-tier models you would run separate top-level Kimi invocations per tier, or drive via ACP
   `session/set_model` (marked unstable).
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
  haiku:  Object.freeze({ model: "kimi-k2.6",      thinking: "disabled" }),
  sonnet: Object.freeze({ model: "kimi-k2.7-code", thinking: "enabled"  }),
  opus:   Object.freeze({ model: "kimi-k3",        effort: "high"       }),
  fable:  Object.freeze({ model: "kimi-k3",        effort: "max"        }),
});
```

| muster tier | Kimi model | effort / thinking | why (evidence) |
|---|---|---|---|
| **haiku** (read-only locate/gather: `code-navigation`, `docs-research`, `research`) | `kimi-k2.6` | thinking **off** | Cheapest *current* model at the general-work Moonshot recommends for non-coding (K2.5 is cheaper but sunsets 2026-08-31 — don't build on it). Mechanical lookups need no reasoning; thinking-off is the cost/latency floor and, like Codex's `terra` locator, deliberately a **different model family** than the coding builders. 256K is ample for lookups. Open-weight (self-hostable) if a cheap lane is ever wanted. |
| **sonnet** (workhorse: implement, review, author, score) | `kimi-k2.7-code` | thinking **on** (no knob) | The **dedicated coding model**, beats K2.6 on every published coding+agentic benchmark (+11% to +31.5%), at 1/3 K3's price and ~2× the speed (`-highspeed` ~180 tok/s). This is Kimi's "measured workhorse point," the analogue of Codex `sol/medium`. No effort field — always-thinking. |
| **opus** (judgment that gates other work; explicit pins: `muster-builder`, `muster-runner`; fable's fallback) | `kimi-k3` | effort **high** | Frontier tier (AA Index 57.1, #4, *ahead of Opus 4.8*; Terminal-Bench 88.3; FrontierSWE 81.2) and the only Kimi model that holds quality to 1M context (BrowseComp 90.4 @1M) — required for judgment over large diffs/codebases. `high` = Kimi Code's own default judgment effort; mirrors Codex `sol/high`. |
| **fable** (peak: `judge`, `architecture-review`, `improve`, `advisor`) | `kimi-k3` | effort **max** | Same model as opus, but `max` is **reserved here only** — the exact discipline Codex applies to `xhigh` ("above high the marginal quality per credit collapses"). Because K3 exposes the effort knob, muster gets a *cleaner* opus/fable split than on Codex (where both are `sol/high`): opus=high, fable=max. |

### 11.3 Reasoning-level ladder — muster/Codex effort → Kimi emit

| muster intent (Codex effort) | Kimi model it lands on | Kimi emit | native? |
|---|---|---|---|
| mechanical (`none`/off) | k2.6 | `thinking:"disabled"` | yes (toggle) |
| workhorse (`medium`) | k2.7-code | `thinking:"enabled"` (no effort field) | n/a — no knob |
| judgment (`high`) | k3 | `reasoning_effort:"high"` | yes |
| peak (`xhigh`/`max`) | k3 | `reasoning_effort:"max"` | `xhigh`→`max` alias |

Emit rule: collapse `medium→high` and `xhigh→max` before sending; never emit `medium`/`xhigh`
to K3. Pin the effort explicitly (don't rely on defaults — API says `max`, Kimi Code says
`high`).

Read the table as two distinct mappings, not one: the **judgment/peak** rows are a *semantic
effort override* resolving on K3 (the only model with an effort knob); the **mechanical/workhorse**
rows show the *tier default* for the effort-less models, where a semantic effort override is a
**no-op** (`applyEffort` returns the entry unchanged — it never dials k2.6/k2.7-code). The
"Kimi model it lands on" column is the tier's model, not something the effort chose.

### 11.4 Codex-only lanes and per-agent overrides

- **`luna-xhigh`** (Codex's budget lane for bounded, low-context, downstream-verified work —
  `muster-surgeon`, doc recipes, `wsh-test-automator`, the content quartet) exists on Codex
  *because* `luna`'s long-context recall is a 41.3% cliff. Kimi has **no analogous cliff** (K3
  holds 1M; K2.7-Code/K2.6 are 256K but stable), so `luna-xhigh` **collapses into `sonnet`**
  (`kimi-k2.7-code`) on Kimi — there is no separate budget model to preserve premium quota, and
  the family-diversity argument is already served by k2.6 on the haiku lane. (If quota pressure
  ever wants a cheaper bounded lane, `kimi-k2.6/thinking-on` is the natural `luna-xhigh` analogue.)
- **`muster-reviewer`'s override** (Codex bumps it `sonnet → sol/high` — a stronger model, a
  different family than the builders it checks, per METR reward-hack diversity) maps on Kimi to
  `kimi-k3/high` (stronger + different family than the k2.7-code builder) or, cheaper,
  `kimi-k2.6/thinking-on` (different family, same-ish strength). Recommend `kimi-k3/high` when
  verdicts gate merges.
- **The refactor this exposes.** `codex/agents.manifest.json`'s per-agent `model`/`reasoning`
  overrides are **hardcoded Codex strings** (`"gpt-5.6-sol"`, `"high"`). A Kimi adapter cannot
  reuse them — it needs its own override values, or (better) the overrides re-expressed
  **harness-neutrally** as a *tier bump* + *effort bump* ("reviewer runs one tier up at judgment
  effort") that each adapter resolves through its own policy. That neutral-override shape is
  exactly the model-policy refactor already parked for Codex/Hermes; Kimi is the third data point
  that the per-agent layer, not just the tier layer, has to stop naming concrete models.

### 11.5 One harness-specific caveat that constrains dispatch

K3 was trained in preserved-thinking-history mode: switching an in-flight session from another
model **into** K3, or dropping historical thinking content, makes generation "highly unstable"
(config-files.html Limitations). Implication for a mixed-tier muster run (k2.7-code workhorse +
k3 judgment): every K3 dispatch must be its **own** session/subagent carrying full thinking
history — which Kimi's context-isolated subagents already give (§6) — and muster must never
*resume* a k2.7-code session into k3. Fresh K3 subagent per judgment call, never a mid-session
model swap.

**Status: first slice built.** `src/kimi.js` (`KIMI_MODEL_POLICY` + `kimiModelForTier/Role` +
`kimiProfileForConfig`, mirroring `src/codex.js`) and the harness-neutral `{tier, effort?}` shape
(`src/model-policy.js`: `resolveNeutralProfile`) are implemented and tested (`test/kimi.test.js`).
Still parked as the **next slice**: migrating `src/codex.js`'s `CODEX_MODEL_POLICY` and
`codex/agents.manifest.json` onto the same neutral shape (dropping the hardcoded `gpt-5.6-sol`
strings), plus a Kimi agent-profile manifest, so one entry resolves on Codex, Kimi, and Claude
alike. Nothing here touches 0.5.0.

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
